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

function connectionError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", message);
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

    private ws!: WebSocket;
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

        await new Promise<void>((resolve, reject) =>
        {
            const ws = new WebSocket(ws_url, WEBSOCKET_PROTOCOL);
            ws.binaryType = "arraybuffer";
            const timer = setTimeout(() =>
            {
                ws.close();
                reject(connectionError("Timed out connecting to WebSocket"));
            }, this.parent.defaultConnectTimeout);

            ws.onopen = () =>
            {
                clearTimeout(timer);
                this.ws = ws;
                resolve();
            };
            ws.onerror = () =>
            {
                clearTimeout(timer);
                reject(connectionError("Could not connect to WebSocket"));
            };
        });

        this.connected = true;
        this.ws.onmessage = (ev) => this.dataReceived(new Uint8Array(ev.data as ArrayBuffer));
        this.ws.onclose = () => this.close();
        this.ws.onerror = () => this.close();

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
        this.tlastsend = Date.now();
        for (let pos = 0; pos < data.length; pos += MAX_FRAME_SIZE)
        {
            this.ws.send(data.subarray(pos, Math.min(pos + MAX_FRAME_SIZE, data.length)));
        }
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

        try
        {
            this.ws.close();
        }
        catch
        {
            // Already closing
        }
        this.client.transportConnectionClosed();
    }
}
