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

import { GeneratorHandle, parseTypeDefinition, RobotRaconteurError, ServiceStub, VarValue } from "../../src/index.js";
import { packElement, unpackElement } from "../../src/Pack.js";
import { assert } from "./check.js";
import * as st from "./ServiceTest2.js";
import { errorNamed } from "./TestUtil.js";

// Port of the Core Python ServiceTestClient2.py, in the same order. TestComplex and TestBools are
// generated, see ServiceTestClientGenerated.ts. Memories and wire and pipe connections are not
// implemented by this client, so TestMemories, TestNamedArrayMemories, TestComplexMemories,
// TestBoolMemories, and those parts of the other tests are not ported.

const T3 = "com.robotraconteur.testing.TestService3";

export async function TestWirePeekPoke(r: ServiceStub): Promise<void>
{
    const v = await r.peekWireInValue("peekwire");
    assert.equal(v.value, 56295674);
    assert.ok(v.timestamp.seconds > 0n);
    assert.ok(v.timestamp.nanoseconds >= 0 && v.timestamp.nanoseconds < 1000000000);

    await r.pokeWireOutValue("pokewire", 75738265);
    assert.equal((await r.peekWireOutValue("pokewire")).value, 75738265);
}

export async function TestEnums(r: ServiceStub): Promise<void>
{
    const defs = r.context.types.defs.get(T3)!;
    const c = Object.fromEntries(defs.enums[0]!.values.map((x) => [x.name, x.value]));
    assert.equal(await r.getProperty("testenum1_prop"), c.anothervalue);
    await r.setProperty("testenum1_prop", c.hexval1);
}

function roundTrip(r: ServiceStub, type: string, v: unknown): any
{
    const t = parseTypeDefinition(type);
    const scope = r.context.serviceDefForType(r.objectType);
    return unpackElement(packElement("value", t, v, scope, r.context.types), t, scope, r.context.types);
}

export async function TestPods(r: ServiceStub): Promise<void>
{
    const s1 = st.ServiceTest2_fill_testpod1(563921043);
    st.ServiceTest2_verify_testpod1(s1, 563921043);
    st.ServiceTest2_verify_testpod1(roundTrip(r, `${T3}.testpod1`, s1), 563921043);

    const s3 = st.ServiceTest2_fill_teststruct3(858362);
    st.ServiceTest2_verify_teststruct3(roundTrip(r, `${T3}.teststruct3`, s3), 858362);

    const p1 = (await r.getProperty("testpod1_prop")) as Record<string, unknown>;
    st.ServiceTest2_verify_testpod1(p1, 563921043);

    await r.setProperty("testpod1_prop", st.ServiceTest2_fill_testpod1(85932659));

    const f1 = (await r.callFunction("testpod1_func2")) as Record<string, unknown>;
    st.ServiceTest2_verify_testpod1(f1, 95836295);

    await r.callFunction("testpod1_func1", [st.ServiceTest2_fill_testpod1(29546592)]);

    // Reading teststruct3_prop is disabled in the Core test
    await r.setProperty("teststruct3_prop", st.ServiceTest2_fill_teststruct3(858362));
}

async function nextAll(r: ServiceStub, g: GeneratorHandle): Promise<unknown[]>
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

export async function TestGenerators(r: ServiceStub): Promise<void>
{
    const range16 = Array.from({ length: 16 }, (_, i) => i);
    assert.deepEqual(await nextAll(r, (await r.callFunction("gen_func1")) as GeneratorHandle), range16);

    const g = (await r.callFunction("gen_func4")) as GeneratorHandle;
    for (let i = 0; i < 3; i++) await r.callFunctionGenNext(g, []);
    assert.deepEqual(await r.callFunctionGenNext(g, [2, 3, 4]), Uint8Array.of(5, 6, 7));
    await r.callFunctionGenAbort(g);
    await assert.rejects(r.callFunctionGenNext(g, []), errorNamed("RobotRaconteur.OperationAborted"));

    const g2 = (await r.callFunction("gen_func4")) as GeneratorHandle;
    await r.callFunctionGenNext(g2, [2, 3, 4]);
    await r.callFunctionGenClose(g2);
    await assert.rejects(r.callFunctionGenNext(g2, []), (e: RobotRaconteurError) => e.isStopIteration);

    const g2_values = await nextAll(r, (await r.callFunction("gen_func2", ["gen_func2_a_param"])) as GeneratorHandle);
    assert.deepEqual(g2_values, range16.map((i) => Uint8Array.of(i)));
}

export async function TestNamedArrays(r: ServiceStub): Promise<void>
{
    await r.setProperty("testnamedarray1", st.ServiceTest2_fill_transform(3956378).translation);
    const a1_2 = st.ServiceTest2_fill_transform(74637);
    a1_2.translation = await r.getProperty("testnamedarray1");
    st.ServiceTest2_verify_transform(a1_2, 74637);

    await r.setProperty("testnamedarray2", st.ServiceTest2_fill_transform(827635));
    st.ServiceTest2_verify_transform((await r.getProperty("testnamedarray2")) as Record<string, unknown>, 1294);

    await r.setProperty("testnamedarray3", st.ServiceTest2_create_transform_array(6, 19274));
    st.ServiceTest2_verify_transform_array((await r.getProperty("testnamedarray3")) as Record<string, unknown>[], 8, 837512);

    await r.setProperty("testnamedarray4", st.ServiceTest2_create_transform_multidimarray(5, 2, 6385));
    st.ServiceTest2_verify_transform_multidimarray((await r.getProperty("testnamedarray4")) as Record<string, unknown>, 7, 2, 66134);

    await r.setProperty("testnamedarray5", st.ServiceTest2_create_transform_multidimarray(3, 2, 7732));
    st.ServiceTest2_verify_transform_multidimarray((await r.getProperty("testnamedarray5")) as Record<string, unknown>, 3, 2, 773142);
}

export async function TestNoLock(r: ServiceStub): Promise<void>
{
    const o5 = await r.getObjRef("nolock_test");
    const locked = errorNamed("RobotRaconteur.ObjectLockedError");

    await assert.rejects(o5.getProperty("p1"), locked);
    await o5.getProperty("p2");
    await o5.setProperty("p2", 0);
    await o5.getProperty("p3");
    await assert.rejects(o5.setProperty("p3", 0), locked);

    await assert.rejects(o5.callFunction("f1"), locked);
    await o5.callFunction("f2");
}

export async function TestExceptionParams(r: ServiceStub): Promise<void>
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
        assert.equal(e.errorName, `${T3}.test_exception4`);
        assert.equal(e.message, "test error2");
        assert.equal(e.errorSubName, "my_error2");
        const p = e.errorParam!.value as Map<string, VarValue>;
        assert.equal(p.size, 2);
        assert.equal((p.get("param1")!.value as Int32Array)[0], 30);
        assert.equal(p.get("param2")!.value, "40");
        return true;
    });
}
