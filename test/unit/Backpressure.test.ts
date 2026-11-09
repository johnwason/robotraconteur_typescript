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

import assert from "node:assert/strict";
import { test } from "node:test";

import { ClassicWebSocketAdapter, SendQueue } from "../../src/BrowserWebSocketTransport.js";
import { DataTypes, MessageEntryType } from "../../src/DataTypes.js";
import { deserializeMessage, Message, MessageElement, MessageEntry, serializeMessage } from "../../src/Message.js";

/** A socket whose writes complete only when released */
class GatedSocket
{
    frames: number[][] = [];
    waiting: (() => void)[] = [];
    gated = true;
    fail: Error | null = null;

    write = (frame: Uint8Array): Promise<void> | void =>
    {
        if (this.fail) return Promise.reject(this.fail);
        this.frames.push(Array.from(frame.subarray(0, 1)));
        if (!this.gated) return;
        return new Promise<void>((resolve) => this.waiting.push(resolve));
    };

    async release(): Promise<void>
    {
        this.waiting.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    sent(): number[]
    {
        return this.frames.map((x) => x[0]!);
    }
}

function msg(id: number, opts: { wire?: string; test?: boolean; size?: number } = {}): { data: Uint8Array; wire_key?: string; connection_test: boolean }
{
    const data = new Uint8Array(opts.size ?? 8).fill(id);
    return { data, wire_key: opts.wire, connection_test: opts.test ?? false };
}

function queue(s: GatedSocket): { q: SendQueue; errors: () => number; sends: () => number }
{
    let errors = 0;
    let sends = 0;
    const q = new SendQueue(s.write, () => sends++, () => errors++);
    return { q, errors: () => errors, sends: () => sends };
}

test("messages are sent immediately and in order when the socket has room", () =>
{
    const s = new GatedSocket();
    s.gated = false;
    const { q, sends } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2));
    q.enqueue(msg(3));
    assert.deepEqual(s.sent(), [1, 2, 3], "sent without waiting for a later tick");
    assert.equal(sends(), 3);
});

test("only one message is sent at a time while the socket is full", async () =>
{
    const s = new GatedSocket();
    const { q } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2));
    q.enqueue(msg(3));
    assert.deepEqual(s.sent(), [1]);
    assert.equal(q.length, 2);
    await s.release();
    assert.deepEqual(s.sent(), [1, 2]);
    await s.release();
    assert.deepEqual(s.sent(), [1, 2, 3]);
});

test("a newer wire packet replaces a queued one in place", async () =>
{
    const s = new GatedSocket();
    const { q } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2, { wire: "a" }));
    q.enqueue(msg(3));
    q.enqueue(msg(4, { wire: "b" }));
    q.enqueue(msg(5, { wire: "a" }));
    q.enqueue(msg(6, { wire: "a" }));
    assert.equal(q.length, 3);
    for (let i = 0; i < 4; i++) await s.release();
    assert.deepEqual(s.sent(), [1, 6, 3, 4]);
});

test("a wire packet already being sent is not replaced", async () =>
{
    const s = new GatedSocket();
    const { q } = queue(s);
    q.enqueue(msg(1, { wire: "a" }));
    q.enqueue(msg(2, { wire: "a" }));
    for (let i = 0; i < 2; i++) await s.release();
    assert.deepEqual(s.sent(), [1, 2]);
});

test("connection tests are not duplicated while waiting", async () =>
{
    const s = new GatedSocket();
    const { q } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2, { test: true }));
    q.enqueue(msg(3, { test: true }));
    assert.equal(q.length, 1);
    await s.release();
    assert.deepEqual(s.sent(), [1, 2]);
});

test("large messages are split into 64 KB frames and wait between frames", async () =>
{
    const s = new GatedSocket();
    const sizes: number[] = [];
    const inner = s.write;
    s.write = (f: Uint8Array) =>
    {
        sizes.push(f.length);
        return inner(f);
    };
    const { q } = queue(s);
    q.enqueue(msg(1, { size: 150000 }));
    assert.deepEqual(sizes, [65536]);
    await s.release();
    assert.deepEqual(sizes, [65536, 65536]);
    await s.release();
    assert.deepEqual(sizes, [65536, 65536, 18928]);
});

test("a failed write stops the queue and reports the error", async () =>
{
    const s = new GatedSocket();
    s.fail = new Error("closed");
    const { q, errors } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(errors(), 1);
    assert.equal(q.length, 0);
});

test("stopping discards queued messages", async () =>
{
    const s = new GatedSocket();
    const { q } = queue(s);
    q.enqueue(msg(1));
    q.enqueue(msg(2));
    q.stop();
    await s.release();
    assert.deepEqual(s.sent(), [1]);
});

function fakeWebSocket()
{
    return {
        bufferedAmount: 0,
        readyState: 1,
        sent: 0,
        send(_: Uint8Array)
        {
            this.sent++;
        },
        close() {}
    };
}

test("the WebSocket fallback only waits above the high water mark", () =>
{
    const ws = fakeWebSocket();
    const a = new ClassicWebSocketAdapter(ws, 1000, 100);
    ws.bufferedAmount = 1000;
    assert.equal(a.write(new Uint8Array(1)), undefined);
    assert.equal(ws.sent, 1);
});

test("the WebSocket fallback polls until drained to the low water mark", async () =>
{
    const ws = fakeWebSocket();
    const a = new ClassicWebSocketAdapter(ws, 1000, 100);
    ws.bufferedAmount = 2000;
    let done = false;
    const wait = a.write(new Uint8Array(1))!.then(() =>
    {
        done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(done, false, "still above the low water mark");
    ws.bufferedAmount = 500;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(done, false, "below the high water mark is not enough to resume");
    ws.bufferedAmount = 100;
    await wait;
    assert.equal(done, true);
});

test("the WebSocket fallback stops waiting if the socket closes", async () =>
{
    const ws = fakeWebSocket();
    const a = new ClassicWebSocketAdapter(ws, 1000, 100);
    ws.bufferedAmount = 2000;
    const wait = a.write(new Uint8Array(1)) as Promise<void>;
    ws.readyState = 3;
    await assert.rejects(wait);
});

test("serializing copies the caller's array", () =>
{
    const array = Float64Array.of(1, 2);
    const m = new Message();
    const e = new MessageEntry(MessageEntryType.ConnectionTest);
    e.addElement(new MessageElement("v", DataTypes.double_t, array));
    m.entries.push(e);
    const data = serializeMessage(m);
    array[0] = 99;
    assert.deepEqual(deserializeMessage(data).entries[0]!.elements[0]!.data, Float64Array.of(1, 2));
});
