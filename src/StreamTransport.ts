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
import type { Endpoint, ITransportConnection } from "./Transport.js";

/** The Robot Raconteur TCP Transport standard limits WebSocket frames to 64 KB */
const MAX_FRAME_SIZE = 65536;

export function connectionError(message: string): RobotRaconteurError
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

export interface SocketEvents
{
    onData(frame: Uint8Array): void;
    onClose(): void;
}

export type SocketOpener = (events: SocketEvents) => Promise<SocketAdapter>;

/** The node that answered a STARTTLS request, which its certificate must identify */
export interface TlsPeer
{
    nodeID: NodeID;
    nodeName: string;
    /** True if the server agreed to check a client certificate */
    mutualAuth: boolean;
}

/**
 * Switch the connection to TLS after STARTTLS, and verify the server. Returns the socket to use
 * from then on, which must deliver its data to the same events.
 */
export type TlsStarter = (events: SocketEvents, peer: TlsPeer) => Promise<SocketAdapter>;

export interface StreamTlsOptions
{
    start: TlsStarter;
    /** Ask the server to check a client certificate */
    mutualAuth: boolean;
}

/** The settings and owner of the connections of a stream transport */
export interface StreamTransportParent
{
    readonly node: RobotRaconteurNode;
    /** Period for connection test messages in milliseconds */
    heartbeatPeriod: number;
    /** Connection is closed if the remote node has not been heard from for this long in milliseconds */
    defaultReceiveTimeout: number;
    maxMessageSize: number;
    removeConnection(c: StreamClientConnection): void;
}

interface QueuedMessage
{
    data: Uint8Array;
    /** Set for wire packets. A newer packet for the same wire replaces a queued one */
    wire_key?: string;
    connection_test: boolean;
    /** Called when the message has been written, or with an error if it will never be */
    done?: (error?: Error) => void;
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
    private current: QueuedMessage | null = null;

    constructor(private write: (frame: Uint8Array) => Promise<void> | void, private on_send: () => void, private on_error: () => void) {}

    enqueue(m: QueuedMessage): void
    {
        if (m.connection_test && this.queue.some((x) => x.connection_test)) return;
        if (m.wire_key !== undefined)
        {
            const i = this.queue.findIndex((x) => x.wire_key === m.wire_key);
            if (i >= 0)
            {
                this.queue[i]!.done?.();
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
        const closed = connectionError("Transport connection closed");
        this.current?.done?.(closed);
        this.current = null;
        for (const m of this.queue) m.done?.(closed);
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
                const item = this.queue.shift()!;
                this.current = item;
                const { data } = item;
                this.on_send();
                for (let pos = 0; pos < data.length && !this.stopped; pos += MAX_FRAME_SIZE)
                {
                    const wait = this.write(data.subarray(pos, Math.min(pos + MAX_FRAME_SIZE, data.length)));
                    if (wait) await wait;
                }
                if (this.stopped) return;
                this.current = null;
                item.done?.();
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

interface StreamOpWait
{
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
}

/** The Basic Stream Protocol for a client: framing, send queue, heartbeat, and connection handshake */
export class StreamClientConnection implements ITransportConnection
{
    remoteNodeID = NodeID.Any;
    useCombinedConnection = false;

    private socket!: SocketAdapter;
    private send_queue!: SendQueue;
    private connected = false;

    private recv_buf = new Uint8Array(65536);
    private recv_len = 0;

    private streamop_wait: StreamOpWait | null = null;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private tlastsend = Date.now();
    private tlastrec = Date.now();
    private tlastrec_mes = Date.now();

    constructor(private parent: StreamTransportParent, private target_nodeid: NodeID, private target_nodename: string, private endpoint: Endpoint) {}

    /** True once TLS is in use */
    secure = false;

    async connect(open: SocketOpener, tls?: StreamTlsOptions): Promise<void>
    {
        const events: SocketEvents = {
            onData: (frame) => this.dataReceived(frame),
            onClose: () => this.close()
        };
        this.socket = await open(events);

        this.send_queue = new SendQueue((frame) => this.socket.write(frame), () =>
        {
            this.tlastsend = Date.now();
        }, () => this.close());
        this.connected = true;

        try
        {
            if (tls) await this.startTls(tls, events);
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

    /** Send a stream operation and wait for its reply, failing if the reply reports an error */
    private async streamOp(m: Message, timeout_message: string, failure_message: string): Promise<Message>
    {
        const ret = await new Promise<Message>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(connectionError(timeout_message)), 10000);
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
            throw new RobotRaconteurError(entry.error, findElement(entry.elements, "errorname")?.castString() ?? "RobotRaconteur.ConnectionError", s?.castString() ?? failure_message);
        }
        return ret;
    }

    /** Ask the server to switch to TLS, as Core does before creating the connection */
    private async startTls(tls: StreamTlsOptions, events: SocketEvents): Promise<void>
    {
        const m = new Message();
        m.header.senderNodeID = this.parent.node.nodeID;
        m.header.senderNodeName = this.parent.node.nodeName;
        m.header.receiverNodeID = this.target_nodeid;
        m.header.receiverNodeName = this.target_nodename;
        const mm = new MessageEntry(MessageEntryType.StreamOp, "STARTTLS");
        if (tls.mutualAuth) mm.addElement(MessageElement.string("mutualauth", "true"));
        m.entries.push(mm);

        const ret = await this.streamOp(m, "Timed out starting TLS", "Could not start TLS");
        const sender_id = ret.header.senderNodeID;
        const sender_name = ret.header.senderNodeName;
        const any_target = this.target_nodeid.isAnyNode;
        // The same checks as Core, so that the certificate is checked against the node that was requested
        const matches = (any_target && this.target_nodename === "")
            || (!any_target && this.target_nodeid.equals(sender_id))
            || (any_target && sender_name === this.target_nodename);
        if (!matches) throw connectionError("Could not create TLS connection");

        const mutual = findElement(ret.entries[0]!.elements, "mutualauth")?.castString() === "true";
        this.socket = await tls.start(events, { nodeID: sender_id, nodeName: sender_name, mutualAuth: tls.mutualAuth && mutual });
        this.secure = true;
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

        const ret = await this.streamOp(m, "Timed out creating connection", "Could not create connection");
        const entry = ret.entries[0]!;

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
        this.enqueueMessage(m);
    }

    sendMessageWait(m: Message): Promise<void>
    {
        return new Promise<void>((resolve, reject) => this.enqueueMessage(m, (error) => (error ? reject(error) : resolve())));
    }

    private enqueueMessage(m: Message, done?: (error?: Error) => void): void
    {
        if (!this.connected) throw connectionError("Transport connection closed");
        const data = serializeMessage(m);
        if (data.length > this.parent.maxMessageSize - 100) throw new RobotRaconteurError(MessageErrorType.ProtocolError, "RobotRaconteur.ProtocolError", "Message larger than maximum message size");

        // The message is serialized now so that later changes to the caller's arrays cannot affect it
        const entry = m.entries.length === 1 ? m.entries[0]! : undefined;
        this.send_queue.enqueue({
            data,
            wire_key: entry?.entryType === MessageEntryType.WirePacket ? entry.servicePath + "\0" + entry.memberName : undefined,
            connection_test: entry?.entryType === MessageEntryType.ConnectionTest,
            done
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
        this.endpoint.transportConnectionClosed();
    }
}
