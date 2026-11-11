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
import { MessageEntryType, MessageErrorType } from "./DataTypes.js";

export interface ParsedConnectionUrl
{
    scheme: string;
    host: string;
    port: number;
    path: string;
    nodeid: NodeID;
    nodename: string;
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
export interface Endpoint
{
    localEndpoint: number;
    messageReceived(m: Message): void;
    transportConnectionClosed(): void;
}

/** A connected transport stream used by one client */
export interface ITransportConnection
{
    readonly remoteNodeID: NodeID;
    /** True if the transport negotiated the ConnectClientCombined operation */
    readonly useCombinedConnection: boolean;
    sendMessage(m: Message): void;
    /** Resolves once the message has been handed to the network */
    sendMessageWait(m: Message): Promise<void>;
    close(): void;
}

/**
 * Whether a message is a request to the node itself rather than to an endpoint, as in Core. These
 * are requests below entry type 500, except ServiceClosed and ObjectTypeName sent to an endpoint.
 */
export function isSpecialRequest(m: Message): boolean
{
    const e = m.entries[0];
    if (!e || e.entryType >= 500 || e.entryType % 2 !== 1) return false;
    if (e.entryType === MessageEntryType.ServiceClosed) return false;
    if (e.entryType === MessageEntryType.ObjectTypeName && m.header.receiverEndpoint !== 0) return false;
    return true;
}

/** A transport connection accepted from a client. Several service endpoints may use it */
export interface ServerTransportConnection extends ITransportConnection
{
    /** Notify the endpoint when the connection closes */
    attachEndpoint(e: Endpoint): void;
    detachEndpoint(e: Endpoint): void;
}

/** Answers requests to the node itself, such as GetServiceDesc and ConnectClient. Set by a service host */
export type SpecialRequestHandler = (m: Message, connection: ServerTransportConnection) => Promise<Message | null>;

export interface Transport
{
    canConnectService(url: string): boolean;
    createTransportConnection(url: string, endpoint: Endpoint): Promise<ITransportConnection>;
    close(): void;
}
