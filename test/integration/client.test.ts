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
import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BrowserWebSocketTransport, GeneratorHandle, parseTypeDefinition, RobotRaconteurError, RobotRaconteurNode, ServiceStub, TypeDefinition, VarValue } from "../../src/index.js";
import { primitivesByName } from "../../src/DataTypes.js";
import { TypeContext } from "../../src/Pack.js";
import { ServiceDefinition } from "../../src/ServiceDefinition.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const vectors = JSON.parse(readFileSync(join(root, "test/fixtures/recorded_vectors.json"), "utf8"));
const PORT = 22223;
const url = (s: string) => `rr+ws://localhost:${PORT}?service=${s}`;

let server: ChildProcess;
const node = new RobotRaconteurNode();
node.requestTimeout = 30000;
node.registerTransport(new BrowserWebSocketTransport(node));

before(async () =>
{
    const core = process.env.RR_CORE_TEST;
    assert.ok(core, "RR_CORE_TEST must point at the Core test directory");
    server = spawn("python3", ["-u", "-m", "RobotRaconteurTest.test_server"], {
        cwd: join(core, "python"),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["pipe", "pipe", "inherit"]
    });
    await new Promise<void>((resolve, reject) =>
    {
        server.stdout!.on("data", (d: Buffer) =>
        {
            if (d.toString().includes("Server ready")) resolve();
        });
        server.on("exit", () => reject(new Error("Test server exited")));
    });
}, { timeout: 60000 });

after(async () =>
{
    await node.shutdown();
    server.removeAllListeners("exit");
    server.kill();
});

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

async function replay(service: string, name: string): Promise<void>
{
    const r = await node.connectService(url(service));
    try
    {
        const ops = vectors[service][name] as Op[];
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
            if (!m && op.error !== undefined) continue; // Stale reference to an object whose type has since changed
            assert.ok(m, `${where}: no such member`);

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

for (const test_name of Object.keys(vectors.RobotRaconteurTestService))
{
    test(`TestService1 ${test_name} replay`, { timeout: 120000 }, () => replay("RobotRaconteurTestService", test_name));
}
for (const test_name of Object.keys(vectors.RobotRaconteurTestService2))
{
    test(`TestService3 ${test_name} replay`, { timeout: 120000 }, () => replay("RobotRaconteurTestService2", test_name));
}

async function drain(r: ServiceStub, g: GeneratorHandle, param?: () => unknown): Promise<unknown[]>
{
    const out: unknown[] = [];
    for (;;)
    {
        try
        {
            out.push(await r.callFunctionGenNext(g, param?.()));
        }
        catch (e)
        {
            assert.ok((e as RobotRaconteurError).isStopIteration, String(e));
            return out;
        }
    }
}

test("connection exposes service information", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService"));
    assert.equal(r.objectType, "com.robotraconteur.testing.TestService1.testroot");
    assert.ok(r.context.types.defs.has("com.robotraconteur.testing.TestService2"));
    await node.disconnectService(r);
    await assert.rejects(r.getProperty("d1"), RobotRaconteurError);
});

test("generators", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService2"));
    try
    {
        const g1 = (await r.callFunction("gen_func1")) as GeneratorHandle;
        assert.deepEqual(await drain(r, g1), Array.from({ length: 16 }, (_, i) => i));

        const g2 = (await r.callFunction("gen_func2", { name: "gen_func2_a_param" })) as GeneratorHandle;
        assert.deepEqual(await drain(r, g2), Array.from({ length: 16 }, (_, i) => Uint8Array.of(i)));

        const g3 = (await r.callFunction("gen_func4")) as GeneratorHandle;
        for (let i = 0; i < 3; i++) await r.callFunctionGenNext(g3, []);
        await r.callFunctionGenNext(g3, Uint8Array.of(2, 3, 4));
        await r.callFunctionGenAbort(g3);
        await assert.rejects(r.callFunctionGenNext(g3, []), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.OperationAborted");

        const g4 = (await r.callFunction("gen_func4")) as GeneratorHandle;
        await r.callFunctionGenNext(g4, Uint8Array.of(2, 3, 4));
        await r.callFunctionGenClose(g4);
        await assert.rejects(r.callFunctionGenNext(g4, []), (e: RobotRaconteurError) => e.isStopIteration);
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("wire peek and poke", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService2"));
    try
    {
        const v = await r.peekWireInValue("peekwire");
        assert.equal(v.value, 56295674);
        assert.ok(v.timestamp.seconds > 0n);
        await r.pokeWireOutValue("pokewire", 75738265);
        assert.equal((await r.peekWireOutValue("pokewire")).value, 75738265);
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("errors carry name, subname, and parameter", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService2"));
    try
    {
        await assert.rejects(r.callFunction("test_exception_params1"), (e: RobotRaconteurError) =>
        {
            assert.equal(e.errorName, "RobotRaconteur.InvalidOperation");
            assert.equal(e.message, "test error");
            assert.equal(e.errorSubName, "my_error");
            const p = e.errorParam!.value as Map<string, VarValue>;
            assert.equal(p.size, 2);
            assert.equal((p.get("param1")!.value as Int32Array)[0], 10);
            assert.equal(p.get("param2")!.value, "20");
            return true;
        });
        await assert.rejects(r.callFunction("test_exception_params2"), (e: RobotRaconteurError) =>
        {
            assert.equal(e.errorName, "com.robotraconteur.testing.TestService3.test_exception4");
            assert.equal(e.errorSubName, "my_error2");
            return true;
        });
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("authentication", async () =>
{
    const service = "RobotRaconteurTestService_auth";
    const r = await node.connectService(url(service), "testuser1", new Map([["password", new VarValue("testpass1", "string")]]));
    assert.equal(typeof (await r.callFunction("func3", [2.2, 3.3])), "number");
    await node.disconnectService(r);
    await assert.rejects(node.connectService(url(service), "testuser1", new Map([["password", new VarValue("wrong", "string")]])), RobotRaconteurError);
    await assert.rejects(node.connectService(url(service)), RobotRaconteurError);
});

test("large messages are fragmented and reassembled", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService"));
    try
    {
        const huge = (await r.getProperty("i32_huge")) as Int32Array;
        assert.equal(huge.length, 2621440);
        assert.ok(huge.every((x, i) => x === i));
        await r.setProperty("i32_huge", huge.map((x) => -x));
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("released object references fail", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService"));
    try
    {
        await r.callFunction("o6_op", [0]);
        const o = await r.getObjRef("o6");
        assert.equal(o.objectType, "com.robotraconteur.testing.TestService1.sub1");
        await r.callFunction("o6_op", [1]);
        await assert.rejects(o.setProperty("d1", [0]), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.ServiceError");
        const o2 = await r.getObjRef("o6");
        assert.equal(o2.objectType, "com.robotraconteur.testing.TestService1.sub2");
        await o2.setProperty("data", "Hello world!");
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("plain and differently typed arrays reach the service as the declared type", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService"));
    try
    {
        const o = await r.getObjRef("o1");
        await o.setProperty("d1", [1.5, 2.5]);
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(1.5, 2.5));
        await o.setProperty("d1", Int32Array.of(3, -4));
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(3, -4));
        await o.setProperty("d2", { dims: [2, 1], array: Uint8Array.of(5, 6) });
        assert.deepEqual(await o.getProperty("d2"), { dims: Uint32Array.of(2, 1), array: Float64Array.of(5, 6) });

        await assert.rejects(o.setProperty("d1", 5), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.DataTypeError" && e.message.includes("value"));
        await assert.rejects(o.setProperty("d1", ["a"]), RobotRaconteurError);
        assert.deepEqual(await o.getProperty("d1"), Float64Array.of(3, -4));
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("local misuse is reported before sending", async () =>
{
    const r = await node.connectService(url("RobotRaconteurTestService"));
    try
    {
        await assert.rejects(r.getProperty("not_a_member"), RobotRaconteurError);
        await assert.rejects(r.callFunction("func3", [1]), RobotRaconteurError);
        await assert.rejects(r.callFunction("func3", { d1: 1 }), RobotRaconteurError);
        await assert.rejects(r.getProperty("func3"), RobotRaconteurError);
    }
    finally
    {
        await node.disconnectService(r);
    }
});

test("connection failures are reported", async () =>
{
    const n = new RobotRaconteurNode();
    n.registerTransport(new BrowserWebSocketTransport(n));
    await assert.rejects(n.connectService("rr+ws://localhost:1?service=x"), RobotRaconteurError);
    await assert.rejects(n.connectService("rr+pipe://x?service=x"), RobotRaconteurError);
    await assert.rejects(n.connectService(url("no_such_service")), RobotRaconteurError);
    await assert.rejects(n.connectService(`rr+ws://localhost:${PORT}?service=RobotRaconteurTestService&nodename=wrong_node`), RobotRaconteurError);
});

test("real browser", { timeout: 120000 }, async () =>
{
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try
    {
        const page = await browser.newPage();
        const logs: string[] = [];
        page.on("pageerror", (e) => logs.push(String(e)));
        await page.goto("file://" + join(root, "dist-test/browser/index.html"));
        const r = (await page.evaluate((port) => (globalThis as any).runSmoke(port), PORT).catch((e) =>
        {
            throw new Error(`${e} ${logs.join(" ")}`);
        })) as Record<string, unknown>;
        assert.equal(r.d1, 12.345);
        assert.equal(r.gen && (r.gen as unknown[]).length, 16);
        assert.equal(r.peek, 56295674);
        assert.equal(r.poke, 75738265);
        assert.ok((r.o1_dims as number[]).length > 0);
    }
    finally
    {
        await browser.close();
    }
});
