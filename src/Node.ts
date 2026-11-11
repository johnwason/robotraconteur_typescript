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

import { ClientContext, ServiceStub } from "./Client.js";
import type { ObjectLockFlags } from "./Client.js";
import { Message } from "./Message.js";
import { NodeID } from "./NodeID.js";
import type { DecodeOptions } from "./Pack.js";
import { parseServiceDefinition, ServiceDefinition } from "./ServiceDefinition.js";
import { Endpoint, ITransportConnection, parseConnectionUrl, Transport } from "./Transport.js";
import { errorReturnMessage } from "./MessageError.js";
import { RobotRaconteurError } from "./Error.js";
import { MessageErrorType } from "./DataTypes.js";

/** Milliseconds between starting attempts on candidate URLs, as in Core */
const CANDIDATE_URL_DELAY_MS = 15;

/**
 * A Robot Raconteur node: the transports, service definitions, and connections of one program.
 * Register a transport, then connect to services with connectService.
 */
export class RobotRaconteurNode
{
    /** Version reported to services. Matches the RobotRaconteurWeb protocol level */
    static readonly Version = "0.20.0";

    /** The ID of this node. A random one unless set, which must be done before connecting */
    nodeID = NodeID.newUniqueID();
    /** The name of this node, which services see. Empty by default */
    nodeName = "";
    /** Milliseconds to wait for the response to a request */
    requestTimeout = 15000;
    /** A transport connection is closed after this many milliseconds without messages */
    transportInactivityTimeout = 600000;
    /** A client is closed after this many milliseconds without messages from its service */
    endpointInactivityTimeout = 600000;
    /**
     * How connections decode received values, unless set on a connection with
     * ClientContext.decodeOptions. Assign a new object to change it.
     */
    decodeOptions: DecodeOptions = {};

    /** The service definitions registered with registerServiceType, by name */
    readonly serviceTypes = new Map<string, ServiceDefinition>();

    private transports: Transport[] = [];
    private endpoints = new Map<number, Endpoint>();
    private clients = new Set<ClientContext>();
    private shutdown_hooks = new Set<() => void>();

    /** Add a transport, such as BrowserWebSocketTransport, for connections to use */
    registerTransport(transport: Transport): void
    {
        this.transports.push(transport);
    }

    /** Register a service definition from its text or parsed form */
    registerServiceType(def: string | ServiceDefinition): ServiceDefinition
    {
        const d = typeof def === "string" ? parseServiceDefinition(def) : def;
        this.serviceTypes.set(d.name, d);
        return d;
    }

    /**
     * Connect to a service and return the client for the root object. Several candidate URLs for
     * one service can be passed, and the first that connects is used.
     */
    async connectService(url: string | string[], username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, objectType?: string): Promise<ServiceStub>
    {
        if (typeof url !== "string") return this.connectCandidates(url, username, credentials, objectType);

        parseConnectionUrl(url);
        const transport = this.transports.find((x) => x.canConnectService(url));
        if (!transport)
        {
            throw new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "Could not find a transport for URL: " + url);
        }
        const c = new ClientContext(this);
        this.registerClient(c);
        try
        {
            return await c.connectService(transport, url, username, credentials, objectType);
        }
        catch (e)
        {
            this.deleteEndpoint(c);
            throw e;
        }
    }

    /**
     * Choose the URL to try first from several for the same service, as Core does: in-process and
     * local transports, then TLS, then plain TCP, each preferring loopback and then link-local
     * addresses. Otherwise the first URL.
     */
    static selectRemoteNodeURL(urls: string[]): string
    {
        if (urls.length === 0) throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "No URLs to select from");
        for (const prefix of ["rr+intra://", "rr+local://", "rr+pci://", "rr+usb://"])
        {
            const u = urls.find((x) => x.startsWith(prefix));
            if (u) return u;
        }
        for (const scheme of ["rrs+tcp://", "rr+tcp://"])
        {
            for (const host of ["127.0.0.1", "[::1]", "localhost", "[fe80", ""])
            {
                const u = urls.find((x) => x.toLowerCase().startsWith(scheme + host));
                if (u) return u;
            }
        }
        return urls[0]!;
    }

    private connectCandidates(urls: string[], username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, objectType?: string): Promise<ServiceStub>
    {
        if (urls.length === 0) return Promise.reject(new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "No URLs to connect to"));
        // As in Core, the preferred URL is tried first and each of the others shortly after, and the
        // first to connect is used
        const remaining = [...urls];
        return new Promise<ServiceStub>((resolve, reject) =>
        {
            let connected = false;
            let failures = 0;
            let first_error: unknown;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const startNext = () =>
            {
                if (connected || remaining.length === 0) return;
                const url = RobotRaconteurNode.selectRemoteNodeURL(remaining);
                remaining.splice(remaining.indexOf(url), 1);
                this.connectService(url, username, credentials, objectType).then((stub) =>
                {
                    if (connected)
                    {
                        void this.disconnectService(stub).catch(() => undefined);
                        return;
                    }
                    connected = true;
                    clearTimeout(timer);
                    resolve(stub);
                }, (e) =>
                {
                    if (failures === 0) first_error = e;
                    if (++failures === urls.length) reject(first_error);
                });
                if (remaining.length > 0) timer = setTimeout(startNext, CANDIDATE_URL_DELAY_MS);
            };
            startNext();
        });
    }

    /** Disconnect from a service, given its root object or any object of the connection */
    async disconnectService(stub: ServiceStub): Promise<void>
    {
        await stub.context.close();
    }

    /**
     * Lock an object and the objects under it, as Core's RequestObjectLock. Other users, or with
     * "client" other clients of the same user, receive RobotRaconteur.ObjectLockedError until the
     * lock is released. The service must allow object locks, and the user must be logged in with
     * the objectlock privilege. The lock is released when the client disconnects.
     *
     * @param stub The object to lock
     * @param flags "user" to lock for every client of the user, or "client" for this client only
     * @returns The service's answer, "OK"
     */
    async requestObjectLock(stub: ServiceStub, flags: ObjectLockFlags = "user"): Promise<string>
    {
        return await stub.context.requestObjectLock(stub, flags);
    }

    /**
     * Release an object lock, as Core's ReleaseObjectLock. The lock must be held by the user, unless
     * the user has the objectlockoverride privilege.
     *
     * @param stub The object locked with requestObjectLock
     * @returns The service's answer, "OK"
     */
    async releaseObjectLock(stub: ServiceStub): Promise<string>
    {
        return await stub.context.releaseObjectLock(stub);
    }

    /**
     * Wait for the monitor lock of an object, as Core's MonitorEnter. A monitor lock gives one
     * client at a time the object, for short operations that must not be interleaved with other
     * clients. It does not lock the objects under it, and needs no privilege. Release it with
     * monitorExit.
     *
     * @param stub The object to lock
     * @param timeout Milliseconds to wait for the lock, or -1 to wait without limit
     */
    async monitorEnter(stub: ServiceStub, timeout = -1): Promise<void>
    {
        await stub.context.monitorEnter(stub, timeout);
    }

    /**
     * Release a monitor lock, as Core's MonitorExit
     *
     * @param stub The object locked with monitorEnter
     */
    async monitorExit(stub: ServiceStub): Promise<void>
    {
        await stub.context.monitorExit(stub);
    }

    /** Close all clients and transports */
    async shutdown(): Promise<void>
    {
        // Subscriptions first, as they would otherwise reconnect the clients closed below
        for (const h of [...this.shutdown_hooks]) h();
        await Promise.all([...this.clients].map((c) => c.close()));
        this.transports.forEach((t) => t.close());
    }

    /** Run a function when the node shuts down, before its clients are closed */
    addShutdownHook(hook: () => void): void
    {
        this.shutdown_hooks.add(hook);
    }

    /** Stop calling a function added with addShutdownHook */
    removeShutdownHook(hook: () => void): void
    {
        this.shutdown_hooks.delete(hook);
    }

    private registerClient(c: ClientContext): void
    {
        this.clients.add(c);
        this.registerEndpoint(c);
    }

    /** Assign a local endpoint number and start routing messages to the endpoint */
    registerEndpoint(c: Endpoint): void
    {
        const a = new Uint32Array(1);
        do
        {
            globalThis.crypto.getRandomValues(a);
        } while (a[0] === 0 || this.endpoints.has(a[0]!));
        c.localEndpoint = a[0]!;
        this.endpoints.set(c.localEndpoint, c);
    }

    /** Stop routing messages to an endpoint */
    deleteEndpoint(c: Endpoint): void
    {
        this.endpoints.delete(c.localEndpoint);
        this.clients.delete(c as ClientContext);
    }

    /**
     * @internal Route a message to its endpoint. If it cannot be delivered, requests in it are
     * answered with an error through the connection it arrived on, as Core does.
     */
    messageReceived(m: Message, connection?: ITransportConnection): void
    {
        if (!m.header.receiverNodeID.equals(this.nodeID))
        {
            this.replyError(m, connection, MessageErrorType.NodeNotFound, "RobotRaconteur.NodeNotFound", "Could not find route to remote node");
            return;
        }
        const e = this.endpoints.get(m.header.receiverEndpoint);
        if (!e)
        {
            this.replyError(m, connection, MessageErrorType.InvalidEndpoint, "RobotRaconteur.InvalidEndpoint", "Invalid destination endpoint");
            return;
        }
        e.messageReceived(m);
    }

    private replyError(m: Message, connection: ITransportConnection | undefined, code: MessageErrorType, name: string, message: string): void
    {
        if (!connection) return;
        const r = errorReturnMessage(m, code, name, message);
        if (r.entries.length === 0) return;
        try
        {
            connection.sendMessage(r);
        }
        catch
        {
            // The connection has closed
        }
    }
}
