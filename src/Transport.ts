// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { RobotRaconteurError } from "./Error.js";
import { Message } from "./Message.js";
import { NodeID } from "./NodeID.js";
import { MessageErrorType } from "./DataTypes.js";

/** The parts of a Robot Raconteur URL, from parseConnectionUrl */
export interface ParsedConnectionUrl
{
    /** The scheme, such as rr+ws or rr+tcp */
    scheme: string;
    /** The host name or address, with IPv6 addresses in brackets */
    host: string;
    /** The port, or the default port of the scheme if the URL has none, such as 48653 for rr+tcp or 443 for rr+wss */
    port: number;
    /** The path, such as / or /robotraconteur */
    path: string;
    /** The nodeid parameter, or NodeID.Any */
    nodeid: NodeID;
    /** The nodename parameter, or empty */
    nodename: string;
    /** The service parameter, or empty */
    service: string;
}

function urlError(): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "Invalid connection URL");
}

/** Parse a Robot Raconteur connection URL such as rr+ws://localhost:22222?service=my_service */
export function parseConnectionUrl(url: string): ParsedConnectionUrl
{
    const m = /^([^:\s]+):\/\/(?:((?:\[[A-Fa-f0-9:]+(?:%\w*)?\])|(?:[^[\]:/?\s]+))(?::([^:/?\s]+))?|\/)(?:\/([^?\s]*))?\??(\S*)$/.exec(url);
    if (!m) throw urlError();

    const scheme = m[1]!;
    const host = m[2] ?? "";
    let port = m[3] ? parseInt(m[3], 10) : -1;
    const default_ports: Record<string, number> = { "rr+tcp": 48653, "rrs+tcp": 48653, "rr+ws": 80, "rrs+ws": 80, "rr+wss": 443, "rrs+wss": 443 };
    if (port === -1 && default_ports[scheme]) port = default_ports[scheme]!;

    if (scheme === "tcp")
    {
        const parts = (m[4] ?? "").split("/").filter((x) => x.length > 0);
        if (m[5] || parts.length !== 2) throw urlError();
        const noden = parts[0]!;
        const is_id = /[{[]/.test(noden);
        return { scheme, host, port, path: "/", nodeid: is_id ? new NodeID(noden) : NodeID.Any, nodename: is_id ? "" : noden, service: parts[1]! };
    }

    const params = new Map<string, string>();
    for (const q of (m[5] ?? "").split("&"))
    {
        if (q === "") continue;
        const kv = q.split("=");
        if (kv.length !== 2 || !kv[0] || !kv[1]) throw urlError();
        params.set(kv[0], decodeURIComponent(kv[1]));
    }
    const service = params.get("service");
    if (!service || service.trim() === "") throw urlError();

    const nodename = params.get("nodename") ?? "";
    if (nodename !== "" && !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(nodename)) throw urlError();
    const nodeid = params.get("nodeid");
    return { scheme, host, port, path: m[4] ? m[4] : "/", nodeid: nodeid ? new NodeID(nodeid) : NodeID.Any, nodename, service };
}

/** One end of a client or service session, identified by a number unique within the node */
/** Something messages are routed to, such as a client. Needed only to write a transport */
export interface Endpoint
{
    /** The endpoint number the node assigned */
    localEndpoint: number;
    /** A message addressed to this endpoint arrived */
    messageReceived(m: Message): void;
    /** The transport connection the endpoint uses has closed */
    transportConnectionClosed(): void;
}

/** A connected transport stream used by one client */
/** A connection to another node made by a transport. Needed only to write a transport */
export interface ITransportConnection
{
    /** The node at the other end, once known */
    readonly remoteNodeID: NodeID;
    /** True if the transport negotiated the ConnectClientCombined operation */
    readonly useCombinedConnection: boolean;
    /** Queue a message to send. Throws if the connection has closed */
    sendMessage(m: Message): void;
    /** Resolves once the message has been handed to the network */
    sendMessageWait(m: Message): Promise<void>;
    /** Close the connection. Its endpoints are told */
    close(): void;
}

/** A way to connect to other nodes, such as BrowserWebSocketTransport. Register one with the node */
export interface Transport
{
    /** Whether the transport handles the URL's scheme */
    canConnectService(url: string): boolean;
    /** Connect to the node at a URL for an endpoint */
    createTransportConnection(url: string, endpoint: Endpoint): Promise<ITransportConnection>;
    /** Close every connection. Called when the node shuts down */
    close(): void;
}
