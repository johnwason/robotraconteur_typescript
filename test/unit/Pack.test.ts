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

import { DataTypes } from "../../src/DataTypes.js";
import { RobotRaconteurError } from "../../src/Error.js";
import { deserializeMessage, Message, MessageEntry, serializeMessage } from "../../src/Message.js";
import { packElement, TypeContext, unpackElement, VarValue } from "../../src/Pack.js";
import { parseServiceDefinition, parseTypeDefinition, ServiceDefinition } from "../../src/ServiceDefinition.js";

const def = parseServiceDefinition(`service test.pack
stdver 0.10
enum e1
    a = 1, b
end
namedarray vec
    field double x
    field double y
end
namedarray pose
    field vec p
    field double[2] q
    field vec[2] r
end
pod inner
    field int32 i
end
pod outer
    field double d
    field double[2] a
    field double[3-] v
    field double[2,2] m
    field inner s
    field inner[2] sa
    field vec n
end
struct st
    field double d
    field string s
    field double[] a
    field st child
    field string{list} l
    field double{string} m
    field int32{int32} mi
    field varvalue v
end
object o
    property double p
end
`);

const ctx = new TypeContext(new Map<string, ServiceDefinition>([[def.name, def]]));

/** Pack, send through the serializer, and unpack */
function roundTrip(type: string, value: unknown, expected: unknown = value): void
{
    const t = parseTypeDefinition(type);
    const m = new Message();
    const e = new MessageEntry(1);
    e.addElement(packElement("v", t, value, def, ctx));
    m.entries.push(e);
    const r = deserializeMessage(serializeMessage(m));
    assert.deepEqual(unpackElement(r.entries[0]!.elements[0]!, t, def, ctx), expected);
}

test("scalars", () =>
{
    roundTrip("double", 1.25);
    roundTrip("single", 1.5);
    roundTrip("int8", -5);
    roundTrip("uint8", 200);
    roundTrip("int16", -500);
    roundTrip("uint16", 50000);
    roundTrip("int32", -500000);
    roundTrip("uint32", 4000000000);
    roundTrip("int64", -5000000000000000000n);
    roundTrip("uint64", 18000000000000000000n);
    roundTrip("int64", 5, 5n);
    roundTrip("bool", true);
    roundTrip("bool", false);
    roundTrip("cdouble", { real: 1.5, imag: -2.5 });
    roundTrip("csingle", { real: 1.5, imag: -2.5 });
    roundTrip("string", "héllo");
    roundTrip("string", "");
    roundTrip("e1", 2);
});

test("arrays", () =>
{
    roundTrip("double[]", Float64Array.of(1, 2, 3));
    roundTrip("double[]", new Float64Array(0));
    roundTrip("double[]", [1, 2], Float64Array.of(1, 2));
    roundTrip("double[2]", Float64Array.of(1, 2));
    roundTrip("double[2-]", Float64Array.of(1));
    roundTrip("int64[]", [1, 2n], BigInt64Array.of(1n, 2n));
    roundTrip("uint64[]", BigUint64Array.of(1n));
    roundTrip("bool[]", [true, false], Uint8Array.of(1, 0));
    roundTrip("cdouble[]", Float64Array.of(1, 2, 3, 4));
    roundTrip("cdouble[]", [{ real: 1, imag: 2 }], Float64Array.of(1, 2));
    assert.throws(() => roundTrip("double[3]", Float64Array.of(1)));
    assert.throws(() => roundTrip("double[1-]", Float64Array.of(1, 2)));
    assert.throws(() => roundTrip("double", null));
});

test("multidimensional arrays", () =>
{
    const m = { dims: Uint32Array.of(2, 2), array: Float64Array.of(1, 2, 3, 4) };
    roundTrip("double[*]", m);
    roundTrip("double[2,2]", m);
    roundTrip("double[*]", { dims: [1, 2], array: [1, 2] }, { dims: Uint32Array.of(1, 2), array: Float64Array.of(1, 2) });
    roundTrip("cdouble[*]", { dims: Uint32Array.of(1, 1), array: Float64Array.of(1, 2) });
    assert.throws(() => roundTrip("double[*]", { dims: [3], array: [1] }));
    assert.throws(() => roundTrip("double[3,3]", m));
});

test("containers", () =>
{
    roundTrip("double{list}", [1, 2]);
    roundTrip("double[]{list}", [Float64Array.of(1)]);
    roundTrip("double{int32}", new Map([[5, 1.5], [-2, 2.5]]));
    roundTrip("double{string}", new Map([["a", 1.5]]));
    roundTrip("double{string}", { a: 1.5 }, new Map([["a", 1.5]]));
    roundTrip("double{list}", null);
    roundTrip("double{int32}", null);
    assert.throws(() => roundTrip("double{list}", 5));
});

test("structures", () =>
{
    const s = {
        d: 1,
        s: "a",
        a: Float64Array.of(1),
        child: null,
        l: ["x"],
        m: new Map([["k", 2]]),
        mi: new Map([[3, 4]]),
        v: new VarValue(Float64Array.of(9), "double[]")
    };
    roundTrip("st", s);
    roundTrip("st", null);
    roundTrip("st", { ...s, child: { ...s } });
    roundTrip("st{list}", [s]);
    assert.throws(() => roundTrip("st", { ...s, d: undefined }));
});

test("named arrays", () =>
{
    roundTrip("vec", { x: 1, y: 2 });
    roundTrip("vec[]", [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    roundTrip("vec[*]", { dims: Uint32Array.of(1, 2), array: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
    roundTrip("pose", { p: { x: 1, y: 2 }, q: Float64Array.of(3, 4), r: [{ x: 5, y: 6 }, { x: 7, y: 8 }] });
    assert.throws(() => roundTrip("vec", { x: 1 }));
    assert.throws(() => roundTrip("pose", { p: { x: 1, y: 2 }, q: Float64Array.of(3), r: [] }));
});

test("named array wire format is flattened", () =>
{
    const e = packElement("v", parseTypeDefinition("pose"), { p: { x: 1, y: 2 }, q: Float64Array.of(3, 4), r: [{ x: 5, y: 6 }, { x: 7, y: 8 }] }, def, ctx);
    assert.equal(e.elementType, DataTypes.namedarray_array_t);
    const n = e.castNested();
    assert.equal(n.typeName, "test.pack.pose");
    assert.deepEqual(n.elements[0]!.data, Float64Array.of(1, 2, 3, 4, 5, 6, 7, 8));
});

test("pods", () =>
{
    const i = (v: number) => ({ i: v });
    const p = {
        d: 1,
        a: Float64Array.of(1, 2),
        v: Float64Array.of(1),
        m: { dims: Uint32Array.of(2, 2), array: Float64Array.of(1, 2, 3, 4) },
        s: i(1),
        sa: [i(2), i(3)],
        n: { x: 1, y: 2 }
    };
    roundTrip("outer", p);
    roundTrip("outer[]", [p, p]);
    roundTrip("outer[2]", [p, p]);
    roundTrip("outer[*]", { dims: Uint32Array.of(1, 2), array: [p, p] });
    roundTrip("outer{list}", [p]);
    assert.throws(() => roundTrip("outer[1]", [p, p]));
});

test("pod wire format", () =>
{
    const e = packElement("v", parseTypeDefinition("inner"), { i: 4 }, def, ctx);
    assert.equal(e.elementType, DataTypes.pod_array_t);
    assert.equal(e.castNested().typeName, "test.pack.inner");
    const item = e.castNested().elements[0]!;
    assert.equal(item.elementName, "0");
    assert.equal(item.elementType, DataTypes.pod_t);
    assert.equal(item.castNested().typeName, "");
});

test("fixed multidimensional pod fields are flattened on the wire", () =>
{
    const p = {
        d: 1,
        a: Float64Array.of(1, 2),
        v: new Float64Array(0),
        m: { dims: Uint32Array.of(2, 2), array: Float64Array.of(1, 2, 3, 4) },
        s: { i: 1 },
        sa: [{ i: 2 }, { i: 3 }],
        n: { x: 1, y: 2 }
    };
    const fields = packElement("v", parseTypeDefinition("outer"), p, def, ctx).castNested().elements[0]!.castNested().elements;
    const m = fields.find((x) => x.elementName === "m")!;
    assert.equal(m.elementType, DataTypes.double_t);
    assert.deepEqual(m.data, Float64Array.of(1, 2, 3, 4));
    assert.throws(() => packElement("v", parseTypeDefinition("outer"), { ...p, m: { dims: [4, 1], array: p.m.array } }, def, ctx));
});

test("varvalue", () =>
{
    const rt = (v: unknown, expected: VarValue | null) => roundTrip("varvalue", v, expected);
    rt(null, null);
    rt("x", new VarValue("x", "string"));
    rt(Float64Array.of(1), new VarValue(Float64Array.of(1), "double[]"));
    rt(new VarValue(Int32Array.of(1), "int32[]"), new VarValue(Int32Array.of(1), "int32[]"));
    const md = { dims: Uint32Array.of(1, 1), array: Float64Array.of(1) };
    rt(new VarValue(md, "double[*]"), new VarValue(md, "double[*]"));
    rt(new VarValue({ x: 1, y: 2 }, "test.pack.vec"), new VarValue([{ x: 1, y: 2 }], "test.pack.vec[]"));
    const list = [new VarValue("a", "string")];
    rt(new VarValue(list, "varvalue{list}"), new VarValue(list, "varvalue{list}"));
    const map = new Map([["k", new VarValue("a", "string")]]);
    rt(new VarValue(map, "varvalue{string}"), new VarValue(map, "varvalue{string}"));
    assert.throws(() => rt(5, null));
});

test("unknown types are rejected", () =>
{
    assert.throws(() => packElement("v", parseTypeDefinition("nothere"), 1, def, ctx));
    assert.throws(() => packElement("v", parseTypeDefinition("no.such.type"), 1, def, ctx));
    assert.throws(() => packElement("v", parseTypeDefinition("o"), {}, def, ctx));
});

function packs(type: string, value: unknown): unknown
{
    const e = packElement("v", parseTypeDefinition(type), value, def, ctx);
    return unpackElement(e, parseTypeDefinition(type), def, ctx);
}

function rejects(type: string, value: unknown): void
{
    assert.throws(() => packElement("v", parseTypeDefinition(type), value, def, ctx), RobotRaconteurError, `${type} accepted ${String(value)}`);
}

test("plain and differently typed arrays are converted when every value fits", () =>
{
    assert.deepEqual(packs("double[]", [1, 2.5]), Float64Array.of(1, 2.5));
    assert.deepEqual(packs("double[]", Int32Array.of(1, -2)), Float64Array.of(1, -2));
    assert.deepEqual(packs("double[]", Uint8Array.of(1, 200)), Float64Array.of(1, 200));
    assert.deepEqual(packs("double[]", Float32Array.of(1.5)), Float64Array.of(1.5));
    assert.deepEqual(packs("double[]", BigInt64Array.of(5n)), Float64Array.of(5));
    assert.deepEqual(packs("single[]", Float64Array.of(1.1)), Float32Array.of(1.1));
    assert.deepEqual(packs("int32[]", Float64Array.of(1, -2)), Int32Array.of(1, -2));
    assert.deepEqual(packs("int32[]", [1, 2n]), Int32Array.of(1, 2));
    assert.deepEqual(packs("uint8[]", Int32Array.of(0, 255)), Uint8Array.of(0, 255));
    assert.deepEqual(packs("int64[]", Float64Array.of(3)), BigInt64Array.of(3n));
    assert.deepEqual(packs("uint64[]", BigInt64Array.of(3n)), BigUint64Array.of(3n));
    assert.deepEqual(packs("bool[]", [true, false, 1, 0]), Uint8Array.of(1, 0, 1, 0));
    assert.deepEqual(packs("cdouble[]", Float32Array.of(1.5, 2.5)), Float64Array.of(1.5, 2.5));
    assert.deepEqual(packs("cdouble[]", [1, 2, 3, 4]), Float64Array.of(1, 2, 3, 4));
    assert.deepEqual(packs("double[*]", { dims: [2, 1], array: [1, 2] }), { dims: Uint32Array.of(2, 1), array: Float64Array.of(1, 2) });
    assert.deepEqual(packs("double[*]", { dims: Float64Array.of(1), array: Int32Array.of(4) }), { dims: Uint32Array.of(1), array: Float64Array.of(4) });
    assert.deepEqual(packs("double{list}", Float64Array.of(1, 2)), [1, 2]);
    assert.deepEqual(packs("double[2]", [1, 2]), Float64Array.of(1, 2));
});

test("subarray views send only the viewed elements", () =>
{
    const m = new Message();
    const e = new MessageEntry(1);
    const view = Float64Array.of(1, 2, 3, 4).subarray(1, 3);
    e.addElement(packElement("v", parseTypeDefinition("double[]"), view, def, ctx));
    m.entries.push(e);
    assert.deepEqual(deserializeMessage(serializeMessage(m)).entries[0]!.elements[0]!.data, Float64Array.of(2, 3));
});

test("scalars accept a single element array", () =>
{
    assert.equal(packs("double", [1.5]), 1.5);
    assert.equal(packs("double", Float64Array.of(1.5)), 1.5);
    assert.equal(packs("int32", Float64Array.of(3)), 3);
    assert.equal(packs("double", 5n), 5);
    assert.equal(packs("bool", 1), true);
    assert.deepEqual(packs("cdouble", Float64Array.of(1, 2)), { real: 1, imag: 2 });
    assert.deepEqual(packs("cdouble", 3), { real: 3, imag: 0 });
});

test("values that cannot be represented are rejected rather than altered", () =>
{
    rejects("double[]", 5);
    rejects("double[]", "abc");
    rejects("double[]", {});
    rejects("double[]", true);
    rejects("double[]", null);
    rejects("double[]", [1, "2"]);
    rejects("double[]", [1, undefined]);
    rejects("double[]", [1, null]);
    rejects("double[]", [[1, 2]]);
    rejects("double[]", [true]);
    rejects("double[]", [{ real: 1, imag: 2 }]);
    rejects("double[]", BigInt64Array.of(9007199254740993n));
    rejects("single[]", [1e300]);
    rejects("uint8[]", [300]);
    rejects("uint8[]", [-1]);
    rejects("uint8[]", Int32Array.of(256));
    rejects("int8[]", Uint8Array.of(200));
    rejects("int32[]", [1.5]);
    rejects("int32[]", Float64Array.of(0.5));
    rejects("int32[]", [NaN]);
    rejects("int32[]", [Infinity]);
    rejects("int32[]", [2147483648]);
    rejects("uint32[]", [-1]);
    rejects("int64[]", [1.5]);
    rejects("int64[]", [2 ** 60]);
    rejects("int64[]", [9223372036854775808n]);
    rejects("uint64[]", BigInt64Array.of(-1n));
    rejects("bool[]", [2]);
    rejects("bool[]", Uint8Array.of(0, 2));
    rejects("cdouble[]", [1, 2, 3]);
    rejects("cdouble[]", Float64Array.of(1, 2, 3));
    rejects("cdouble[]", [{ real: 1 }]);
    rejects("cdouble[]", [{ real: 1, imag: 2 }, 3]);
    rejects("double", "1.5");
    rejects("double", {});
    rejects("double", [1, 2]);
    rejects("double", true);
    rejects("int32", 1.5);
    rejects("uint8", 256);
    rejects("bool", "true");
    rejects("cdouble", { real: "1", imag: 2 });
    rejects("e1", "a");
    rejects("e1", 1.5);
    rejects("double[*]", [1, 2]);
    rejects("double[*]", { dims: [-1], array: [] });
    rejects("double[*]", { dims: [1.5], array: [1] });
    rejects("double[*]", { dims: 2, array: [1, 2] });
    rejects("double{list}", "ab");
    rejects("double{string}", 5);
    rejects("double{string}", [1, 2]);
    rejects("double{int32}", new Map([["a", 1]]));
    rejects("double{int32}", new Map([[1.5, 1]]));
    rejects("double{int32}", new Map([[2147483648, 1]]));
    rejects("vec[]", { x: 1, y: 2 });
    rejects("vec", { x: "1", y: 2 });
    rejects("pose", { p: { x: 1, y: 2 }, q: 5, r: [{ x: 5, y: 6 }, { x: 7, y: 8 }] });
    rejects("inner[]", { i: 1 });
    rejects("inner", { i: 1.5 });
    rejects("st", 5);
});
