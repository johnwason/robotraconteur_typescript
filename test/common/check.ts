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

// Minimal assertions so that the shared client tests can also run in a browser page

function describe(v: unknown): string
{
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "object" && v !== null) return Object.prototype.toString.call(v);
    return String(v);
}

function deepEqual(actual: unknown, expected: unknown, where: string): void
{
    if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null)
    {
        if (!Object.is(actual, expected)) throw new Error(`${where}: ${describe(actual)} != ${describe(expected)}`);
        return;
    }
    if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) throw new Error(`${where}: different types`);
    if (actual instanceof Map)
    {
        const e = expected as Map<unknown, unknown>;
        if (actual.size !== e.size) throw new Error(`${where}: map size ${actual.size} != ${e.size}`);
        for (const [k, v] of e)
        {
            if (!actual.has(k)) throw new Error(`${where}: missing key ${describe(k)}`);
            deepEqual(actual.get(k), v, `${where}{${String(k)}}`);
        }
        return;
    }
    if (ArrayBuffer.isView(actual) || Array.isArray(actual))
    {
        const a = actual as unknown as ArrayLike<unknown>;
        const e = expected as unknown as ArrayLike<unknown>;
        if (a.length !== e.length) throw new Error(`${where}: length ${a.length} != ${e.length}`);
        for (let i = 0; i < a.length; i++) deepEqual(a[i], e[i], `${where}[${i}]`);
        return;
    }
    const ka = Object.keys(actual);
    const ke = Object.keys(expected);
    if (ka.length !== ke.length || ke.some((k) => !ka.includes(k))) throw new Error(`${where}: fields ${ka.join()} != ${ke.join()}`);
    for (const k of ke) deepEqual((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${where}.${k}`);
}

type Matcher = (new (...args: never[]) => Error) | ((e: never) => boolean | void);

interface Assert
{
    ok(v: unknown, message?: string): asserts v;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(op: Promise<unknown> | (() => Promise<unknown>), matcher: Matcher, message?: string): Promise<void>;
}

export const assert: Assert = {
    ok(v: unknown, message = "expected truthy value"): asserts v
    {
        if (!v) throw new Error(message);
    },
    equal(actual: unknown, expected: unknown, message = "values differ"): void
    {
        if (!Object.is(actual, expected)) throw new Error(`${message}: ${describe(actual)} != ${describe(expected)}`);
    },
    strictEqual(actual: unknown, expected: unknown, message = "values differ"): void
    {
        assert.equal(actual, expected, message);
    },
    deepEqual(actual: unknown, expected: unknown, message = "value"): void
    {
        deepEqual(actual, expected, message);
    },
    async rejects(op: Promise<unknown> | (() => Promise<unknown>), matcher: Matcher, message = "expected rejection"): Promise<void>
    {
        let error: unknown;
        try
        {
            await (typeof op === "function" ? op() : op);
        }
        catch (e)
        {
            error = e;
        }
        if (error === undefined) throw new Error(message);
        if (typeof matcher === "function" && matcher.prototype instanceof Error)
        {
            if (!(error instanceof (matcher as new () => Error))) throw new Error(`${message}: unexpected ${String(error)}`);
            return;
        }
        if ((matcher as (e: unknown) => boolean | void)(error) === false) throw new Error(`${message}: unexpected ${String(error)}`);
    }
};
