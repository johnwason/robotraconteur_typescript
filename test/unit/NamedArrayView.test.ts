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

import { deserializeMessage, Message, MessageEntry, serializeMessage } from "../../src/Message.js";
import { DecodeOptions, NamedArrayView, packElement, TypeContext, unpackElement, VarValue } from "../../src/Pack.js";
import { parseServiceDefinition, parseTypeDefinition, ServiceDefinition } from "../../src/ServiceDefinition.js";
import { newNamedArrayView } from "../../src/ServiceTypes.js";
import type { ServiceStub } from "../../src/Client.js";

const def = parseServiceDefinition(`service test.views
stdver 0.10
namedarray point
    field single x
    field single y
    field single z
    field single w
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
namedarray cplx
    field cdouble c
    field double d
end
struct cloud
    field point[] points
    field vec v
    field vec[] vs
    field string name
end
object o
    property double p
end
`);

let options: DecodeOptions | undefined;
const ctx = new TypeContext(new Map<string, ServiceDefinition>([[def.name, def]]), () => options);
const stub = { context: { types: ctx, serviceDefForType: () => def }, objectType: "test.views.o" } as unknown as ServiceStub;

/** Pack, send through the serializer, and unpack with the given decode options */
function roundTrip(type: string, value: unknown, decode?: DecodeOptions): unknown
{
    const t = parseTypeDefinition(type);
    const m = new Message();
    const e = new MessageEntry(1);
    options = undefined;
    e.addElement(packElement("v", t, value, def, ctx));
    m.entries.push(e);
    const r = deserializeMessage(serializeMessage(m));
    options = decode;
    try
    {
        return unpackElement(r.entries[0]!.elements[0]!, t, def, ctx);
    }
    finally
    {
        options = undefined;
    }
}

const points = [{ x: 1, y: 2, z: 3, w: 4 }, { x: 5, y: 6, z: 7, w: 8 }, { x: 9, y: 10, z: 11, w: 12 }];
const poses = [
    { p: { x: 1, y: 2 }, q: Float64Array.of(3, 4), r: [{ x: 5, y: 6 }, { x: 7, y: 8 }] },
    { p: { x: 9, y: 10 }, q: Float64Array.of(11, 12), r: [{ x: 13, y: 14 }, { x: 15, y: 16 }] }
];

test("objects are still the default", () =>
{
    assert.deepEqual(roundTrip("point[]", points), points);
    assert.deepEqual(roundTrip("point[]", points, {}), points);
    assert.deepEqual(roundTrip("point[]", points, { namedArrays: "object", viewTypes: ["test.views.vec"] }), points);
});

test("arrays decode as views over the received typed array", () =>
{
    const v = roundTrip("point[]", points, { namedArrays: "view" });
    assert.ok(v instanceof NamedArrayView);
    assert.equal(v.typeName, "test.views.point");
    assert.equal(v.elementType, "single");
    assert.equal(v.stride, 4);
    assert.equal(v.length, 3);
    assert.ok(v.array instanceof Float32Array);
    assert.deepEqual(v.array, Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12));
    assert.equal(v.fieldOffset("z"), 2);
    assert.throws(() => v.fieldOffset("q"), /no field q/);
    assert.deepEqual(v.get(1), points[1]);
    assert.deepEqual(v.toObjects(), points);
    assert.throws(() => v.get(3), RangeError);
    assert.throws(() => v.get(-1), RangeError);
});

test("viewTypes selects types by qualified name", () =>
{
    const v = roundTrip("point[]", points, { viewTypes: ["test.views.point"] });
    assert.ok(v instanceof NamedArrayView);
    assert.deepEqual(roundTrip("vec[]", [{ x: 1, y: 2 }], { viewTypes: ["test.views.point"] }), [{ x: 1, y: 2 }]);
    // Changing the options object takes effect on the next decode
    assert.ok(roundTrip("vec[]", [{ x: 1, y: 2 }], { viewTypes: new Set(["test.views.vec"]) }) instanceof NamedArrayView);
});

test("options changed in place take effect", () =>
{
    const o: DecodeOptions = {};
    assert.ok(Array.isArray(roundTrip("point[]", points, o)));
    o.namedArrays = "view";
    assert.ok(roundTrip("point[]", points, o) instanceof NamedArrayView);
    o.namedArrays = "object";
    assert.ok(Array.isArray(roundTrip("point[]", points, o)));
    o.viewTypes = ["test.views.point"];
    assert.ok(roundTrip("point[]", points, o) instanceof NamedArrayView);
    o.viewTypes = [];
    assert.ok(Array.isArray(roundTrip("point[]", points, o)));
});

test("single named arrays stay objects", () =>
{
    assert.deepEqual(roundTrip("vec", { x: 1, y: 2 }, { namedArrays: "view" }), { x: 1, y: 2 });
    assert.deepEqual(roundTrip("pose", poses[0], { namedArrays: "view" }), poses[0]);
});

test("fixed, bounded, and multidimensional arrays", () =>
{
    const fixed = roundTrip("point[3]", points, { namedArrays: "view" }) as NamedArrayView;
    assert.equal(fixed.length, 3);
    assert.equal((roundTrip("point[4-]", points, { namedArrays: "view" }) as NamedArrayView).length, 3);
    const md = roundTrip("point[*]", { dims: Uint32Array.of(3, 1), array: points }, { namedArrays: "view" }) as { dims: Uint32Array; array: NamedArrayView };
    assert.deepEqual(md.dims, Uint32Array.of(3, 1));
    assert.deepEqual(md.array.toObjects(), points);
});

test("nested and complex fields", () =>
{
    const v = roundTrip("pose[]", poses, { namedArrays: "view" }) as NamedArrayView;
    assert.equal(v.stride, 8);
    assert.deepEqual(v.fields, [
        { name: "p", offset: 0, count: 1, type: "test.views.vec", isArray: false },
        { name: "q", offset: 2, count: 2, type: "double", isArray: true },
        { name: "r", offset: 4, count: 2, type: "test.views.vec", isArray: true }
    ]);
    assert.deepEqual(v.toObjects(), poses);

    const c = [{ c: { real: 1, imag: 2 }, d: 3 }];
    const cv = roundTrip("cplx[]", c, { namedArrays: "view" }) as NamedArrayView;
    assert.equal(cv.stride, 3);
    assert.deepEqual(cv.array, Float64Array.of(1, 2, 3));
    assert.deepEqual(cv.get(0), c[0]);
});

test("fields of structures and varvalues", () =>
{
    const s = { points, v: { x: 1, y: 2 }, vs: [{ x: 3, y: 4 }], name: "a" };
    const r = roundTrip("cloud", s, { viewTypes: ["test.views.point"] }) as Record<string, unknown>;
    assert.ok(r["points"] instanceof NamedArrayView);
    assert.deepEqual((r["points"] as NamedArrayView).toObjects(), points);
    assert.deepEqual(r["v"], { x: 1, y: 2 });
    assert.deepEqual(r["vs"], [{ x: 3, y: 4 }]);

    const vv = roundTrip("varvalue", new VarValue(points, "test.views.point[]"), { namedArrays: "view" }) as VarValue;
    assert.equal(vv.type, "test.views.point[]");
    assert.ok(vv.value instanceof NamedArrayView);
});

test("views are sent without changes, whatever the decode options", () =>
{
    const v = roundTrip("point[]", points, { namedArrays: "view" }) as NamedArrayView;
    assert.deepEqual(roundTrip("point[]", v), points);
    assert.deepEqual(roundTrip("point[3]", v), points);
    assert.deepEqual(roundTrip("point[*]", { dims: [1, 3], array: v }), { dims: Uint32Array.of(1, 3), array: points });
    assert.deepEqual(roundTrip("cloud", { points: v, v: { x: 1, y: 2 }, vs: [], name: "" }), { points, v: { x: 1, y: 2 }, vs: [], name: "" });
    assert.deepEqual(roundTrip("varvalue", new VarValue(v, "test.views.point[]")), new VarValue(points, "test.views.point[]"));
    assert.throws(() => roundTrip("point[2]", v), /dimension mismatch/);
    assert.throws(() => roundTrip("point[*]", { dims: [2], array: v }), /dimension mismatch/);
    assert.throws(() => roundTrip("vec[]", v), /Expected test.views.vec/);
});

test("newNamedArrayView creates views to send", () =>
{
    const v = newNamedArrayView(stub, "point", 2);
    assert.deepEqual(v.array, new Float32Array(8));
    v.set(1, { x: 1, y: 2, z: 3, w: 4 });
    v.array[0] = 9;
    assert.deepEqual(roundTrip("point[]", v), [{ x: 9, y: 0, z: 0, w: 0 }, { x: 1, y: 2, z: 3, w: 4 }]);

    const w = newNamedArrayView(stub, "test.views.vec", Float64Array.of(1, 2, 3, 4));
    assert.equal(w.length, 2);
    assert.deepEqual(roundTrip("vec", newNamedArrayView(stub, "vec", Float64Array.of(5, 6))), { x: 5, y: 6 });
    assert.throws(() => roundTrip("vec", w), /single named array/);

    assert.throws(() => newNamedArrayView(stub, "cloud", 1), /is not a named array/);
    assert.throws(() => newNamedArrayView(stub, "vec", Float32Array.of(1, 2)), /Expected double array/);
    assert.throws(() => newNamedArrayView(stub, "vec", Float64Array.of(1, 2, 3)), /Invalid named array length/);
});

test("a large point cloud decodes without per point objects", () =>
{
    const n = 1_000_000;
    const v = newNamedArrayView(stub, "point", n);
    for (let i = 0; i < v.array.length; i++) v.array[i] = i;
    const start = performance.now();
    const r = roundTrip("point[]", v, { namedArrays: "view" }) as NamedArrayView;
    const ms = performance.now() - start;
    assert.equal(r.length, n);
    assert.equal(r.array[4 * n - 1], 4 * n - 1);
    // Includes packing and serializing. Decoding to objects takes seconds
    assert.ok(ms < 2000, `round trip took ${ms} ms`);
});
