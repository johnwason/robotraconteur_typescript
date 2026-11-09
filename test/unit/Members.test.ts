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

import { SendQueue } from "../../src/BrowserWebSocketTransport.js";
import { DataTypes, MessageEntryType } from "../../src/DataTypes.js";
import { RobotRaconteurError } from "../../src/Error.js";
import { MessageElement, MessageEntry } from "../../src/Message.js";
import { PipeHandle } from "../../src/PipeMember.js";
import { TypeDefinition } from "../../src/ServiceDefinition.js";
import { MemberContext, MemberDirection, unpackWirePacket, WireHandle } from "../../src/WireMember.js";

const DOUBLE: TypeDefinition = { type: "double" };

function fakeContext()
{
    const sent: MessageEntry[] = [];
    const requests: { type: number; name: string; elements?: MessageElement[] }[] = [];
    const ctx: MemberContext = {
        servicePath: "svc",
        pack: (name, _t, v) =>
        {
            if (typeof v !== "number") throw new RobotRaconteurError(12, "RobotRaconteur.DataTypeError", "bad");
            return new MessageElement(name, DataTypes.double_t, Float64Array.of(v));
        },
        unpack: (e) => (e.data as Float64Array)[0],
        request: async (type, name, elements) =>
        {
            requests.push({ type, name, elements });
            return new MessageEntry(type + 1, name);
        },
        send: (e) => sent.push(e),
        sendWait: async (e) =>
        {
            sent.push(e);
        }
    };
    return { ctx, sent, requests };
}

function pipePacket(number: number, value: number, ack = false): MessageElement
{
    const elements = [new MessageElement("packetnumber", DataTypes.uint32_t, Uint32Array.of(number)), new MessageElement("packet", DataTypes.double_t, Float64Array.of(value))];
    if (ack) elements.push(new MessageElement("requestack", DataTypes.uint32_t, Uint32Array.of(1)));
    return MessageElement.nested("7", DataTypes.dictionary_t, "", elements);
}

function pipe(opts: { direction?: MemberDirection; unreliable?: boolean } = {})
{
    const f = fakeContext();
    const closed: PipeHandle[] = [];
    return { ...f, closed, h: new PipeHandle(f.ctx, "p", 7, DOUBLE, opts.direction ?? "both", opts.unreliable ?? false, (x) => closed.push(x)) };
}

function wire(direction: MemberDirection = "both")
{
    const f = fakeContext();
    const closed: WireHandle[] = [];
    return { ...f, closed, h: new WireHandle(f.ctx, "w", DOUBLE, direction, (x) => closed.push(x)) };
}

function wirePacket(seconds: bigint, nanoseconds: number, value: number): MessageEntry
{
    const e = new MessageEntry(MessageEntryType.WirePacket, "w");
    e.addElement(MessageElement.nested("packettime", DataTypes.structure_t, "RobotRaconteur.TimeSpec", [new MessageElement("seconds", DataTypes.int64_t, BigInt64Array.of(seconds)), new MessageElement("nanoseconds", DataTypes.int32_t, Int32Array.of(nanoseconds))]));
    e.addElement(new MessageElement("packet", DataTypes.double_t, Float64Array.of(value)));
    return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pipe packets are numbered and carry the Core wire format", async () =>
{
    const { h, sent } = pipe();
    assert.equal(await h.sendPacket(1.5), 1);
    h.requestPacketAck = true;
    assert.equal(await h.sendPacket(2.5), 2);

    assert.equal(sent[0]!.entryType, MessageEntryType.PipePacket);
    assert.equal(sent[0]!.memberName, "p");
    const first = sent[0]!.elements[0]!;
    assert.equal(first.elementName, "7");
    assert.equal(first.elementType, DataTypes.dictionary_t);
    assert.deepEqual(first.castNested().elements.map((x) => x.elementName), ["packetnumber", "packet"]);
    assert.deepEqual(sent[1]!.elements[0]!.castNested().elements.map((x) => x.elementName), ["packetnumber", "packet", "requestack"]);
});

test("pipe packets received out of order are delivered in order", () =>
{
    const { h } = pipe();
    h.packetReceived(pipePacket(2, 20));
    assert.equal(h.available, 0);
    h.packetReceived(pipePacket(3, 30));
    h.packetReceived(pipePacket(1, 10));
    assert.equal(h.available, 3);
    assert.deepEqual([h.receivePacket(), h.receivePacket(), h.receivePacket()], [10, 20, 30]);
});

test("unreliable pipes deliver packets as they arrive and mark what they send", async () =>
{
    const { h, sent } = pipe({ unreliable: true });
    h.packetReceived(pipePacket(5, 50));
    h.packetReceived(pipePacket(2, 20));
    assert.deepEqual([h.receivePacket(), h.receivePacket()], [50, 20]);
    await h.sendPacket(1);
    assert.equal(sent[0]!.metaData, "unreliable\n");
});

test("packets are acknowledged when consumed, not when they arrive", async () =>
{
    const { h, sent } = pipe();
    h.packetReceived(pipePacket(1, 10, true));
    assert.equal(sent.length, 0);
    assert.equal(h.peekPacket(), 10);
    assert.equal(await h.receivePacketWait(0, true), 10);
    assert.equal(sent.length, 0, "peeking must not acknowledge");
    assert.equal(h.receivePacket(), 10);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.entryType, MessageEntryType.PipePacketRet);
    assert.equal(sent[0]!.elements[0]!.elementName, "7");
    assert.deepEqual(sent[0]!.elements[0]!.data, Uint32Array.of(1));
});

test("ignored packets are acknowledged immediately", () =>
{
    const { h, sent } = pipe();
    h.ignoreInValue = true;
    h.packetReceived(pipePacket(1, 10, true));
    assert.equal(h.available, 0);
    assert.equal(sent.length, 1);
});

test("a pipe closes instead of losing data when its queue overflows", () =>
{
    const original = console.error;
    console.error = () => undefined;
    try
    {
        const { h, closed, requests } = pipe();
        let called = 0;
        h.closeCallback = () =>
        {
            called++;
        };
        h.maxReceiveQueue = 2;
        h.packetReceived(pipePacket(1, 1));
        h.packetReceived(pipePacket(2, 2));
        assert.equal(h.closed, false);
        h.packetReceived(pipePacket(3, 3));
        assert.equal(h.closed, true);
        assert.equal(called, 1);
        assert.ok(closed.length >= 1);
        assert.equal(requests[0]!.type, MessageEntryType.PipeDisconnectReq);
        assert.deepEqual([h.receivePacket(), h.receivePacket(), h.receivePacket()], [1, 2, 3], "received packets can still be read");
        assert.throws(() => h.receivePacket(), /overflowed/);
    }
    finally
    {
        console.error = original;
    }
});

test("waiting for a packet resolves on arrival, timeout, or close", async () =>
{
    const { h } = pipe();
    const arriving = h.receivePacketWait(-1, false);
    h.packetReceived(pipePacket(1, 10));
    assert.equal(await arriving, 10);
    assert.equal(await h.tryReceivePacketWait(5, false), null);
    assert.equal(await h.tryReceivePacketWait(0, false), null);
    await assert.rejects(h.receivePacketWait(5, false), RobotRaconteurError);

    const waiting = h.tryReceivePacketWait(-1, false);
    h.remoteClosed();
    assert.equal(await waiting, null);
});

test("pipe packet listeners and failures", () =>
{
    const original = console.error;
    let reported = 0;
    console.error = () =>
    {
        reported++;
    };
    try
    {
        const { h } = pipe();
        let count = 0;
        h.packetListeners.add(() =>
        {
            throw new Error("failure");
        });
        h.packetListeners.add(() =>
        {
            count++;
        });
        h.ackListeners.add((_, n) =>
        {
            count += n;
        });
        h.packetReceived(pipePacket(1, 10));
        assert.equal(count, 1);
        assert.equal(reported, 1);
        h.ackReceived(5);
        assert.equal(count, 6);
    }
    finally
    {
        console.error = original;
    }
});

test("pipe direction is enforced", async () =>
{
    await assert.rejects(pipe({ direction: "readonly" }).h.sendPacket(1), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ReadOnlyMember");
    const w = pipe({ direction: "writeonly" });
    w.h.packetReceived(pipePacket(1, 10));
    assert.equal(w.h.available, 0);
    assert.throws(() => w.h.receivePacket(), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.WriteOnlyMember");
    assert.equal(await w.h.sendPacket(1), 1);
});

test("closing is requested once and only remote closes run the callback", async () =>
{
    const p = pipe();
    let pc = 0;
    p.h.closeCallback = () =>
    {
        pc++;
    };
    await p.h.close();
    await p.h.close();
    assert.equal(p.requests.length, 1);
    assert.deepEqual(p.requests[0]!.elements![0]!.data, Int32Array.of(7));
    assert.equal(pc, 0);

    const w = wire();
    let wc = 0;
    w.h.closeCallback = () =>
    {
        wc++;
    };
    w.h.remoteClosed();
    w.h.remoteClosed();
    assert.equal(wc, 1);
    assert.equal(w.requests.length, 0, "the service has already closed this wire");
});

test("wire values only replace older values", () =>
{
    const { h } = wire();
    let changes = 0;
    h.listeners.add(() =>
    {
        changes++;
    });
    h.packetReceived(wirePacket(10n, 500, 1));
    h.packetReceived(wirePacket(10n, 400, 2));
    h.packetReceived(wirePacket(9n, 999, 3));
    h.packetReceived(wirePacket(10n, 500, 4));
    assert.equal(h.getInValue().value, 1);
    assert.equal(changes, 1);
    h.packetReceived(wirePacket(11n, 0, 5));
    assert.equal(h.getInValue().value, 5);
    assert.deepEqual(h.getInValue().timestamp, { seconds: 11n, nanoseconds: 0 });
    assert.equal(changes, 2);
});

test("wire timestamps always increase even within one millisecond", () =>
{
    const { h, sent, ctx } = wire();
    for (let i = 0; i < 50; i++) h.setOutValue(i);
    const times = sent.map((e) => unpackWirePacket(ctx, DOUBLE, e.elements).timestamp);
    for (let i = 1; i < times.length; i++)
    {
        const a = times[i - 1]!;
        const b = times[i]!;
        assert.ok(b.seconds > a.seconds || (b.seconds === a.seconds && b.nanoseconds > a.nanoseconds), `packet ${i}`);
    }
    assert.equal(sent[0]!.entryType, MessageEntryType.WirePacket);
    assert.deepEqual(sent[0]!.elements.map((x) => x.elementName), ["packettime", "packet"]);
    assert.equal(h.getOutValue().value, 49);
});

test("wire value lifespans", async () =>
{
    const { h } = wire();
    h.packetReceived(wirePacket(1n, 0, 1));
    h.setOutValue(2);
    h.inValueLifespan = 5;
    h.outValueLifespan = 5;
    assert.ok(h.inValueValid && h.outValueValid);
    await sleep(20);
    assert.equal(h.inValueValid, false);
    assert.equal(h.outValueValid, false);
    assert.equal(h.tryGetInValue(), null);
    assert.equal(h.tryGetOutValue(), null);
    assert.throws(() => h.getInValue(), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ValueNotSet");
    h.inValueLifespan = -1;
    assert.equal(h.getInValue().value, 1);
});

test("waiting for wire values", async () =>
{
    const { h } = wire();
    assert.equal(await h.waitInValueValid(5), false);
    const waiting = h.waitInValueValid(-1);
    h.packetReceived(wirePacket(1n, 0, 1));
    assert.equal(await waiting, true);

    const out = h.waitOutValueValid(-1);
    h.setOutValue(1);
    assert.equal(await out, true);

    const w2 = wire();
    const closing = w2.h.waitInValueValid(-1);
    w2.h.remoteClosed();
    assert.equal(await closing, false);
});

test("wires can ignore incoming values", () =>
{
    const { h } = wire();
    h.ignoreInValue = true;
    h.packetReceived(wirePacket(1n, 0, 1));
    assert.equal(h.inValueValid, false);
});

test("wire direction is enforced", () =>
{
    const ro = wire("readonly");
    const read_only = (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ReadOnlyMember";
    assert.throws(() => ro.h.setOutValue(1), read_only);
    assert.throws(() => ro.h.getOutValue(), read_only);
    assert.throws(() => ro.h.tryGetOutValue(), read_only);

    const wo = wire("writeonly");
    const write_only = (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.WriteOnlyMember";
    assert.throws(() => wo.h.getInValue(), write_only);
    assert.throws(() => wo.h.tryGetInValue(), write_only);
});

function gatedQueue()
{
    const waiting: (() => void)[] = [];
    const q = new SendQueue(() => new Promise<void>((r) => waiting.push(r)), () => undefined, () => undefined);
    return {
        q,
        release: async () =>
        {
            waiting.shift()?.();
            await sleep(0);
        }
    };
}

function done()
{
    const r: { state: string; cb: (e?: Error) => void } = { state: "waiting", cb: () => undefined };
    r.cb = (e) =>
    {
        r.state = e ? "failed" : "sent";
    };
    return r;
}

test("a send completes only after the message is written", async () =>
{
    const { q, release } = gatedQueue();
    const a = done();
    const b = done();
    q.enqueue({ data: new Uint8Array(4), connection_test: false, done: a.cb });
    q.enqueue({ data: new Uint8Array(4), connection_test: false, done: b.cb });
    assert.equal(a.state, "waiting");
    await release();
    assert.equal(a.state, "sent");
    assert.equal(b.state, "waiting");
    await release();
    assert.equal(b.state, "sent");
});

test("a replaced wire packet completes without waiting", () =>
{
    const { q } = gatedQueue();
    q.enqueue({ data: new Uint8Array(4), connection_test: false });
    const a = done();
    q.enqueue({ data: new Uint8Array(4), wire_key: "w", connection_test: false, done: a.cb });
    assert.equal(a.state, "waiting");
    q.enqueue({ data: new Uint8Array(4), wire_key: "w", connection_test: false });
    assert.equal(a.state, "sent");
});

test("stopping fails sends in progress and waiting", () =>
{
    const { q } = gatedQueue();
    const a = done();
    const b = done();
    q.enqueue({ data: new Uint8Array(4), connection_test: false, done: a.cb });
    q.enqueue({ data: new Uint8Array(4), connection_test: false, done: b.cb });
    q.stop();
    assert.equal(a.state, "failed");
    assert.equal(b.state, "failed");
});
