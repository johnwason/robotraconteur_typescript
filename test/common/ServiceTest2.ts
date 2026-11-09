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

import { VarValue } from "../../src/index.js";
import { assert } from "./check.js";
import { double_constants, uint32_constants } from "./ServiceTestClientGenerated.js";
import { md } from "./TestUtil.js";

// Port of the fill and verify functions in the Core Python ServiceTest2.py. A pod or named array
// is a plain object here, where numpy uses a length one array.

const T3 = "com.robotraconteur.testing.TestService3";

export class ServiceTest2_test_sequence_gen
{
    private counter: number;
    private step: number;

    constructor(seed: number)
    {
        this.counter = seed % 7823;
        this.step = (seed % 17) + 7;
    }

    get_double(): number
    {
        this.counter += this.step;
        return double_constants[this.counter % double_constants.length]!;
    }

    get_uint32(): number
    {
        this.counter += this.step;
        return uint32_constants[this.counter % uint32_constants.length]!;
    }

    get_int8(): number
    {
        this.counter += this.step;
        return (this.counter % 0xff) - 128;
    }
}

type Gen = ServiceTest2_test_sequence_gen;
type Obj = Record<string, any>;

const new_gen = (seed: number) => new ServiceTest2_test_sequence_gen(seed);
const repeat = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

function create_double_array(gen: Gen, len: number): Float64Array
{
    return Float64Array.from(repeat(len, () => gen.get_double()));
}

function verify_double_array(gen: Gen, a: any, len: number): void
{
    const flat = "array" in a ? a.array : a;
    assert.equal(flat.length, len);
    for (const d of flat) assert.equal(d, gen.get_double());
}

function create_int8_array(gen: Gen, len: number): Int8Array
{
    return Int8Array.from(repeat(len, () => gen.get_int8()));
}

function verify_int8_array(gen: Gen, a: any, len: number): void
{
    assert.equal(a.length, len);
    for (const d of a) assert.equal(d, gen.get_int8());
}

export function ServiceTest2_fill_transform(seed: number): Obj
{
    const gen = new_gen(seed);
    const d = () => gen.get_double();
    return { rotation: { q0: d(), q1: d(), q2: d(), q3: d() }, translation: { x: d(), y: d(), z: d() } };
}

export function ServiceTest2_verify_transform(s: Obj, seed: number): void
{
    const gen = new_gen(seed);
    const v = [s.rotation.q0, s.rotation.q1, s.rotation.q2, s.rotation.q3, s.translation.x, s.translation.y, s.translation.z];
    for (const x of v) assert.equal(x, gen.get_double());
}

export function ServiceTest2_create_transform_array(len: number, seed: number): Obj[]
{
    const gen = new_gen(seed);
    return repeat(len, () => ServiceTest2_fill_transform(gen.get_uint32()));
}

export function ServiceTest2_verify_transform_array(v: Obj[], len: number, seed: number): void
{
    const gen = new_gen(seed);
    assert.equal(v.length, len);
    for (const x of v) ServiceTest2_verify_transform(x, gen.get_uint32());
}

export function ServiceTest2_create_transform_multidimarray(m: number, n: number, seed: number): Obj
{
    return md(ServiceTest2_create_transform_array(m * n, seed), [m, n]);
}

export function ServiceTest2_verify_transform_multidimarray(v: Obj, m: number, n: number, seed: number): void
{
    assert.deepEqual(Array.from(v.dims as Uint32Array), [m, n]);
    ServiceTest2_verify_transform_array(v.array, m * n, seed);
}

export function ServiceTest2_fill_testpod2(seed: number): Obj
{
    const gen = new_gen(seed);
    return { i1: gen.get_int8(), i2: create_int8_array(gen, 15), i3: create_int8_array(gen, gen.get_uint32() % 15) };
}

export function ServiceTest2_verify_testpod2(s: Obj, seed: number): void
{
    const gen = new_gen(seed);
    assert.equal(s.i1, gen.get_int8());
    verify_int8_array(gen, s.i2, 15);
    verify_int8_array(gen, s.i3, gen.get_uint32() % 15);
}

function create_testpod2_array(gen: Gen, len: number): Obj[]
{
    return repeat(len, () => ServiceTest2_fill_testpod2(gen.get_uint32()));
}

function verify_testpod2_array(gen: Gen, v: Obj[], len: number): void
{
    assert.equal(v.length, len);
    for (const x of v) ServiceTest2_verify_testpod2(x, gen.get_uint32());
}

export function ServiceTest2_fill_testpod1(seed: number): Obj
{
    const gen = new_gen(seed);
    const s: Obj = {};
    s.d1 = gen.get_double();
    s.d2 = create_double_array(gen, 6);
    s.d3 = create_double_array(gen, gen.get_uint32() % 6);
    s.d4 = md(create_double_array(gen, 9), [3, 3]);
    s.s1 = ServiceTest2_fill_testpod2(gen.get_uint32());
    s.s2 = create_testpod2_array(gen, 8);
    s.s3 = create_testpod2_array(gen, gen.get_uint32() % 9);
    s.s4 = md(create_testpod2_array(gen, 8), [2, 4]);
    s.t1 = ServiceTest2_fill_transform(gen.get_uint32());
    s.t2 = repeat(4, () => ServiceTest2_fill_transform(gen.get_uint32()));
    s.t3 = repeat(gen.get_uint32() % 15, () => ServiceTest2_fill_transform(gen.get_uint32()));
    s.t4 = md(repeat(8, () => ServiceTest2_fill_transform(gen.get_uint32())), [2, 4]);
    return s;
}

export function ServiceTest2_verify_testpod1(s: Obj, seed: number): void
{
    const gen = new_gen(seed);
    assert.equal(s.d1, gen.get_double());
    verify_double_array(gen, s.d2, 6);
    verify_double_array(gen, s.d3, gen.get_uint32() % 6);
    verify_double_array(gen, s.d4, 9);
    ServiceTest2_verify_testpod2(s.s1, gen.get_uint32());
    verify_testpod2_array(gen, s.s2, 8);
    verify_testpod2_array(gen, s.s3, gen.get_uint32() % 9);
    verify_testpod2_array(gen, s.s4.array, 8);
    ServiceTest2_verify_transform(s.t1, gen.get_uint32());
    for (let i = 0; i < 4; i++) ServiceTest2_verify_transform(s.t2[i], gen.get_uint32());
    const t3_len = gen.get_uint32() % 15;
    assert.equal(s.t3.length, t3_len);
    for (let i = 0; i < t3_len; i++) ServiceTest2_verify_transform(s.t3[i], gen.get_uint32());
    for (let i = 0; i < 8; i++) ServiceTest2_verify_transform(s.t4.array[i], gen.get_uint32());
}

export function ServiceTest2_create_testpod1_array(len: number, seed: number): Obj[]
{
    const gen = new_gen(seed);
    return repeat(len, () => ServiceTest2_fill_testpod1(gen.get_uint32()));
}

export function ServiceTest2_verify_testpod1_array(v: Obj[], len: number, seed: number): void
{
    const gen = new_gen(seed);
    assert.equal(v.length, len);
    for (const x of v) ServiceTest2_verify_testpod1(x, gen.get_uint32());
}

export function ServiceTest2_create_testpod1_multidimarray(m: number, n: number, seed: number): Obj
{
    return md(ServiceTest2_create_testpod1_array(m * n, seed), [m, n]);
}

export function ServiceTest2_verify_testpod1_multidimarray(v: Obj, m: number, n: number, seed: number): void
{
    assert.deepEqual(Array.from(v.dims as Uint32Array), [m, n]);
    ServiceTest2_verify_testpod1_array(v.array, m * n, seed);
}

export function ServiceTest2_fill_teststruct3(seed: number): Obj
{
    const gen = new_gen(seed);
    const u = () => gen.get_uint32();
    const pod = T3 + ".testpod1";
    const transform = T3 + ".transform";
    const o: Obj = {};
    o.s1 = ServiceTest2_fill_testpod1(u());
    const s2_seed = u();
    o.s2 = ServiceTest2_create_testpod1_array(s2_seed % 17, s2_seed);
    o.s3 = ServiceTest2_create_testpod1_array(11, u());
    const s4_seed = u();
    o.s4 = ServiceTest2_create_testpod1_array(s4_seed % 16, s4_seed);
    o.s5 = ServiceTest2_create_testpod1_multidimarray(3, 3, u());
    const s6_seed = u();
    o.s6 = ServiceTest2_create_testpod1_multidimarray(s6_seed % 6, s6_seed % 3, s6_seed);
    o.s7 = [ServiceTest2_fill_testpod1(u())];
    o.s8 = [ServiceTest2_create_testpod1_array(2, u()), ServiceTest2_create_testpod1_array(4, u())];
    o.s9 = [ServiceTest2_create_testpod1_multidimarray(2, 3, u()), ServiceTest2_create_testpod1_multidimarray(4, 5, u())];
    o.s10 = new VarValue([ServiceTest2_fill_testpod1(u())], pod + "[]");
    o.s11 = new VarValue(ServiceTest2_create_testpod1_array(3, u()), pod + "[]");
    o.s12 = new VarValue(ServiceTest2_create_testpod1_multidimarray(2, 2, u()), pod + "[*]");
    o.s13 = new VarValue([[ServiceTest2_fill_testpod1(u())]], pod + "[]{list}");
    o.s14 = new VarValue([ServiceTest2_create_testpod1_array(3, u()), ServiceTest2_create_testpod1_array(5, u())], pod + "[]{list}");
    o.s15 = new VarValue([ServiceTest2_create_testpod1_multidimarray(7, 2, u()), ServiceTest2_create_testpod1_multidimarray(5, 1, u())], pod + "[*]{list}");
    o.t1 = ServiceTest2_fill_transform(u());
    o.t2 = ServiceTest2_create_transform_array(4, u());
    o.t3 = ServiceTest2_create_transform_multidimarray(2, 4, u());
    o.t4 = new VarValue(ServiceTest2_create_transform_array(10, u()), transform + "[]");
    o.t5 = new VarValue(ServiceTest2_create_transform_multidimarray(6, 5, u()), transform + "[*]");
    o.t6 = [ServiceTest2_fill_transform(u())];
    o.t7 = [ServiceTest2_create_transform_array(4, u()), ServiceTest2_create_transform_array(4, u())];
    o.t8 = [ServiceTest2_create_transform_multidimarray(2, 4, u()), ServiceTest2_create_transform_multidimarray(2, 4, u())];
    o.t9 = new VarValue([ServiceTest2_fill_transform(u())], transform + "{list}");
    o.t10 = new VarValue([ServiceTest2_create_transform_array(3, u()), ServiceTest2_create_transform_array(5, u())], transform + "[]{list}");
    o.t11 = new VarValue([ServiceTest2_create_transform_multidimarray(7, 2, u()), ServiceTest2_create_transform_multidimarray(5, 1, u())], transform + "[*]{list}");
    return o;
}

export function ServiceTest2_verify_teststruct3(v: Obj, seed: number): void
{
    assert.ok(v !== null);
    const gen = new_gen(seed);
    const u = () => gen.get_uint32();
    ServiceTest2_verify_testpod1(v.s1, u());
    const s2_seed = u();
    ServiceTest2_verify_testpod1_array(v.s2, s2_seed % 17, s2_seed);
    ServiceTest2_verify_testpod1_array(v.s3, 11, u());
    const s4_seed = u();
    ServiceTest2_verify_testpod1_array(v.s4, s4_seed % 16, s4_seed);
    ServiceTest2_verify_testpod1_multidimarray(v.s5, 3, 3, u());
    const s6_seed = u();
    ServiceTest2_verify_testpod1_multidimarray(v.s6, s6_seed % 6, s6_seed % 3, s6_seed);

    assert.equal(v.s7.length, 1);
    ServiceTest2_verify_testpod1(v.s7[0], u());
    assert.equal(v.s8.length, 2);
    ServiceTest2_verify_testpod1_array(v.s8[0], 2, u());
    ServiceTest2_verify_testpod1_array(v.s8[1], 4, u());
    assert.equal(v.s9.length, 2);
    ServiceTest2_verify_testpod1_multidimarray(v.s9[0], 2, 3, u());
    ServiceTest2_verify_testpod1_multidimarray(v.s9[1], 4, 5, u());

    ServiceTest2_verify_testpod1(v.s10.value[0], u());
    ServiceTest2_verify_testpod1_array(v.s11.value, 3, u());
    ServiceTest2_verify_testpod1_multidimarray(v.s12.value, 2, 2, u());
    ServiceTest2_verify_testpod1(v.s13.value[0].value[0], u());
    assert.equal(v.s14.value.length, 2);
    ServiceTest2_verify_testpod1_array(v.s14.value[0].value, 3, u());
    ServiceTest2_verify_testpod1_array(v.s14.value[1].value, 5, u());
    assert.equal(v.s15.value.length, 2);
    ServiceTest2_verify_testpod1_multidimarray(v.s15.value[0].value, 7, 2, u());
    ServiceTest2_verify_testpod1_multidimarray(v.s15.value[1].value, 5, 1, u());

    ServiceTest2_verify_transform(v.t1, u());
    ServiceTest2_verify_transform_array(v.t2, 4, u());
    ServiceTest2_verify_transform_multidimarray(v.t3, 2, 4, u());
    ServiceTest2_verify_transform_array(v.t4.value, 10, u());
    ServiceTest2_verify_transform_multidimarray(v.t5.value, 6, 5, u());

    assert.equal(v.t6.length, 1);
    ServiceTest2_verify_transform(v.t6[0], u());
    assert.equal(v.t7.length, 2);
    ServiceTest2_verify_transform_array(v.t7[0], 4, u());
    ServiceTest2_verify_transform_array(v.t7[1], 4, u());
    assert.equal(v.t8.length, 2);
    ServiceTest2_verify_transform_multidimarray(v.t8[0], 2, 4, u());
    ServiceTest2_verify_transform_multidimarray(v.t8[1], 2, 4, u());

    assert.equal(v.t9.value.length, 1);
    ServiceTest2_verify_transform(v.t9.value[0].value[0], u());
    assert.equal(v.t10.value.length, 2);
    ServiceTest2_verify_transform_array(v.t10.value[0].value, 3, u());
    ServiceTest2_verify_transform_array(v.t10.value[1].value, 5, u());
    assert.equal(v.t11.value.length, 2);
    ServiceTest2_verify_transform_multidimarray(v.t11.value[0].value, 7, 2, u());
    ServiceTest2_verify_transform_multidimarray(v.t11.value[1].value, 5, 1, u());
}
