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

import { RobotRaconteurError, ServiceStub } from "../../src/index.js";
import { assert } from "./check.js";
import { ca, errorNamed, md, sleep } from "./TestUtil.js";

// Port of the event and callback tests in the Core Python ServiceTestClient.py, followed by
// additional tests. The other methods of that client are in ServiceTestClientGenerated.ts.

function eventOccurs(start: (resolve: () => void) => void, timeout_ms: number, what: string): Promise<void>
{
    return new Promise<void>((resolve, reject) =>
    {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeout_ms);
        start(() =>
        {
            clearTimeout(timer);
            resolve();
        });
    });
}

export async function TestEvents(r: ServiceStub): Promise<void>
{
    let ev1_listener: () => void = () => undefined;
    let ev2_listener: (d: number, s: { mydat: Float64Array }) => void = () => undefined;

    const ev1 = eventOccurs((done) =>
    {
        ev1_listener = done;
        r.addEventListener("ev1", ev1_listener);
    }, 5000, "ev1");
    const ev2 = eventOccurs((done) =>
    {
        ev2_listener = (d, s) =>
        {
            if (d === 27.3 && s.mydat[0] === 98.23) done();
        };
        r.addEventListener("ev2", ev2_listener);
    }, 5000, "ev2");

    try
    {
        await r.callFunction("func1");
        await r.callFunction("func2", [27.3, 98.23]);
        await Promise.all([ev1, ev2]);
    }
    finally
    {
        r.removeEventListener("ev1", ev1_listener);
        r.removeEventListener("ev2", ev2_listener);
    }
}

export async function TestCallbacks(r: ServiceStub): Promise<void>
{
    let cb1_called = false;
    let cb2_called = false;
    let cb3_called = false;
    let cb4_called = false;
    let cb5_called = false;

    r.setCallback("cb1", () =>
    {
        cb1_called = true;
    });
    r.setCallback("cb2", (d1: number, d2: number) =>
    {
        assert.ok(d1 === 739.2 && d2 === 0.392, "Invalid callback parameters");
        cb2_called = true;
    });
    r.setCallback("cb3", (d1: number, d2: number) =>
    {
        cb3_called = true;
        return d1 + d2 + 3.14;
    });
    r.setCallback("cb_meaning_of_life", () =>
    {
        cb4_called = true;
        return 42;
    });
    r.setCallback("cb_errtest", () =>
    {
        cb5_called = true;
        throw new Error("This is a test");
    });

    await r.callFunction("test_callbacks");

    assert.ok(cb1_called, "cb1 was not called");
    assert.ok(cb2_called, "cb2 was not called");
    assert.ok(cb3_called, "cb3 was not called");
    assert.ok(cb4_called, "cb_meaning_of_life was not called");
    assert.ok(cb5_called, "cb_errtest was not called");
}

function signal(): { promise: Promise<void>; set: () => void }
{
    let set: () => void = () => undefined;
    const promise = new Promise<void>((resolve) =>
    {
        set = resolve;
    });
    return { promise, set };
}

function within(p: Promise<void>, ms: number, what: string): Promise<void>
{
    return Promise.race([p, sleep(ms).then(() =>
    {
        throw new Error("Timed out waiting for " + what);
    })]);
}

export async function TestPipes(r: ServiceStub): Promise<void>
{
    const ee1 = signal();
    const ee2 = signal();
    const ee3 = signal();
    const e1 = await r.connectPipe("p1", -1);
    const e2 = await r.connectPipe("p1", 3432);
    const e3 = await r.connectPipe("p2", -1);

    r.setPipeRequestPacketAck(e1, true);
    r.addPipePacketReceivedListener(e1, ee1.set);
    r.addPipePacketAckListener(e1, () => undefined);
    r.addPipePacketReceivedListener(e2, ee2.set);
    r.addPipePacketReceivedListener(e3, ee3.set);

    await r.sendPipePacket(e1, [1, 2, 3, 4]);
    await r.sendPipePacket(e1, [5, 6, 7, 8]);
    await r.sendPipePacket(e1, [-1, -2, -3, -5.32]);
    await r.sendPipePacket(e2, [3.21]);
    await r.sendPipePacket(e2, [4.72]);
    await r.sendPipePacket(e2, [72.34]);
    await r.sendPipePacket(e3, { mydat: [738.29] });
    await r.sendPipePacket(e3, { mydat: [89.83] });

    await within(ee1.promise, 5000, "e1 packet");
    await within(ee2.promise, 5000, "e2 packet");
    await within(ee3.promise, 5000, "e3 packet");

    ca(r.receivePipePacket(e1), [1, 2, 3, 4]);
    ca(await r.receivePipePacketWait(e1, 1000), [5, 6, 7, 8]);
    ca(await r.receivePipePacketWait(e1, 1000), [-1, -2, -3, -5.32]);
    ca(r.receivePipePacket(e2), [3.21]);
    ca(await r.receivePipePacketWait(e2, 1000), [4.72]);
    ca(await r.receivePipePacketWait(e2, 1000), [72.34]);
    ca((r.receivePipePacket(e3) as { mydat: Float64Array }).mydat, [738.29]);
    ca(((await r.receivePipePacketWait(e3, 1000)) as { mydat: Float64Array }).mydat, [89.83]);
    await sleep(500);

    await r.callFunction("pipe_check_error");

    assert.equal(r.getPipeDirection("p1"), "both");
    assert.equal(e1.direction, "both");

    await r.closePipe(e1);
    await r.closePipe(e2);
    await r.closePipe(e3);
}

export async function TestWires(r: ServiceStub): Promise<void>
{
    let w1_called = false;
    let w2_called = false;
    let w3_called = false;
    const w1 = await r.connectWire("w1");
    const w2 = await r.connectWire("w2");
    const w3 = await r.connectWire("w3");

    r.setWireInValueLifespan(w1, 10000);

    r.addWireValueChangedListener(w1, () =>
    {
        w1_called = true;
    });
    r.addWireValueChangedListener(w2, () =>
    {
        w2_called = true;
    });
    r.addWireValueChangedListener(w3, () =>
    {
        w3_called = true;
    });

    r.setWireOutValue(w1, [0]);
    r.setWireOutValue(w2, { mydat: [0] });
    r.setWireOutValue(w3, md(Int32Array.of(0), [1, 1]));

    const a1 = [-2.377683e+02, -6.760080e-08, 4.191315e-18, -4.621977e+07, -1.570323e+03, -4.163378e+03, -2.506701e+13, -4.755701e+18, -1.972380e-19, 1.791593e-11];
    r.setWireOutValue(w1, a1);
    const a2 = [-1.014645e-21, 4.743740e+11, 5.804886e-04, 2.963852e-20, 4.277621e-21, -1.168151e+13, -2.638708e-18, -5.123312e+14, 1.261123e-05, 2.552626e-10];
    r.setWireOutValue(w2, { mydat: a2 });
    const a3 = md(Int32Array.of(2058500854, -611248192, 197490486, -517717939, -513450368, 296469979, 645365194, 2043654604, -1672941174, 710030901), [2, 5]);
    r.setWireOutValue(w3, a3);

    await sleep(500);

    ca(r.getWireInValue(w1).value, a1);
    ca((r.getWireInValue(w2).value as { mydat: Float64Array }).mydat, a2);
    ca(r.getWireInValue(w3).value, a3);

    assert.ok(w1_called, "w1 value changed was not called");
    assert.ok(w2_called, "w2 value changed was not called");
    assert.ok(w3_called, "w3 value changed was not called");

    ca(r.tryGetWireInValue(w1)!.value, a1);
    ca(r.tryGetWireOutValue(w1)!.value, a1);

    assert.equal(r.getWireDirection("w1"), "both");
    assert.equal(w1.direction, "both");

    r.setWireInValueLifespan(w1, 1);
    await sleep(10);
    await assert.rejects(async () => r.getWireInValue(w1), errorNamed("RobotRaconteur.ValueNotSet"));

    await r.closeWire(w1);
    await r.closeWire(w2);
    await r.closeWire(w3);
}

export async function BroadcastWireStreaming(r: ServiceStub): Promise<void>
{
    const w = await r.connectWire("broadcastwire");
    let changes = 0;
    r.addWireValueChangedListener(w, () =>
    {
        changes++;
    });
    assert.ok(await r.waitWireInValueValid(w, 5000), "no value received");
    const v = r.getWireInValue(w);
    assert.ok(typeof v.value === "number" && v.value >= 0 && v.value < 100, String(v.value));
    assert.ok(v.timestamp.seconds > 0n);
    await sleep(300);
    assert.ok(changes > 0, "value did not update");
    await r.closeWire(w);
}

export async function BroadcastPipeFlowControl(r: ServiceStub): Promise<void>
{
    // The service sends 100 packets every 25 ms with a backlog of 3 unacknowledged packets
    const p = await r.connectPipe("broadcastpipe");
    await sleep(1000);
    const waiting = r.getPipePacketsAvailable(p);
    assert.ok(waiting > 0, "no packets arrived");
    assert.ok(waiting <= 8, `the service should stop at its backlog, but ${waiting} packets arrived`);

    // Consuming the packets acknowledges them, which lets the service continue
    for (let i = 0; i < waiting; i++) r.receivePipePacket(p);
    await within(new Promise<void>((resolve) => r.addPipePacketReceivedListener(p, () => resolve())), 3000, "more packets");
    await r.closePipe(p);
}

export async function WireAndPipeMisuse(r: ServiceStub): Promise<void>
{
    const not_found = errorNamed("RobotRaconteur.MemberNotFound");
    await assert.rejects(r.connectWire("d1"), not_found);
    await assert.rejects(r.connectPipe("w1"), not_found);
    await assert.rejects(r.connectPipe("not_a_member"), not_found);

    const w = await r.connectWire("w1");
    await assert.rejects(r.connectWire("w1"), errorNamed("RobotRaconteur.InvalidOperation"));
    await assert.rejects(async () => r.setWireOutValue(w, "not an array"), RobotRaconteurError);
    assert.equal(r.isWireInValueValid(w), false);
    assert.equal(await r.waitWireInValueValid(w, 10), false);
    await assert.rejects(async () => r.getWireInValue(w), errorNamed("RobotRaconteur.ValueNotSet"));
    assert.equal(r.tryGetWireInValue(w), null);
    await r.closeWire(w);
    await assert.rejects(async () => r.setWireOutValue(w, [1]), errorNamed("RobotRaconteur.InvalidOperation"));

    const again = await r.connectWire("w1");
    await r.closeWire(again);

    const p = await r.connectPipe("p1");
    await assert.rejects(async () => r.receivePipePacket(p), errorNamed("RobotRaconteur.InvalidOperation"));
    assert.equal(await r.tryReceivePipePacketWait(p, 10), null);
    await assert.rejects(r.sendPipePacket(p, "not an array"), RobotRaconteurError);
    await r.closePipe(p);
    await assert.rejects(r.sendPipePacket(p, [1]), errorNamed("RobotRaconteur.InvalidOperation"));
}

function setStandardCallbacks(r: ServiceStub): void
{
    r.setCallback("cb1", () => undefined);
    r.setCallback("cb2", () => undefined);
    r.setCallback("cb3", (d1: number, d2: number) => d1 + d2 + 3.14);
    r.setCallback("cb_meaning_of_life", () => 42);
    r.setCallback("cb_errtest", () =>
    {
        throw new Error("This is a test");
    });
}

export async function EventListenerRemoval(r: ServiceStub): Promise<void>
{
    let count = 0;
    const listener = () =>
    {
        count++;
    };
    r.addEventListener("ev1", listener);
    r.addEventListener("ev1", listener);
    r.removeEventListener("ev1", listener);

    await r.callFunction("func1");
    await sleep(1500);
    assert.equal(count, 0, "listener was called after removal");
}

export async function EventHandlerErrors(r: ServiceStub): Promise<void>
{
    const original = console.error;
    let reported = 0;
    console.error = () =>
    {
        reported++;
    };
    try
    {
        let second_called = false;
        const first = () =>
        {
            throw new Error("Handler failure");
        };
        const second = () =>
        {
            second_called = true;
        };
        const third = async () =>
        {
            throw new Error("Asynchronous handler failure");
        };
        r.addEventListener("ev1", first);
        r.addEventListener("ev1", second);
        r.addEventListener("ev1", third);

        await r.callFunction("func1");
        await sleep(1500);
        assert.ok(second_called, "other handlers should still run");
        assert.equal(reported, 2, "both handler failures should be reported");
        assert.equal(await r.getProperty("d1"), 12.345, "the connection should still work");
    }
    finally
    {
        console.error = original;
    }
}

export async function AsyncCallbacks(r: ServiceStub): Promise<void>
{
    setStandardCallbacks(r);
    r.setCallback("cb3", async (d1: number, d2: number) =>
    {
        await sleep(50);
        return d1 + d2 + 3.14;
    });
    r.setCallback("cb_errtest", async () =>
    {
        await sleep(10);
        throw new RobotRaconteurError(17, "RobotRaconteur.InvalidOperation", "Asynchronous failure");
    });
    await r.callFunction("test_callbacks");
}

export async function CallbackFailures(r: ServiceStub): Promise<void>
{
    // The service expects the callback calls to succeed, so a failure reaches the caller
    await assert.rejects(r.callFunction("test_callbacks"), RobotRaconteurError, "a callback that is not set must fail");

    setStandardCallbacks(r);
    r.setCallback("cb3", () => "not a number");
    await assert.rejects(r.callFunction("test_callbacks"), RobotRaconteurError, "an invalid return value must fail");

    setStandardCallbacks(r);
    r.setCallback("cb1", null);
    await assert.rejects(r.callFunction("test_callbacks"), RobotRaconteurError, "a cleared callback must fail");

    setStandardCallbacks(r);
    await r.callFunction("test_callbacks");
}

export async function EventAndCallbackMisuse(r: ServiceStub): Promise<void>
{
    const not_found = errorNamed("RobotRaconteur.MemberNotFound");
    await assert.rejects(async () => r.addEventListener("d1", () => undefined), not_found);
    await assert.rejects(async () => r.addEventListener("not_a_member", () => undefined), not_found);
    await assert.rejects(async () => r.removeEventListener("cb1", () => undefined), not_found);
    await assert.rejects(async () => r.setCallback("ev1", () => undefined), not_found);
    await assert.rejects(async () => r.setCallback("not_a_member", null), not_found);
}
