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
import { errorNamed, sleep } from "./TestUtil.js";

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
