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
