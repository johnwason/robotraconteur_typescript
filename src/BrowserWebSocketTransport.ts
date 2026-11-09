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

import { DataTypes, MessageEntryType, MessageErrorType, TransportCapabilityCode } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import { deserializeMessage, findElement, Message, MessageElement, MessageEntry, serializeMessage } from "./Message.js";
import { NodeID } from "./NodeID.js";
import type { RobotRaconteurNode } from "./Node.js";
import type { ClientContext } from "./Client.js";
import { ITransportConnection, parseConnectionUrl, Transport } from "./Transport.js";

const WEBSOCKET_PROTOCOL = "robotraconteur.robotraconteur.com";
/** The Robot Raconteur TCP Transport standard limits WebSocket frames to 64 KB */
const MAX_FRAME_SIZE = 65536;

const OPEN = 1;
const POLL_PERIOD_MS = 5;

function connectionError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", message);
}

/**
 * A connected socket. write() returns a promise when the caller must wait before writing more, so
 * that nothing is delayed while the socket has room.
 */
export interface SocketAdapter
{
    write(frame: Uint8Array): Promise<void> | void;
    close(): void;
}

interface SocketEvents
{
    onData(frame: Uint8Array): void;
    onClose(): void;
}

interface WebSocketLike
{
    readonly bufferedAmount: number;
    readonly readyState: number;
    send(data: Uint8Array): void;
    close(): void;
}

/** The WebSocket class has no notification that its send buffer has drained, so it must be polled */
export class ClassicWebSocketAdapter implements SocketAdapter
{
    constructor(private ws: WebSocketLike, private high_water_mark: number, private low_water_mark: number) {}

    write(frame: Uint8Array): Promise<void> | void
    {
        this.ws.send(frame);
        if (this.ws.bufferedAmount > this.high_water_mark) return this.drain();
    }

    private async drain(): Promise<void>
    {
        while (this.ws.bufferedAmount > this.low_water_mark)
        {
            if (this.ws.readyState !== OPEN) throw connectionError("Transport connection closed");
            await new Promise((resolve) => setTimeout(resolve, POLL_PERIOD_MS));
        }
    }

    close(): void
    {
        this.ws.close();
    }
}

function openClassicWebSocket(url: string, timeout: number, high: number, low: number, events: SocketEvents): Promise<SocketAdapter>
{
    return new Promise<SocketAdapter>((resolve, reject) =>
    {
        const ws = new WebSocket(url, WEBSOCKET_PROTOCOL);
        ws.binaryType = "arraybuffer";
        const timer = setTimeout(() =>
        {
            ws.close();
            reject(connectionError("Timed out connecting to WebSocket"));
        }, timeout);

        ws.onopen = () =>
        {
            clearTimeout(timer);
            ws.onmessage = (ev) => events.onData(new Uint8Array(ev.data as ArrayBuffer));
            ws.onclose = () => events.onClose();
            ws.onerror = () => events.onClose();
            resolve(new ClassicWebSocketAdapter(ws as unknown as WebSocketLike, high, low));
        };
        ws.onerror = () =>
        {
            clearTimeout(timer);
            reject(connectionError("Could not connect to WebSocket"));
        };
    });
}

// WebSocketStream is not yet in the TypeScript DOM library
interface WebSocketStreamConnection
{
    readable: ReadableStream<ArrayBuffer | Uint8Array | string>;
    writable: WritableStream<Uint8Array>;
}

interface WebSocketStreamInstance
{
    opened: Promise<WebSocketStreamConnection>;
    closed: Promise<unknown>;
    close(): void;
}

type WebSocketStreamConstructor = new (url: string, options: { protocols: string[]; signal: AbortSignal }) => WebSocketStreamInstance;

function webSocketStreamConstructor(): WebSocketStreamConstructor | undefined
{
    return (globalThis as unknown as { WebSocketStream?: WebSocketStreamConstructor }).WebSocketStream;
}

/** WebSocketStream applies backpressure in both directions, which WebSocket cannot do for receiving */
async function openWebSocketStream(ctor: WebSocketStreamConstructor, url: string, timeout: number, events: SocketEvents): Promise<SocketAdapter>
{
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    const wss = new ctor(url, { protocols: [WEBSOCKET_PROTOCOL], signal: abort.signal });
    wss.closed.catch(() => undefined);

    let connection: WebSocketStreamConnection;
    try
    {
        connection = await wss.opened;
    }
    catch
    {
        throw connectionError("Could not connect to WebSocket");
    }
    finally
    {
        clearTimeout(timer);
    }

    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();

    // Messages are only parsed and handed off here, so that reading never waits on application
    // code. Replies and heartbeats share this connection and must keep flowing.
    void (async () =>
    {
        try
        {
            for (;;)
            {
                const { value, done } = await reader.read();
                if (done) break;
                if (typeof value === "string") break;
                events.onData(value instanceof Uint8Array ? value : new Uint8Array(value));
            }
        }
        catch
        {
            // Reported as a close below
        }
        events.onClose();
    })();

    return {
        write: (frame) => writer.write(frame),
        close: () => wss.close()
    };
}

interface QueuedMessage
{
    data: Uint8Array;
    /** Set for wire packets. A newer packet for the same wire replaces a queued one */
    wire_key?: string;
    connection_test: boolean;
}

/**
 * Sends one message at a time, waiting whenever the socket reports it is full. As in Core, stale
 * wire packets and duplicate connection tests are discarded instead of accumulating.
 */
export class SendQueue
{
    private queue: QueuedMessage[] = [];
    private pumping = false;
    private stopped = false;

    constructor(private write: (frame: Uint8Array) => Promise<void> | void, private on_send: () => void, private on_error: () => void) {}

    enqueue(m: QueuedMessage): void
    {
        if (m.connection_test && this.queue.some((x) => x.connection_test)) return;
        if (m.wire_key !== undefined)
        {
            const i = this.queue.findIndex((x) => x.wire_key === m.wire_key);
            if (i >= 0)
            {
                this.queue[i] = m;
                return;
            }
        }
        this.queue.push(m);
        void this.pump();
    }

    get length(): number
    {
        return this.queue.length;
    }

    stop(): void
    {
        this.stopped = true;
        this.queue.length = 0;
    }

    private async pump(): Promise<void>
    {
        if (this.pumping) return;
        this.pumping = true;
        try
        {
            while (this.queue.length > 0 && !this.stopped)
            {
                const { data } = this.queue.shift()!;
                this.on_send();
                for (let pos = 0; pos < data.length && !this.stopped; pos += MAX_FRAME_SIZE)
                {
                    const wait = this.write(data.subarray(pos, Math.min(pos + MAX_FRAME_SIZE, data.length)));
                    if (wait) await wait;
                }
            }
        }
        catch
        {
            this.stop();
            this.on_error();
        }
        finally
        {
            this.pumping = false;
        }
    }
}

/** Client transport using the WebSocket class available in browsers and recent Node.js */
export class BrowserWebSocketTransport implements Transport
{
    /** Period for connection test messages in milliseconds */
    heartbeatPeriod = 5000;
    /** Connection is closed if the remote node has not been heard from for this long in milliseconds */
    defaultReceiveTimeout = 15000;
    defaultConnectTimeout = 2500;
    maxMessageSize = 12 * 1024 * 1024;
    /** Use WebSocketStream where the browser provides it. If false, always use WebSocket */
    useWebSocketStream = true;
    /** When using WebSocket, stop sending when this many bytes are buffered */
    sendHighWaterMark = 256 * 1024;
    /** When using WebSocket, resume sending when no more than this many bytes are buffered */
    sendLowWaterMark = 64 * 1024;

    private connections = new Set<BrowserWebSocketClientTransport>();

    constructor(public node: RobotRaconteurNode) {}

    canConnectService(url: string): boolean
    {
        return ["tcp", "rr+tcp", "rr+ws", "rr+wss"].includes(parseConnectionUrl(url).scheme);
    }

    async createTransportConnection(url: string, client: ClientContext): Promise<ITransportConnection>
    {
        const c = new BrowserWebSocketClientTransport(this, url, client);
        await c.connect();
        this.connections.add(c);
        return c;
    }

    close(): void
    {
        for (const c of [...this.connections]) c.close();
    }

    removeConnection(c: BrowserWebSocketClientTransport): void
    {
        this.connections.delete(c);
    }
}

interface StreamOpWait
{
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
}

class BrowserWebSocketClientTransport implements ITransportConnection
{
    remoteNodeID = NodeID.Any;
    useCombinedConnection = false;

    private socket!: SocketAdapter;
    private send_queue!: SendQueue;
    private connected = false;
    private readonly target_nodeid: NodeID;
    private readonly target_nodename: string;

    private recv_buf = new Uint8Array(65536);
    private recv_len = 0;

    private streamop_wait: StreamOpWait | null = null;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private tlastsend = Date.now();
    private tlastrec = Date.now();
    private tlastrec_mes = Date.now();

    constructor(private parent: BrowserWebSocketTransport, private url: string, private client: ClientContext)
    {
        const u = parseConnectionUrl(url);
        if (u.host === "") throw connectionError("Invalid connection URL for WebSocket");
        this.target_nodeid = u.nodeid;
        this.target_nodename = u.nodename;
    }

    async connect(): Promise<void>
    {
        const u = parseConnectionUrl(this.url);
        const scheme = u.scheme.endsWith("wss") ? "wss" : "ws";
        const ws_url = this.url.replace(u.scheme + "://", scheme + "://");

        const events: SocketEvents = {
            onData: (frame) => this.dataReceived(frame),
            onClose: () => this.close()
        };
        const p = this.parent;
        const stream_ctor = p.useWebSocketStream ? webSocketStreamConstructor() : undefined;
        this.socket = stream_ctor
            ? await openWebSocketStream(stream_ctor, ws_url, p.defaultConnectTimeout, events)
            : await openClassicWebSocket(ws_url, p.defaultConnectTimeout, p.sendHighWaterMark, p.sendLowWaterMark, events);

        this.send_queue = new SendQueue((frame) => this.socket.write(frame), () =>
        {
            this.tlastsend = Date.now();
        }, () => this.close());
        this.connected = true;

        try
        {
            await this.createConnection();
        }
        catch (e)
        {
            this.close();
            throw e;
        }

        this.tlastsend = this.tlastrec = this.tlastrec_mes = Date.now();
        this.heartbeat = setInterval(() => this.doHeartbeat(), 500);
        (this.heartbeat as unknown as { unref?: () => void }).unref?.();
    }

    private async createConnection(): Promise<void>
    {
        const m = new Message();
        m.header.senderNodeID = this.parent.node.nodeID;
        m.header.senderNodeName = this.parent.node.nodeName;
        m.header.receiverNodeID = this.target_nodeid;
        m.header.receiverNodeName = this.target_nodename;

        // Message Version 4 is not offered, so the service will continue to use Message Version 2
        const mm = new MessageEntry(MessageEntryType.StreamOp, "CreateConnection");
        const caps = (TransportCapabilityCode.Message2BasicPage | TransportCapabilityCode.Message2BasicEnable | TransportCapabilityCode.Message2BasicConnectCombined) >>> 0;
        mm.addElement(new MessageElement("capabilities", DataTypes.uint32_t, Uint32Array.of(caps)));
        m.entries.push(mm);

        const ret = await new Promise<Message>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(connectionError("Timed out creating connection")), 10000);
            this.streamop_wait = {
                resolve: (x) =>
                {
                    clearTimeout(timer);
                    resolve(x);
                },
                reject: (e) =>
                {
                    clearTimeout(timer);
                    reject(e);
                }
            };
            this.sendMessage(m);
        });

        const entry = ret.entries[0]!;
        if (entry.error !== MessageErrorType.None && entry.error !== MessageErrorType.ProtocolError)
        {
            const s = findElement(entry.elements, "errorstring");
            throw new RobotRaconteurError(entry.error, findElement(entry.elements, "errorname")?.castString() ?? "RobotRaconteur.ConnectionError", s?.castString() ?? "Could not create connection");
        }

        if ((this.target_nodename !== "" && this.target_nodename !== ret.header.senderNodeName)
            || (!this.target_nodeid.isAnyNode && !this.target_nodeid.equals(ret.header.senderNodeID)))
        {
            throw connectionError("Invalid node connection");
        }

        const caps_ret = findElement(entry.elements, "capabilities")?.data;
        if (caps_ret instanceof Uint32Array)
        {
            for (const cap of caps_ret)
            {
                if (((cap & TransportCapabilityCode.PageMask) >>> 0) === TransportCapabilityCode.Message2BasicPage)
                {
                    this.useCombinedConnection = (cap & TransportCapabilityCode.Message2BasicConnectCombined) !== 0;
                }
            }
        }
        this.remoteNodeID = ret.header.senderNodeID;
    }

    private dataReceived(frame: Uint8Array): void
    {
        try
        {
            // Common case of one complete message in the frame avoids copying
            if (this.recv_len === 0 && frame.length >= 8 && this.messageSize(frame) === frame.length)
            {
                this.processMessage(frame);
                return;
            }

            if (this.recv_len + frame.length > this.recv_buf.length)
            {
                const b = new Uint8Array(Math.max(this.recv_buf.length * 2, this.recv_len + frame.length));
                b.set(this.recv_buf.subarray(0, this.recv_len));
                this.recv_buf = b;
            }
            this.recv_buf.set(frame, this.recv_len);
            this.recv_len += frame.length;

            let pos = 0;
            while (this.recv_len - pos >= 8)
            {
                const size = this.messageSize(this.recv_buf.subarray(pos, pos + 8));
                if (this.recv_len - pos < size) break;
                this.processMessage(this.recv_buf.subarray(pos, pos + size));
                pos += size;
                if (!this.connected) return;
            }
            if (pos > 0)
            {
                this.recv_buf.copyWithin(0, pos, this.recv_len);
                this.recv_len -= pos;
            }
        }
        catch
        {
            this.close();
        }
    }

    private messageSize(b: Uint8Array): number
    {
        if (b[0] !== 0x52 || b[1] !== 0x52 || b[2] !== 0x41 || b[3] !== 0x43) throw new RangeError("Invalid magic");
        const size = new DataView(b.buffer, b.byteOffset, 8).getUint32(4, true);
        if (size < 16 || size > this.parent.maxMessageSize) throw new RangeError("Invalid message size");
        return size;
    }

    private processMessage(data: Uint8Array): void
    {
        const m = deserializeMessage(data);
        this.tlastrec = Date.now();
        const entry = m.entries[0];

        if (m.entries.length === 1 && entry)
        {
            switch (entry.entryType)
            {
            case MessageEntryType.StreamOpRet:
                {
                    const w = this.streamop_wait;
                    this.streamop_wait = null;
                    w?.resolve(m);
                    return;
                }
            case MessageEntryType.ConnectionTestRet:
                return;
            case MessageEntryType.ConnectionTest:
                this.sendEmptyResponse(m, new MessageEntry(MessageEntryType.ConnectionTestRet));
                return;
            case MessageEntryType.StreamCheckCapability:
                {
                    const r = new MessageEntry(MessageEntryType.StreamCheckCapabilityRet, entry.memberName);
                    r.addElement(new MessageElement("return", DataTypes.uint32_t, Uint32Array.of(0)));
                    this.sendEmptyResponse(m, r);
                    return;
                }
            }
        }

        this.tlastrec_mes = this.tlastrec;
        this.parent.node.messageReceived(m);
    }

    private sendEmptyResponse(m: Message, entry: MessageEntry): void
    {
        const r = new Message();
        r.header.senderNodeID = this.parent.node.nodeID;
        r.header.receiverNodeID = m.header.senderNodeID;
        r.entries.push(entry);
        this.sendMessage(r);
    }

    sendMessage(m: Message): void
    {
        if (!this.connected) throw connectionError("Transport connection closed");
        const data = serializeMessage(m);
        if (data.length > this.parent.maxMessageSize - 100) throw new RobotRaconteurError(MessageErrorType.ProtocolError, "RobotRaconteur.ProtocolError", "Message larger than maximum message size");

        // The message is serialized now so that later changes to the caller's arrays cannot affect it
        const entry = m.entries.length === 1 ? m.entries[0]! : undefined;
        this.send_queue.enqueue({
            data,
            wire_key: entry?.entryType === MessageEntryType.WirePacket ? entry.servicePath + "\0" + entry.memberName : undefined,
            connection_test: entry?.entryType === MessageEntryType.ConnectionTest
        });
    }

    private doHeartbeat(): void
    {
        const now = Date.now();
        try
        {
            if (now - this.tlastsend > this.parent.heartbeatPeriod)
            {
                const m = new Message();
                m.header.senderNodeID = this.parent.node.nodeID;
                m.entries.push(new MessageEntry(MessageEntryType.ConnectionTest));
                this.sendMessage(m);
            }
            if (this.tlastsend - this.tlastrec > this.parent.defaultReceiveTimeout || now - this.tlastrec_mes > this.parent.node.transportInactivityTimeout)
            {
                this.close();
            }
        }
        catch
        {
            this.close();
        }
    }

    close(): void
    {
        if (!this.connected) return;
        this.connected = false;
        clearInterval(this.heartbeat);
        this.parent.removeConnection(this);

        const w = this.streamop_wait;
        this.streamop_wait = null;
        w?.reject(connectionError("Transport connection closed"));

        this.send_queue.stop();
        try
        {
            this.socket.close();
        }
        catch
        {
            // Already closing
        }
        this.client.transportConnectionClosed();
    }
}
