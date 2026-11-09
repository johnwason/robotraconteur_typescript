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

import { GeneratorHandle, parseTypeDefinition, RobotRaconteurError, RobotRaconteurNode, ServiceStub, TypeDefinition, VarValue } from "../../src/index.js";
import { primitivesByName } from "../../src/DataTypes.js";
import { TypeContext } from "../../src/Pack.js";
import { ServiceDefinition } from "../../src/ServiceDefinition.js";
import { assert } from "./check.js";
import * as generated from "./ServiceTestClientGenerated.js";
import * as client2 from "./ServiceTestClient2.js";
import * as client3 from "./ServiceTestClient3.js";

// Replays the operations recorded from the Core Python test client, and the remaining client tests
// from Core and RobotRaconteurWeb that apply to the implemented members. Runs in Node and browsers.

// Convert a recorded Python value to the JavaScript representation for the declared type
function decode(v: any, t: TypeDefinition, scope: ServiceDefinition, types: TypeContext): unknown
{
    if (t.container)
    {
        if (v === null) return null;
        const { container, ...item } = t;
        if (container === "list") return (v.$list as unknown[]).map((x) => decode(x, item, scope, types));
        return new Map((v.$map as [string | number, unknown][]).map(([k, x]) => [k, decode(x, item, scope, types)]));
    }
    if (t.type === "varvalue")
    {
        if (v === null) return null;
        return new VarValue(decode(v.$var.data, parseTypeDefinition(v.$var.type), scope, types), v.$var.type);
    }
    if (t.type === "string") return v;

    const p = primitivesByName.get(t.type);
    if (p) return decodeNumeric(v, t, p);

    const r = types.resolve(t.type, scope);
    if (r.kind === "enum") return Number(v.$i ?? v);
    if (r.kind === "struct")
    {
        if (v === null) return null;
        const o: Record<string, unknown> = {};
        for (const m of r.entry!.members) o[m.name] = decode(v.$struct[m.name] ?? null, m.type!, r.def, types);
        return o;
    }

    const items = (v.$sa.items as Record<string, unknown>[]).map((x) =>
    {
        const o: Record<string, unknown> = {};
        for (const m of r.entry!.members) o[m.name] = decode(x[m.name], m.type!, r.def, types);
        return o;
    });
    if (t.array === "multidimarray") return { dims: Uint32Array.from(v.$sa.shape as number[]), array: items };
    if (t.array) return items;
    assert.equal(items.length, 1);
    return items[0];
}

function numericItems(data: unknown[], p: NonNullable<ReturnType<typeof primitivesByName.get>>): unknown
{
    if (p.ctor === (BigInt64Array as unknown) || p.ctor === (BigUint64Array as unknown)) return p.ctor.from(data.map((x) => BigInt(x as string)));
    return p.ctor.from(data.map((x) => (typeof x === "boolean" ? (x ? 1 : 0) : Number(x))));
}

function decodeNumeric(v: any, t: TypeDefinition, p: NonNullable<ReturnType<typeof primitivesByName.get>>): unknown
{
    if (t.array === "multidimarray") return { dims: Uint32Array.from(v.$nd.shape as number[]), array: numericItems(v.$nd.data, p) };
    if (t.array)
    {
        if (v.$list) return numericItems((v.$list as any[]).flatMap((x) => (x !== null && x.$c ? x.$c : [x.$i ?? x])), p);
        return numericItems(v.$nd.data, p);
    }
    if (v?.$nd)
    {
        const a = numericItems(v.$nd.data, p) as ArrayLike<unknown>;
        return decodeScalar(p.stride === 2 ? { $c: [a[0], a[1]] } : a[0], p);
    }
    return decodeScalar(v, p);
}

function decodeScalar(v: any, p: NonNullable<ReturnType<typeof primitivesByName.get>>): unknown
{
    if (p.stride === 2)
    {
        if (v?.$c) return { real: v.$c[0], imag: v.$c[1] };
        return { real: Number(v.$i ?? v), imag: 0 };
    }
    const n = v?.$i ?? v;
    if (p.ctor === (BigInt64Array as unknown) || p.ctor === (BigUint64Array as unknown)) return BigInt(n);
    if (p.name === "bool") return n === true || n === 1 || n === 1n || n === "1";
    return Number(n);
}

function assertClose(actual: unknown, expected: unknown, where: string): void
{
    if (typeof actual === "number" && typeof expected === "number")
    {
        if (actual !== expected) assert.ok(Math.abs(actual - expected) <= 1e-5 * Math.max(Math.abs(actual), Math.abs(expected)), `${where}: ${actual} != ${expected}`);
        return;
    }
    if (ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected))
    {
        const a = actual as unknown as ArrayLike<unknown>;
        const b = expected as unknown as ArrayLike<unknown>;
        assert.equal(a.length, b.length, where);
        assert.equal(actual.constructor, expected.constructor, where);
        for (let i = 0; i < a.length; i++) assertClose(a[i], b[i], `${where}[${i}]`);
        return;
    }
    if (actual instanceof Map && expected instanceof Map)
    {
        assert.deepEqual([...actual.keys()], [...expected.keys()], where);
        for (const [k, x] of expected) assertClose(actual.get(k), x, `${where}{${k}}`);
        return;
    }
    if (Array.isArray(actual) && Array.isArray(expected))
    {
        assert.equal(actual.length, expected.length, where);
        actual.forEach((x, i) => assertClose(x, expected[i], `${where}[${i}]`));
        return;
    }
    if (actual instanceof VarValue && expected instanceof VarValue)
    {
        assert.equal(actual.type, expected.type, where);
        assertClose(actual.value, expected.value, where);
        return;
    }
    if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null)
    {
        assert.deepEqual(Object.keys(actual), Object.keys(expected), where);
        for (const k of Object.keys(expected)) assertClose((actual as any)[k], (expected as any)[k], `${where}.${k}`);
        return;
    }
    assert.strictEqual(actual, expected, where);
}

interface Op
{
    path: (string | number)[][];
    op: "get" | "set" | "call";
    name: string;
    args?: unknown[];
    value?: unknown;
    error?: string;
}

async function resolvePath(root_obj: ServiceStub, path: Op["path"]): Promise<ServiceStub>
{
    let o = root_obj;
    for (const [name, index] of path) o = await o.getObjRef(name as string, index);
    return o;
}

async function replay(node: RobotRaconteurNode, url: (s: string) => string, vectors: Vectors, service: string, name: string): Promise<void>
{
    const r = await node.connectService(url(service));
    try
    {
        const ops = vectors[service]![name] as Op[];
        assert.ok(ops.length > 0, "No recorded operations");
        for (const op of ops)
        {
            let o: ServiceStub;
            try
            {
                o = await resolvePath(r, op.path);
            }
            catch (e)
            {
                if (op.error !== undefined) continue; // The reference client also failed on this stale path
                throw e;
            }
            const types = o.context.types;
            const scope = o.context.serviceDefForType(o.objectType);
            const where = `${name} ${op.op} ${JSON.stringify(op.path)}.${op.name}`;
            const m = o.context.findMember(o.objectType, op.name);
            if (!m)
            {
                if (op.error !== undefined) continue; // Stale reference to an object whose type has since changed
                throw new Error(`${where}: no such member`);
            }

            let run: () => Promise<unknown>;
            let expected_type: TypeDefinition | undefined = m.type;
            if (op.op === "get")
            {
                run = () => o.getProperty(op.name);
            }
            else if (op.op === "set")
            {
                const value = decode(op.value, m.type!, scope, types);
                run = () => o.setProperty(op.name, value);
                expected_type = undefined;
            }
            else
            {
                const args = m.parameters!.map((p, i) => decode(op.args![i], p.type, scope, types));
                run = () => o.callFunction(op.name, args);
                if (m.type!.type === "void") expected_type = undefined;
            }

            if (op.error !== undefined)
            {
                await assert.rejects(run, (e: RobotRaconteurError) =>
                {
                    assert.ok(e instanceof RobotRaconteurError, where);
                    if (op.error!.includes(".")) assert.equal(e.errorName, op.error, where);
                    return true;
                }, where);
                continue;
            }

            const actual = await run().catch((e) =>
            {
                throw new Error(`${where}: ${(e as Error).message}`);
            });
            if (expected_type) assertClose(actual, decode(op.value, expected_type, scope, types), where);
        }
    }
    finally
    {
        await node.disconnectService(r);
    }
}

export type Vectors = Record<string, Record<string, unknown[]>>;

export interface ClientTest
{
    name: string;
    run: () => Promise<void>;
}

const S1 = "RobotRaconteurTestService";
const S2 = "RobotRaconteurTestService2";
const S3 = "RobotRaconteurTestService3";
const AUTH = "RobotRaconteurTestService_auth";

function errorNamed(name: string): (e: RobotRaconteurError) => boolean
{
    return (e) =>
    {
        assert.equal(e.errorName, name);
        return true;
    };
}

async function drain(r: ServiceStub, g: GeneratorHandle): Promise<unknown[]>
{
    const out: unknown[] = [];
    for (;;)
    {
        try
        {
            out.push(await r.callFunctionGenNext(g));
        }
        catch (e)
        {
            assert.ok((e as RobotRaconteurError).isStopIteration, String(e));
            return out;
        }
    }
}

function password(p: string): Map<string, unknown>
{
    return new Map([["password", new VarValue(p, "string")]]);
}

/** Build the list of client tests for a server listening on the given port */
export function clientTests(node: RobotRaconteurNode, port: number, vectors: Vectors): ClientTest[]
{
    const url = (s: string) => `rr+ws://localhost:${port}?service=${s}`;

    const withClient = (service: string, fn: (r: ServiceStub) => Promise<void>) => async () =>
    {
        const r = await node.connectService(url(service));
        try
        {
            await fn(r);
        }
        finally
        {
            await node.disconnectService(r);
        }
    };

    const tests: ClientTest[] = [];
    const add = (name: string, run: () => Promise<void>) => tests.push({ name, run });

    for (const [service, group] of Object.entries(vectors))
    {
        for (const name of Object.keys(group))
        {
            add(`replay ${service === S1 ? "TestService1" : "TestService3"} ${name}`, () => replay(node, url, vectors, service, name));
        }
    }

    // The Core Python test clients, by method name. Methods for members this client does not
    // implement (events, pipes, callbacks, wire connections, memories, and locks) are not ported.
    add("ServiceTestClient TestProperties", withClient(S1, generated.TestProperties));
    add("ServiceTestClient TestFunctions", withClient(S1, generated.TestFunctions));
    add("ServiceTestClient TestObjRefs", withClient(S1, generated.TestObjRefs));
    add("ServiceTestClient2 TestWirePeekPoke", withClient(S2, client2.TestWirePeekPoke));
    add("ServiceTestClient2 TestEnums", withClient(S2, client2.TestEnums));
    add("ServiceTestClient2 TestPods", withClient(S2, client2.TestPods));
    add("ServiceTestClient2 TestGenerators", withClient(S2, client2.TestGenerators));
    add("ServiceTestClient2 TestNamedArrays", withClient(S2, client2.TestNamedArrays));
    add("ServiceTestClient2 TestComplex", withClient(S2, generated.TestComplex));
    add("ServiceTestClient2 TestNoLock", withClient(S2, client2.TestNoLock));
    add("ServiceTestClient2 TestBools", withClient(S2, generated.TestBools));
    add("ServiceTestClient2 TestExceptionParams", withClient(S2, client2.TestExceptionParams));
    add("ServiceTestClient3 TestProperties", withClient(S3, client3.TestProperties));
    add("ServiceTestClient3 TestFunctions", withClient(S3, client3.TestFunctions));

    add("service information", async () =>
    {
        const r = await node.connectService(url(S1));
        assert.equal(r.objectType, "com.robotraconteur.testing.TestService1.testroot");
        assert.ok(r.context.types.defs.has("com.robotraconteur.testing.TestService2"));
        await node.disconnectService(r);
        await assert.rejects(r.getProperty("d1"), RobotRaconteurError);
    });

    add("attributes", withClient(S1, async (r) =>
    {
        const a = r.context.attributes as Map<string, VarValue>;
        assert.equal(a.size, 2);
        assert.equal(a.get("test")!.value, "This is a test attribute");
        assert.deepEqual(a.get("test2")!.value, Int32Array.of(42));
    }));

    add("object types through implemented interface", async () =>
    {
        const base = "com.robotraconteur.testing.TestService2.baseobj";
        const r = await node.connectService(url(S1), undefined, undefined, base);
        assert.equal(r.objectType, base);
        await r.setProperty("d1", 3.456);
        assert.equal(await r.getProperty("d1"), 12.345);
        await node.disconnectService(r);
        await assert.rejects(node.connectService(url(S1), undefined, undefined, "com.robotraconteur.testing.TestService2.subobj"), RobotRaconteurError);
    });

    add("authentication", async () =>
    {
        for (const [user, pass] of [["testuser1", "testpass1"], ["testuser2", "testpass2"]] as const)
        {
            const r = await node.connectService(url(AUTH), user, password(pass));
            await r.callFunction("func3", [2.2, 3.3]);
            await node.disconnectService(r);
        }
        await assert.rejects(async () =>
        {
            const r = await node.connectService(url(AUTH), "testuser2", password("testpass1"));
            await r.callFunction("func3", [2.2, 3.3]);
        }, RobotRaconteurError);
        await assert.rejects(async () =>
        {
            const r = await node.connectService(url(AUTH));
            await r.callFunction("func3", [2.2, 3.3]);
        }, RobotRaconteurError);
    });

    add("large messages are fragmented and reassembled", withClient(S1, async (r) =>
    {
        const huge = (await r.getProperty("i32_huge")) as Int32Array;
        assert.equal(huge.length, 2621440);
        assert.ok(huge.every((x, i) => x === i));
        await r.setProperty("i32_huge", huge.map((x) => -x));
    }));

    add("released object references fail", withClient(S1, async (r) =>
    {
        await r.callFunction("o6_op", [0]);
        const o = await r.getObjRef("o6");
        assert.equal(o.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await r.callFunction("o6_op", [1]);
        await assert.rejects(o.setProperty("d1", [0]), errorNamed("RobotRaconteur.ServiceError"));
        const o2 = await r.getObjRef("o6");
        assert.equal(o2.objectType, "com.robotraconteur.testing.TestService1.sub2");
        await o2.setProperty("data", "Hello world!");
    }));

    add("object reference indexes with special characters", withClient(S1, async (r) =>
    {
        for (const index of ["plain", "with.dots-and_more", "sp ace/slash%?#[]", "café 😁"])
        {
            const o = await r.getObjRef("o4", index);
            assert.equal(await o.getProperty("s_ind"), index);
            assert.equal(o, await r.getObjRef("o4", index), "object reference should be cached");
        }
        const o = await r.getObjRef("o3", -5);
        assert.equal(await o.getProperty("i_ind"), -5);
    }));

    add("concurrent requests are matched to their responses", withClient(S1, async (r) =>
    {
        const ops: Promise<void>[] = [];
        for (let i = 0; i < 200; i++)
        {
            const d1 = i % 3 === 0;
            ops.push(d1 ? r.getProperty("d1").then((v) => assert.equal(v, 12.345)) : r.getProperty("str1").then((v) => assert.equal(typeof v, "string")));
        }
        await Promise.all(ops);
    }));

    add("disconnecting fails outstanding and later requests", withClient(S1, async (r) =>
    {
        const c = await node.connectService(url(S1));
        const pending = c.getProperty("i32_huge").then(() => "done", (e: unknown) => ((e as Error) instanceof RobotRaconteurError ? "error" : "unexpected"));
        await node.disconnectService(c);
        const outcome = await pending;
        assert.ok(outcome === "done" || outcome === "error", String(outcome));
        await assert.rejects(c.getProperty("d1"), errorNamed("RobotRaconteur.ConnectionError"));
        assert.equal(await r.getProperty("d1"), 12.345, "other clients are not affected");
    }));

    add("plain and differently typed arrays reach the service as the declared type", withClient(S1, async (r) =>
    {
        const o = await r.getObjRef("o1");
        await o.setProperty("d1", [1.5, 2.5]);
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(1.5, 2.5));
        await o.setProperty("d1", Int32Array.of(3, -4));
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(3, -4));
        await o.setProperty("d2", { dims: [2, 1], array: Uint8Array.of(5, 6) });
        assert.deepEqual(await o.getProperty("d2"), { dims: Uint32Array.of(2, 1), array: Float64Array.of(5, 6) });

        await assert.rejects(o.setProperty("d1", 5), errorNamed("RobotRaconteur.DataTypeError"));
        await assert.rejects(o.setProperty("d1", ["a"]), RobotRaconteurError);
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(3, -4));
    }));

    add("local misuse is reported before sending", withClient(S1, async (r) =>
    {
        await assert.rejects(r.getProperty("not_a_member"), RobotRaconteurError);
        await assert.rejects(r.callFunction("func3", [1]), RobotRaconteurError);
        await assert.rejects(r.callFunction("func3", { d1: 1 }), RobotRaconteurError);
        await assert.rejects(r.getProperty("func3"), RobotRaconteurError);
        await assert.rejects(r.getObjRef("d1"), RobotRaconteurError);
        await assert.rejects(r.peekWireInValue("d1"), RobotRaconteurError);
    }));

    add("connection failures are reported", async () =>
    {
        await assert.rejects(node.connectService("rr+ws://localhost:1?service=x"), RobotRaconteurError);
        await assert.rejects(node.connectService("rr+pipe://x?service=x"), RobotRaconteurError);
        await assert.rejects(node.connectService(url("no_such_service")), RobotRaconteurError);
        await assert.rejects(node.connectService(`rr+ws://localhost:${port}?service=${S1}&nodename=wrong_node`), RobotRaconteurError);
    });

    return tests;
}
