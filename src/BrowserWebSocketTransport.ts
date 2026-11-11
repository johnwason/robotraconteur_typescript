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

import type { RobotRaconteurNode } from "./Node.js";
import { connectionError, SocketAdapter, SocketEvents, StreamConnection, StreamTransportParent } from "./StreamTransport.js";
import { Endpoint, ITransportConnection, parseConnectionUrl, Transport } from "./Transport.js";

export { SendQueue } from "./StreamTransport.js";
export type { SocketAdapter } from "./StreamTransport.js";

const WEBSOCKET_PROTOCOL = "robotraconteur.robotraconteur.com";

const OPEN = 1;
const POLL_PERIOD_MS = 5;

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

/** Client transport using the WebSocket class available in browsers and recent Node.js */
export class BrowserWebSocketTransport implements Transport, StreamTransportParent
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

    private connections = new Set<StreamConnection>();

    constructor(public node: RobotRaconteurNode) {}

    canConnectService(url: string): boolean
    {
        return ["tcp", "rr+tcp", "rr+ws", "rr+wss"].includes(parseConnectionUrl(url).scheme);
    }

    async createTransportConnection(url: string, endpoint: Endpoint): Promise<ITransportConnection>
    {
        const u = parseConnectionUrl(url);
        if (u.host === "") throw connectionError("Invalid connection URL for WebSocket");
        const ws_url = url.replace(u.scheme + "://", (u.scheme.endsWith("wss") ? "wss" : "ws") + "://");

        const c = new StreamConnection(this, u.nodeid, u.nodename, endpoint);
        const stream_ctor = this.useWebSocketStream ? webSocketStreamConstructor() : undefined;
        await c.connect((events) => stream_ctor
            ? openWebSocketStream(stream_ctor, ws_url, this.defaultConnectTimeout, events)
            : openClassicWebSocket(ws_url, this.defaultConnectTimeout, this.sendHighWaterMark, this.sendLowWaterMark, events));
        this.connections.add(c);
        return c;
    }

    close(): void
    {
        for (const c of [...this.connections]) c.close();
    }

    removeConnection(c: StreamConnection): void
    {
        this.connections.delete(c);
    }
}
