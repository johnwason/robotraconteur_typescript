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

import type { ServiceStub } from "./Client.js";
import { MessageErrorType } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import type { RobotRaconteurNode } from "./Node.js";
import { NodeID } from "./NodeID.js";
import type { PipeHandle, PipePacketValue } from "./PipeMember.js";
import { parseConnectionUrl } from "./Transport.js";
import { Waiters } from "./WireMember.js";
import type { WireHandle, WireValue } from "./WireMember.js";

/** Wait before retrying a wire or pipe connection while the client remains connected */
const MEMBER_RETRY_MS = 2500;

/** Credentials to log in with, such as `{ password: new VarValue("...", "string") }` */
export type Credentials = Map<string, unknown> | Record<string, unknown>;

function connectionError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", message);
}

function callListeners<A extends unknown[]>(listeners: Set<(...args: A) => unknown>, ...args: A): void
{
    for (const l of [...listeners])
    {
        try
        {
            l(...args);
        }
        catch (e)
        {
            console.error("Error in subscription listener:", e);
        }
    }
}

/** Identifies a connected service. The NodeID is Any until the first connection to a URL */
export interface ServiceSubscriptionClientID
{
    /** The node of the service, or NodeID.Any until a connection by URL has been made */
    nodeID: NodeID;
    /** The name of the service */
    serviceName: string;
}

/** A service that a subscription should keep connected */
export interface ServiceSubscriptionClient
{
    /** The node of the service, or NodeID.Any to accept any node at the URLs */
    nodeID: NodeID;
    /** The name of the node, or empty for any */
    nodeName: string;
    /** The name of the service */
    serviceName: string;
    /** The URLs to try, in order */
    urls: string[];
    /** The username to log in with, if the service needs one */
    username?: string;
    /** The credentials to log in with, such as `{ password: new VarValue("...", "string") }` */
    credentials?: Credentials;
    /** Connect to the root object as this type, which it implements, rather than its own */
    objectType?: string;
}

/** A service a subscription has connected, from getConnectedClients */
export interface ConnectedClient extends ServiceSubscriptionClientID
{
    /** The root object of the service */
    client: ServiceStub;
}

/** Options for subscribeService and new ServiceSubscription */
export interface ServiceSubscriptionOptions
{
    /** Milliseconds between connection attempts */
    connectRetryDelay?: number;
    /** Give up on a service after this many consecutive failures. Negative retries forever */
    connectErrorLimit?: number;
}

/** Called when a subscription connects or loses a service */
export type ClientConnectionHandler = (subscription: ServiceSubscription, id: ServiceSubscriptionClientID, client: ServiceStub) => unknown;
/** Called when a subscription fails to connect to a service, with the URLs it tried and the error */
export type ClientConnectFailedHandler = (subscription: ServiceSubscription, id: ServiceSubscriptionClientID, urls: string[], error: unknown) => unknown;
/** Called with each new value a wire subscription receives, and its timestamp */
export type WireValueSubscriptionHandler = (subscription: WireSubscription, value: unknown, timestamp: WireValue["timestamp"]) => unknown;
/** Called when a pipe subscription receives packets. The handler receives them from the subscription */
export type PipePacketSubscriptionHandler = (subscription: PipeSubscription) => unknown;

interface ClientState extends ServiceSubscriptionClient
{
    client: ServiceStub | null;
    error_count: number;
    claimed: boolean;
    removed: boolean;
    wake: Waiters;
}

function resolvePath(client: ServiceStub, path: string): Promise<ServiceStub> | ServiceStub
{
    if (path === "" || path === "*") return client;
    return client.context.findObjRef(path.startsWith("*.") ? client.context.serviceName + path.slice(1) : path);
}

/**
 * Keeps one or more services connected, reconnecting whenever a connection is lost. Create one with
 * subscribeService, or from discovery using the robotraconteur-node package. A subscription keeps
 * running until closed, or until the node is shut down.
 */
export class ServiceSubscription
{
    /** Milliseconds between connection attempts */
    connectRetryDelay: number;

    private connect_error_limit: number;
    private clients = new Map<string, ClientState>();
    private closed = false;
    private connect_waiters = new Waiters();
    private connected_listeners = new Set<ClientConnectionHandler>();
    private disconnected_listeners = new Set<ClientConnectionHandler>();
    private failed_listeners = new Set<ClientConnectFailedHandler>();
    private close_listeners = new Set<() => void>();
    private wires = new Set<WireSubscription>();
    private pipes = new Set<PipeSubscription>();
    private service_url: string[] | null = null;
    private readonly shutdown_hook = () => this.close();

    /** @param node The node to connect from. The subscription closes when it shuts down */
    constructor(readonly node: RobotRaconteurNode, options: ServiceSubscriptionOptions = {})
    {
        this.connectRetryDelay = options.connectRetryDelay ?? 15000;
        this.connect_error_limit = options.connectErrorLimit ?? 25;
        node.addShutdownHook(this.shutdown_hook);
    }

    /** Used by subscribeService */
    initServiceURL(urls: string[], username?: string, credentials?: Credentials, objectType?: string): void
    {
        const target = checkServiceUrls(urls);
        this.service_url = urls;
        this.addOrUpdateClient({ ...target, urls, username, credentials, objectType });
    }

    /**
     * Start connecting to a service, or update the details of one already known. Used by sources
     * of services such as discovery.
     */
    addOrUpdateClient(c: ServiceSubscriptionClient, maxConnections = -1): void
    {
        if (this.closed) return;
        const key = `${c.nodeID.toString()}/${c.serviceName}`;
        const existing = this.clients.get(key);
        if (existing)
        {
            if (existing.client) return;
            existing.urls = c.urls;
            existing.username = c.username;
            existing.credentials = c.credentials;
            existing.objectType = c.objectType;
            return;
        }
        if (maxConnections >= 0 && this.clients.size >= maxConnections) return;

        const state: ClientState = { ...c, client: null, error_count: 0, claimed: false, removed: false, wake: new Waiters() };
        this.clients.set(key, state);
        void this.runClient(key, state);
    }

    private async runClient(key: string, c: ClientState): Promise<void>
    {
        while (!this.closed && !c.removed)
        {
            let stub: ServiceStub;
            try
            {
                stub = await this.node.connectService(c.urls, c.username, c.credentials, c.objectType);
            }
            catch (e)
            {
                if (this.closed || c.removed) return;
                callListeners(this.failed_listeners, this, this.clientId(c), c.urls, e);
                c.error_count++;
                if (this.connect_error_limit >= 0 && this.service_url === null && c.error_count > this.connect_error_limit)
                {
                    if (this.clients.get(key) === c) this.clients.delete(key);
                    return;
                }
                await c.wake.wait(this.connectRetryDelay);
                continue;
            }

            if (this.closed || c.removed)
            {
                void this.node.disconnectService(stub).catch(() => undefined);
                return;
            }

            c.client = stub;
            c.error_count = 0;
            if (c.nodeID.isAnyNode) c.nodeID = stub.context.remoteNodeID;
            if (c.nodeName === "") c.nodeName = stub.context.remoteNodeName;
            const id = this.clientId(c);

            const ended = c.wake.wait(-1);
            let disconnected = false;
            const on_close = () =>
            {
                disconnected = true;
                c.claimed = false;
                callListeners(this.disconnected_listeners, this, id, stub);
                c.wake.notifyAll();
            };
            stub.context.addCloseListener(on_close);
            if (!stub.context.connected) on_close();

            if (!disconnected)
            {
                callListeners(this.connected_listeners, this, id, stub);
                this.connect_waiters.notifyAll();
                for (const w of this.wires) w.clientConnected(stub);
                for (const p of this.pipes) p.clientConnected(stub);
            }

            await ended;

            stub.context.removeCloseListener(on_close);
            c.client = null;
            for (const w of this.wires) w.clientDisconnected(stub);
            for (const p of this.pipes) p.clientDisconnected(stub);

            if (!this.closed && !c.removed) await c.wake.wait(this.connectRetryDelay);
        }
    }

    private clientId(c: ClientState): ServiceSubscriptionClientID
    {
        return { nodeID: c.nodeID, serviceName: c.serviceName };
    }

    /** The currently connected clients */
    getConnectedClients(): ConnectedClient[]
    {
        return [...this.clients.values()].flatMap((c) => (c.client ? [{ ...this.clientId(c), client: c.client }] : []));
    }

    /** Get a connected client, or null if there are none. Do not keep the result, as it is replaced on reconnect */
    tryGetDefaultClient(): ServiceStub | null
    {
        for (const c of this.clients.values())
        {
            if (c.client) return c.client;
        }
        return null;
    }

    /** Same as tryGetDefaultClient, but throws if no client is connected */
    getDefaultClient(): ServiceStub
    {
        const c = this.tryGetDefaultClient();
        if (!c) throw connectionError("No clients connected");
        return c;
    }

    /** Wait for a client to be connected, or return null. A negative timeout waits indefinitely */
    async tryGetDefaultClientWait(timeout = -1): Promise<ServiceStub | null>
    {
        const deadline = Date.now() + timeout;
        for (;;)
        {
            const c = this.tryGetDefaultClient();
            if (c || this.closed) return c;
            const remaining = timeout < 0 ? -1 : deadline - Date.now();
            if (timeout >= 0 && remaining <= 0) return null;
            await this.connect_waiters.wait(remaining);
        }
    }

    /** Same as tryGetDefaultClientWait, but throws if no client connected in time */
    async getDefaultClientWait(timeout = -1): Promise<ServiceStub>
    {
        const c = await this.tryGetDefaultClientWait(timeout);
        if (!c) throw connectionError("No clients connected");
        return c;
    }

    /** Call a function each time a service is connected */
    addClientConnectListener(listener: ClientConnectionHandler): void
    {
        this.connected_listeners.add(listener);
    }

    /** Stop calling a function added with addClientConnectListener */
    removeClientConnectListener(listener: ClientConnectionHandler): void
    {
        this.connected_listeners.delete(listener);
    }

    /** Call a function each time a connected service is lost */
    addClientDisconnectListener(listener: ClientConnectionHandler): void
    {
        this.disconnected_listeners.add(listener);
    }

    /** Stop calling a function added with addClientDisconnectListener */
    removeClientDisconnectListener(listener: ClientConnectionHandler): void
    {
        this.disconnected_listeners.delete(listener);
    }

    /** Call a function each time a connection attempt fails */
    addClientConnectFailedListener(listener: ClientConnectFailedHandler): void
    {
        this.failed_listeners.add(listener);
    }

    /** Stop calling a function added with removeClientConnectFailedListener */
    removeClientConnectFailedListener(listener: ClientConnectFailedHandler): void
    {
        this.failed_listeners.delete(listener);
    }

    /** Run a function when the subscription is closed */
    addCloseListener(listener: () => void): void
    {
        this.close_listeners.add(listener);
    }

    /** Take ownership of a client, so that closing the subscription leaves it connected */
    claimClient(client: ServiceStub): void
    {
        this.findClient(client).claimed = true;
    }

    /** Give back a client taken with claimClient, so that the subscription manages it again */
    releaseClient(client: ServiceStub): void
    {
        this.findClient(client).claimed = false;
    }

    private findClient(client: ServiceStub): ClientState
    {
        for (const c of this.clients.values())
        {
            if (c.client === client) return c;
        }
        throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "Client is not part of this subscription");
    }

    /** The URLs of a subscription created with subscribeService */
    getServiceURL(): string[]
    {
        if (!this.service_url) throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "Subscription not using a service URL");
        return [...this.service_url];
    }

    /**
     * Change the URLs of a subscription created with subscribeService. The change applies to the
     * next connection, unless closeConnected is true.
     */
    updateServiceURL(url: string | string[], username?: string, credentials?: Credentials, objectType?: string, closeConnected = false): void
    {
        if (this.closed) return;
        if (!this.service_url) throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "Subscription not using a service URL");
        const urls = typeof url === "string" ? [url] : url;
        const target = checkServiceUrls(urls);
        this.service_url = urls;
        for (const c of this.clients.values())
        {
            Object.assign(c, { ...target, urls, username, credentials, objectType });
            if (closeConnected && !c.claimed && c.client) void this.node.disconnectService(c.client).catch(() => undefined);
            // Skip the rest of a retry delay, so that the new URLs are used promptly
            if (!c.client) c.wake.notifyAll();
        }
    }

    /** Keep a wire connected on every client. A servicePath of "*.name" is relative to the root object */
    subscribeWire(name: string, servicePath = ""): WireSubscription
    {
        const w = new WireSubscription(this, name, servicePath);
        this.wires.add(w);
        for (const c of this.getConnectedClients()) w.clientConnected(c.client);
        return w;
    }

    /** Keep a pipe connected on every client. A negative maxRecvPackets keeps all packets until read */
    subscribePipe(name: string, servicePath = "", maxRecvPackets = -1, maxSendBacklog = 5): PipeSubscription
    {
        const p = new PipeSubscription(this, name, servicePath, maxRecvPackets, maxSendBacklog);
        this.pipes.add(p);
        for (const c of this.getConnectedClients()) p.clientConnected(c.client);
        return p;
    }

    /** Access an object below the root object of the current client. "*.name" is relative to the root */
    subscribeSubObject(servicePath: string): SubObjectSubscription
    {
        return new SubObjectSubscription(this, servicePath);
    }

    /** Used by member subscriptions when they close */
    memberClosed(m: WireSubscription | PipeSubscription): void
    {
        if (m instanceof WireSubscription) this.wires.delete(m);
        else this.pipes.delete(m);
    }

    private dropClient(key: string, c: ClientState): void
    {
        c.removed = true;
        c.claimed = false;
        this.clients.delete(key);
        // Disconnecting wakes the client through its close listener, so that disconnect handlers still run
        if (c.client) void this.node.disconnectService(c.client).catch(() => c.wake.notifyAll());
        else c.wake.notifyAll();
    }

    /** The clients being connected or kept connected. Used by sources of services such as discovery */
    getClientIDs(): ServiceSubscriptionClientID[]
    {
        return [...this.clients.values()].map((c) => this.clientId(c));
    }

    /** Stop using a client, unless it has been claimed. Used by sources of services such as discovery */
    removeClient(id: ServiceSubscriptionClientID): void
    {
        const key = `${id.nodeID.toString()}/${id.serviceName}`;
        const c = this.clients.get(key);
        if (c && !c.claimed) this.dropClient(key, c);
    }

    /**
     * Disconnect all clients, including claimed ones, and forget where to connect, but stay open. Wire
     * and pipe subscriptions are kept, and resume when clients are added again.
     */
    softClose(): void
    {
        if (this.closed) return;
        this.service_url = null;
        for (const [key, c] of [...this.clients]) this.dropClient(key, c);
    }

    /** Stop reconnecting and disconnect all clients, except any that have been claimed */
    close(): void
    {
        if (this.closed) return;
        this.closed = true;
        this.node.removeShutdownHook(this.shutdown_hook);
        for (const w of [...this.wires]) w.close();
        for (const p of [...this.pipes]) p.close();
        this.connect_waiters.notifyAll();
        for (const c of this.clients.values())
        {
            if (c.client && !c.claimed) void this.node.disconnectService(c.client).catch(() => undefined);
            c.wake.notifyAll();
        }
        callListeners(this.close_listeners);
    }
}

function checkServiceUrls(urls: string[]): { nodeID: NodeID; nodeName: string; serviceName: string }
{
    if (urls.length === 0) throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "A subscription needs at least one URL");
    const first = parseConnectionUrl(urls[0]!);
    for (const url of urls.slice(1))
    {
        const u = parseConnectionUrl(url);
        if (!u.nodeid.equals(first.nodeid) || u.nodename !== first.nodename || u.service !== first.service)
        {
            throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", "URLs do not point to the same service");
        }
    }
    return { nodeID: first.nodeid, nodeName: first.nodename, serviceName: first.service };
}

/** Connect to a service and keep it connected. Several candidate URLs for one service can be passed */
export function subscribeService(node: RobotRaconteurNode, url: string | string[], username?: string, credentials?: Credentials, objectType?: string): ServiceSubscription
{
    const s = new ServiceSubscription(node, { connectRetryDelay: 2500, connectErrorLimit: -1 });
    s.initServiceURL(typeof url === "string" ? [url] : url, username, credentials, objectType);
    return s;
}

interface MemberConnection
{
    client: ServiceStub;
    active: boolean;
    wake: Waiters;
}

/** Keeps a member connected on each client, retrying while the client remains connected */
abstract class MemberSubscription<C extends MemberConnection>
{
    protected closed = false;
    protected connections = new Map<ServiceStub, C>();

    /** @param memberName The wire or pipe member */
    constructor(protected parent: ServiceSubscription, readonly memberName: string, protected servicePath: string) {}

    protected abstract newConnection(client: ServiceStub): C;
    /** Connect the member and return once it has closed */
    protected abstract runMember(object: ServiceStub, c: C): Promise<void>;

    /** @internal Called by the subscription when a service is connected */
    clientConnected(client: ServiceStub): void
    {
        void this.runConnection(client);
    }

    /** @internal Called by the subscription when a service is lost */
    clientDisconnected(client: ServiceStub): void
    {
        const c = this.connections.get(client);
        if (!c) return;
        c.active = false;
        c.wake.notifyAll();
    }

    private async runConnection(client: ServiceStub): Promise<void>
    {
        if (this.connections.has(client)) return;
        const c = this.newConnection(client);
        this.connections.set(client, c);
        while (c.active && !this.closed)
        {
            try
            {
                const object = await resolvePath(client, this.servicePath);
                if (!c.active || this.closed) break;
                await this.runMember(object, c);
            }
            catch
            {
                // Retried below. The member may not exist yet, or the object may have been released
            }
            if (c.active && !this.closed) await c.wake.wait(MEMBER_RETRY_MS);
        }
        this.connections.delete(client);
    }

    /** Stop keeping the member connected */
    close(): void
    {
        if (this.closed) return;
        this.closed = true;
        for (const c of this.connections.values())
        {
            c.active = false;
            c.wake.notifyAll();
        }
        this.parent.memberClosed(this as unknown as WireSubscription | PipeSubscription);
    }
}

interface WireConnection extends MemberConnection
{
    object: ServiceStub | null;
    handle: WireHandle | null;
}

/** The most recent value received from a wire on any connected client */
export class WireSubscription extends MemberSubscription<WireConnection>
{
    /** Milliseconds until a received value is no longer valid. Negative for no limit */
    inValueLifespan = -1;

    private in_value: WireValue | null = null;
    private in_value_received = 0;
    private in_waiters = new Waiters();
    private listeners = new Set<WireValueSubscriptionHandler>();
    private ignore_in_value = false;

    protected newConnection(client: ServiceStub): WireConnection
    {
        return { client, active: true, wake: new Waiters(), object: null, handle: null };
    }

    protected async runMember(object: ServiceStub, c: WireConnection): Promise<void>
    {
        const h = await object.connectWire(this.memberName);
        const ended = c.wake.wait(-1);
        const on_value = (_: WireHandle, value: unknown, timestamp: WireValue["timestamp"]) => this.valueReceived(value, timestamp);
        object.setWireIgnoreInValue(h, this.ignore_in_value);
        object.addWireValueChangedListener(h, on_value);
        object.setWireCloseCallback(h, () => c.wake.notifyAll());

        const first = this.ignore_in_value ? null : object.tryGetWireInValue(h);
        if (first) this.valueReceived(first.value, first.timestamp);

        c.object = object;
        c.handle = h;
        if (!h.closed && c.active) await ended;
        c.object = null;
        c.handle = null;

        object.removeWireValueChangedListener(h, on_value);
        object.setWireCloseCallback(h, null);
        if (!h.closed) await object.closeWire(h).catch(() => undefined);
    }

    private valueReceived(value: unknown, timestamp: WireValue["timestamp"]): void
    {
        this.in_value = { value, timestamp };
        this.in_value_received = Date.now();
        this.in_waiters.notifyAll();
        callListeners(this.listeners, this, value, timestamp);
    }

    /** Whether a value has been received and has not expired */
    get inValueValid(): boolean
    {
        return this.in_value !== null && (this.inValueLifespan < 0 || Date.now() - this.in_value_received <= this.inValueLifespan);
    }

    /** The latest value and its timestamp, or null if there is no valid value */
    tryGetInValue(): WireValue | null
    {
        return this.inValueValid ? this.in_value : null;
    }

    /** The latest value and its timestamp. Throws ValueNotSet if there is no valid value */
    getInValue(): WireValue
    {
        const v = this.tryGetInValue();
        if (!v) throw new RobotRaconteurError(MessageErrorType.ValueNotSet, "RobotRaconteur.ValueNotSet", "Value not valid");
        return v;
    }

    /** Wait for a valid value. A negative timeout waits indefinitely */
    async waitInValueValid(timeout = -1): Promise<boolean>
    {
        const deadline = Date.now() + timeout;
        while (!this.inValueValid)
        {
            if (this.closed) return false;
            const remaining = timeout < 0 ? -1 : deadline - Date.now();
            if (timeout >= 0 && remaining <= 0) return false;
            await this.in_waiters.wait(remaining);
        }
        return true;
    }

    /** Stop receiving values. Useful for wires that are only used for sending */
    get ignoreInValue(): boolean
    {
        return this.ignore_in_value;
    }

    /** Stop receiving values. Useful for wires that are only used for sending */
    set ignoreInValue(ignore: boolean)
    {
        this.ignore_in_value = ignore;
        for (const c of this.connections.values())
        {
            if (c.object && c.handle) c.object.setWireIgnoreInValue(c.handle, ignore);
        }
    }

    /** The number of clients with this wire connected */
    get activeConnectionCount(): number
    {
        return [...this.connections.values()].filter((c) => c.handle !== null).length;
    }

    /** Set the output value on every connected wire */
    setOutValueAll(value: unknown): void
    {
        for (const c of this.connections.values())
        {
            if (!c.object || !c.handle) continue;
            try
            {
                c.object.setWireOutValue(c.handle, value);
            }
            catch
            {
                // The wire closed, or is read only. One connection must not affect the others
            }
        }
    }

    /** Call a function with each new value */
    addWireValueChangedListener(listener: WireValueSubscriptionHandler): void
    {
        this.listeners.add(listener);
    }

    /** Stop calling a function added with addWireValueChangedListener */
    removeWireValueChangedListener(listener: WireValueSubscriptionHandler): void
    {
        this.listeners.delete(listener);
    }

    override close(): void
    {
        super.close();
        this.in_waiters.notifyAll();
    }
}

interface PipeConnection extends MemberConnection
{
    object: ServiceStub | null;
    handle: PipeHandle | null;
    active_sends: number;
}

/** Packets received from a pipe on any connected client, in a single queue */
export class PipeSubscription extends MemberSubscription<PipeConnection>
{
    /** Discard received packets. Useful for pipes that are only used for sending */
    ignoreReceived = false;

    private packets: unknown[] = [];
    private recv_waiters = new Waiters();
    private listeners = new Set<PipePacketSubscriptionHandler>();

    constructor(parent: ServiceSubscription, name: string, servicePath: string, private max_recv_packets: number, private max_send_backlog: number)
    {
        super(parent, name, servicePath);
    }

    protected newConnection(client: ServiceStub): PipeConnection
    {
        return { client, active: true, wake: new Waiters(), object: null, handle: null, active_sends: 0 };
    }

    protected async runMember(object: ServiceStub, c: PipeConnection): Promise<void>
    {
        const h = await object.connectPipe(this.memberName, -1);
        const ended = c.wake.wait(-1);
        const on_packet = () => this.drain(object, h);
        object.addPipePacketReceivedListener(h, on_packet);
        object.setPipeCloseCallback(h, () => c.wake.notifyAll());
        this.drain(object, h);

        c.object = object;
        c.handle = h;
        if (!h.closed && c.active) await ended;
        c.object = null;
        c.handle = null;

        object.removePipePacketReceivedListener(h, on_packet);
        object.setPipeCloseCallback(h, null);
        if (!h.closed) await object.closePipe(h).catch(() => undefined);
    }

    private drain(object: ServiceStub, h: PipeHandle): void
    {
        let received = false;
        while (object.getPipePacketsAvailable(h) > 0)
        {
            const packet = object.receivePipePacket(h);
            if (this.ignoreReceived) continue;
            this.packets.push(packet);
            received = true;
        }
        if (this.max_recv_packets >= 0 && this.packets.length > this.max_recv_packets)
        {
            this.packets.splice(0, this.packets.length - this.max_recv_packets);
        }
        if (!received) return;
        this.recv_waiters.notifyAll();
        callListeners(this.listeners, this);
    }

    /** The number of packets waiting to be read */
    get available(): number
    {
        return this.packets.length;
    }

    /** The number of clients with this pipe connected */
    get activeConnectionCount(): number
    {
        return [...this.connections.values()].filter((c) => c.handle !== null).length;
    }

    /** The next packet, as { value }, or null if there are none */
    tryReceivePacket(): PipePacketValue | null
    {
        return this.packets.length > 0 ? { value: this.packets.shift() } : null;
    }

    /** Take the next packet. Throws InvalidOperation if there are none */
    receivePacket(): unknown
    {
        const p = this.tryReceivePacket();
        if (!p) throw new RobotRaconteurError(MessageErrorType.InvalidOperation, "RobotRaconteur.InvalidOperation", "No packets available");
        return p.value;
    }

    /** Wait for a packet, returning { value } or null. A negative timeout waits indefinitely */
    async tryReceivePacketWait(timeout = -1, peek = false): Promise<PipePacketValue | null>
    {
        const deadline = Date.now() + timeout;
        while (this.packets.length === 0)
        {
            if (this.closed) return null;
            const remaining = timeout < 0 ? -1 : deadline - Date.now();
            if (timeout >= 0 && remaining <= 0) return null;
            await this.recv_waiters.wait(remaining);
        }
        return peek ? { value: this.packets[0] } : this.tryReceivePacket();
    }

    /** Send on every connected pipe. A connection with too many writes in progress skips the packet */
    sendPacketAll(value: unknown): void
    {
        for (const c of this.connections.values())
        {
            if (!c.object || !c.handle) continue;
            if (this.max_send_backlog >= 0 && c.active_sends >= this.max_send_backlog) continue;
            c.active_sends++;
            c.object.sendPipePacket(c.handle, value).catch(() => undefined).finally(() => c.active_sends--);
        }
    }

    /** Call a function when packets arrive */
    addPipePacketReceivedListener(listener: PipePacketSubscriptionHandler): void
    {
        this.listeners.add(listener);
    }

    /** Stop calling a function added with addPipePacketReceivedListener */
    removePipePacketReceivedListener(listener: PipePacketSubscriptionHandler): void
    {
        this.listeners.delete(listener);
    }

    override close(): void
    {
        super.close();
        this.recv_waiters.notifyAll();
    }
}

/** Finds an object below the root object of the subscription's current client */
export class SubObjectSubscription
{
    constructor(private parent: ServiceSubscription, private servicePath: string) {}

    /** The object on the subscription's current client. Throws if no client is connected */
    async getDefaultClient(): Promise<ServiceStub>
    {
        return resolvePath(this.parent.getDefaultClient(), this.servicePath);
    }

    /** The object on the subscription's current client, or null if none is connected or the object cannot be found */
    async tryGetDefaultClient(): Promise<ServiceStub | null>
    {
        const c = this.parent.tryGetDefaultClient();
        if (!c) return null;
        try
        {
            return await resolvePath(c, this.servicePath);
        }
        catch
        {
            return null;
        }
    }

    /** Wait up to timeout milliseconds for a client, or indefinitely if negative, and return the object. Throws if none connects in time */
    async getDefaultClientWait(timeout = -1): Promise<ServiceStub>
    {
        return resolvePath(await this.parent.getDefaultClientWait(timeout), this.servicePath);
    }

    /** Wait up to timeout milliseconds for a client, or indefinitely if negative, and return the object, or null */
    async tryGetDefaultClientWait(timeout = -1): Promise<ServiceStub | null>
    {
        const c = await this.parent.tryGetDefaultClientWait(timeout);
        if (!c) return null;
        try
        {
            return await resolvePath(c, this.servicePath);
        }
        catch
        {
            return null;
        }
    }
}
