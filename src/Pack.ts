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

import { DataTypes, MessageErrorType, NumericArray, PrimitiveInfo, primitivesByName, primitivesByType } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import { MessageElement } from "./Message.js";
import { EntryDefinition, parseTypeDefinition, ServiceDefinition, TypeDefinition } from "./ServiceDefinition.js";

// Packs and unpacks values between JavaScript data and message elements, using parsed service
// definitions in place of generated code.

/** A value together with its Robot Raconteur type, used for varvalue */
export class VarValue
{
    constructor(public value: unknown, public type: string) {}
}

export interface MultiDimArray
{
    dims: Uint32Array;
    array: unknown;
}

type NamedKind = "struct" | "pod" | "namedarray" | "enum" | "object";

export interface ResolvedType
{
    kind: NamedKind;
    def: ServiceDefinition;
    entry?: EntryDefinition;
    qualifiedName: string;
}

interface NamedArrayField
{
    name: string;
    offset: number;
    count: number;
    prim?: PrimitiveInfo;
    layout?: NamedArrayLayout;
    isArray: boolean;
}

interface NamedArrayLayout
{
    prim: PrimitiveInfo;
    /** Number of typed array entries for one named array */
    length: number;
    fields: NamedArrayField[];
}

function dataError(message: string): RobotRaconteurError
{
    return new RobotRaconteurError(MessageErrorType.DataTypeError, "RobotRaconteur.DataTypeError", message);
}

function isComplexObject(v: unknown): v is { real: number; imag: number }
{
    return typeof v === "object" && v !== null && "real" in v;
}

/** Resolves named types against a set of service definitions */
export class TypeContext
{
    private resolved = new Map<string, ResolvedType>();
    private layouts = new Map<string, NamedArrayLayout>();

    constructor(public defs: Map<string, ServiceDefinition>) {}

    resolve(name: string, scope: ServiceDefinition): ResolvedType
    {
        const key = scope.name + "|" + name;
        let r = this.resolved.get(key);
        if (!r)
        {
            r = this.doResolve(name, scope);
            this.resolved.set(key, r);
        }
        return r;
    }

    private doResolve(name: string, scope: ServiceDefinition): ResolvedType
    {
        let q = name;
        if (!q.includes("."))
        {
            q = scope.using.find((x) => x.unqualifiedName === q)?.qualifiedName ?? scope.name + "." + q;
        }
        const i = q.lastIndexOf(".");
        const def = this.defs.get(q.substring(0, i));
        if (!def) throw dataError("Could not find service definition for type: " + name);
        const n = q.substring(i + 1);
        const qualifiedName = def.name + "." + n;

        const groups: [NamedKind, EntryDefinition[]][] = [["struct", def.structures], ["pod", def.pods], ["namedarray", def.namedArrays], ["object", def.objects]];
        for (const [kind, list] of groups)
        {
            const entry = list.find((x) => x.name === n);
            if (entry) return { kind, def, entry, qualifiedName };
        }
        if (def.enums.some((x) => x.name === n)) return { kind: "enum", def, qualifiedName };
        throw dataError("Unknown type: " + name);
    }

    namedArrayLayout(r: ResolvedType): NamedArrayLayout
    {
        let l = this.layouts.get(r.qualifiedName);
        if (l) return l;

        const fields: NamedArrayField[] = [];
        let offset = 0;
        let prim: PrimitiveInfo | undefined;
        for (const m of r.entry!.members)
        {
            const t = m.type!;
            const isArray = t.array === "array";
            const count = isArray ? t.arrayLength![0]! : 1;
            const p = primitivesByName.get(t.type);
            const f: NamedArrayField = { name: m.name, offset, count, isArray };
            if (p)
            {
                f.prim = p;
                prim = p;
                offset += p.stride * count;
            }
            else
            {
                f.layout = this.namedArrayLayout(this.resolve(t.type, r.def));
                prim = f.layout.prim;
                offset += f.layout.length * count;
            }
            fields.push(f);
        }
        if (!prim) throw dataError("Named array has no fields: " + r.qualifiedName);
        l = { prim, length: offset, fields };
        this.layouts.set(r.qualifiedName, l);
        return l;
    }
}

function writeNamedArray(l: NamedArrayLayout, v: Record<string, unknown>, a: NumericArray, base: number): void
{
    if (typeof v !== "object" || v === null) throw dataError("Expected object for named array");
    for (const f of l.fields)
    {
        const at = base + f.offset;
        const fv = v[f.name];
        if (fv === undefined || fv === null) throw dataError("Missing named array field: " + f.name);
        if (f.layout)
        {
            if (!f.isArray)
            {
                writeNamedArray(f.layout, fv as Record<string, unknown>, a, at);
                continue;
            }
            const items = fv as Record<string, unknown>[];
            if (items.length !== f.count) throw dataError("Array dimension mismatch for field: " + f.name);
            items.forEach((x, i) => writeNamedArray(f.layout!, x, a, at + i * f.layout!.length));
            continue;
        }
        const p = f.prim!;
        const arr = f.isArray ? toNumericArray(fv, p, f.name) : toScalarArray(fv, p, f.name);
        if (arr.length !== f.count * p.stride) throw dataError("Array dimension mismatch for field: " + f.name);
        (a as unknown as { set(x: unknown, offset: number): void }).set(arr, at);
    }
}

function readNamedArray(l: NamedArrayLayout, a: NumericArray, base: number): Record<string, unknown>
{
    const o: Record<string, unknown> = {};
    for (const f of l.fields)
    {
        const at = base + f.offset;
        if (f.layout)
        {
            if (f.isArray)
            {
                const items: Record<string, unknown>[] = [];
                for (let i = 0; i < f.count; i++) items.push(readNamedArray(f.layout, a, at + i * f.layout.length));
                o[f.name] = items;
            }
            else
            {
                o[f.name] = readNamedArray(f.layout, a, at);
            }
            continue;
        }
        const p = f.prim!;
        if (f.isArray)
        {
            o[f.name] = a.slice(at, at + f.count * p.stride);
        }
        else
        {
            o[f.name] = scalarFromArray(a, p, at);
        }
    }
    return o;
}

function scalarFromArray(a: NumericArray, p: PrimitiveInfo, i: number): unknown
{
    if (p.stride === 2) return { real: a[i], imag: a[i + 1] };
    if (p.type === DataTypes.bool_t) return a[i] !== 0;
    return a[i];
}

/** Convert one value to the declared numeric type. Values that would change are rejected */
function convertNumber(x: unknown, p: PrimitiveInfo, where: string): number | bigint
{
    const invalid = () => dataError(`Invalid ${p.name} value for ${where}: ${String(x)}`);

    if (p.type === DataTypes.bool_t)
    {
        if (x === true || x === 1 || x === 1n) return 1;
        if (x === false || x === 0 || x === 0n) return 0;
        throw invalid();
    }
    if (typeof x !== "number" && typeof x !== "bigint") throw invalid();

    if (p.ctor === (Float64Array as unknown) || p.ctor === (Float32Array as unknown))
    {
        const n = Number(x);
        if (typeof x === "bigint" && BigInt(n) !== x) throw invalid();
        if (p.ctor === (Float32Array as unknown) && Number.isFinite(n) && !Number.isFinite(Math.fround(n))) throw invalid();
        return n;
    }

    if (typeof x === "number" && !Number.isSafeInteger(x)) throw invalid();
    const bits = p.size * 8;
    const signed = !p.name.startsWith("u");
    // These limits are exactly representable, and comparing a bigint to a number is exact
    if (x < (signed ? -(2 ** (bits - 1)) : 0) || x >= (signed ? 2 ** (bits - 1) : 2 ** bits)) throw invalid();
    return bits === 64 ? BigInt(x) : Number(x);
}

function isArrayValue(v: unknown): v is ArrayLike<unknown>
{
    return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));
}

/** Get the declared typed array from a plain array or a typed array of another type */
function toNumericArray(v: unknown, p: PrimitiveInfo, where: string): NumericArray
{
    if (!isArrayValue(v)) throw dataError(`Expected array for ${where}`);
    if (p.stride === 2 && Array.isArray(v) && v.some(isComplexObject))
    {
        const a = new p.ctor(v.length * 2) as unknown as (number | bigint)[];
        v.forEach((c, i) =>
        {
            if (!isComplexObject(c)) throw dataError(`Invalid ${p.name} value for ${where}: ${String(c)}`);
            a[i * 2] = convertNumber(c.real, p, where);
            a[i * 2 + 1] = convertNumber(c.imag, p, where);
        });
        return a as unknown as NumericArray;
    }

    if (v.length % p.stride !== 0) throw dataError(`Interleaved complex array has odd length for ${where}`);
    // Boolean arrays share Uint8Array so their values must always be checked
    if (v instanceof p.ctor && p.type !== DataTypes.bool_t) return v as NumericArray;

    const a = new p.ctor(v.length) as unknown as (number | bigint)[];
    for (let i = 0; i < v.length; i++) a[i] = convertNumber(v[i], p, where);
    return a as unknown as NumericArray;
}

/** Get a typed array holding one scalar, given a value or a single element array */
function toScalarArray(v: unknown, p: PrimitiveInfo, where: string): NumericArray
{
    if (isArrayValue(v))
    {
        const a = toNumericArray(v, p, where);
        if (a.length !== p.stride) throw dataError(`Expected scalar for ${where}`);
        return a;
    }
    if (p.stride === 1) return toNumericArray([v], p, where);
    return toNumericArray(isComplexObject(v) ? [v] : [v, 0], p, where);
}

function verifyArrayLength(count: number, t: TypeDefinition): void
{
    const len = t.arrayLength?.[0] ?? 0;
    if (len !== 0 && (t.arrayVarLength ? count > len : count !== len)) throw dataError("Array dimension mismatch");
}

function verifyDims(dims: ArrayLike<number>, t: TypeDefinition): void
{
    if (t.arrayVarLength) return;
    const len = t.arrayLength!;
    if (len.length === 1)
    {
        // Core treats [N,] as a multidimensional array with a total element count of N
        if (Array.from(dims).reduce((a, b) => a * b, 1) !== len[0]) throw dataError("Array dimension mismatch");
        return;
    }
    if (dims.length !== len.length || len.some((x, i) => x !== dims[i])) throw dataError("Array dimension mismatch");
}

function toDims(v: unknown, where: string): Uint32Array
{
    return toNumericArray(v, primitivesByName.get("uint32")!, where + " dims") as Uint32Array;
}

function toItems(v: unknown, where: string): Record<string, unknown>[]
{
    if (!Array.isArray(v)) throw dataError(`Expected Array for ${where}`);
    return v as Record<string, unknown>[];
}

function isMultiDimValue(v: unknown): v is MultiDimArray
{
    return typeof v === "object" && v !== null && "dims" in v && "array" in v;
}

function toMultiDim(v: unknown, t: TypeDefinition, name: string): { dims: Uint32Array; array: unknown }
{
    if (!isMultiDimValue(v)) throw dataError(`Expected { dims, array } for ${name}`);
    const dims = toDims(v.dims, name);
    verifyDims(dims, t);
    return { dims, array: v.array };
}

function withoutContainer(t: TypeDefinition): TypeDefinition
{
    const { container: _, ...rest } = t;
    return rest;
}

function typeNameFromValue(v: unknown): string
{
    if (typeof v === "string") return "string";
    for (const p of primitivesByName.values())
    {
        if (p.stride === 1 && p.type !== DataTypes.bool_t && v instanceof p.ctor) return p.name + "[]";
    }
    throw dataError("varvalue data must be a VarValue, typed array, string, or null");
}

/** Pack a value of the given type into a named message element */
export function packElement(name: string, t: TypeDefinition, v: unknown, scope: ServiceDefinition, ctx: TypeContext): MessageElement
{
    if (t.container)
    {
        return packContainer(name, t, v, scope, ctx);
    }
    if (t.type === "varvalue")
    {
        if (v === null || v === undefined) return new MessageElement(name, DataTypes.void_t, null);
        const var_v = v instanceof VarValue ? v : new VarValue(v, typeNameFromValue(v));
        return packElement(name, parseTypeDefinition(var_v.type), var_v.value, scope, ctx);
    }
    if (t.type === "string")
    {
        if (typeof v !== "string") throw dataError("Expected string for " + name);
        return MessageElement.string(name, v);
    }
    const p = primitivesByName.get(t.type);
    if (p) return packNumeric(name, t, v, p);

    const r = ctx.resolve(t.type, scope);
    switch (r.kind)
    {
    case "enum":
        return new MessageElement(name, DataTypes.int32_t, Int32Array.of(convertNumber(v, primitivesByName.get("int32")!, name) as number));
    case "struct":
        return packStructure(name, v, r, ctx);
    case "pod":
        return packPod(name, t, v, r, ctx);
    case "namedarray":
        return packNamedArray(name, t, v, r, ctx);
    default:
        throw dataError("Cannot pack object type: " + t.type);
    }
}

function packContainer(name: string, t: TypeDefinition, v: unknown, scope: ServiceDefinition, ctx: TypeContext): MessageElement
{
    const c = t.container;
    if (c === "generator") throw dataError("Generators cannot be packed as values");
    if (v === null || v === undefined) return new MessageElement(name, DataTypes.void_t, null);

    const item = withoutContainer(t);
    const elements: MessageElement[] = [];
    if (c === "list")
    {
        if (!isArrayValue(v)) throw dataError("Expected Array for list " + name);
        Array.from(v).forEach((x, i) => elements.push(packElement(String(i), item, x, scope, ctx)));
        return MessageElement.nested(name, DataTypes.list_t, "", elements);
    }
    if (typeof v !== "object" || isArrayValue(v)) throw dataError("Expected Map for " + name);
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
    for (const [k, x] of entries)
    {
        if (c === "map_string" && typeof k !== "string") throw dataError("Invalid map key for " + name);
        const key = c === "map_string" ? k : convertNumber(typeof k === "string" && /^-?\d+$/.test(k) ? Number(k) : k, primitivesByName.get("int32")!, name + " key");
        elements.push(packElement(String(key), item, x, scope, ctx));
    }
    return MessageElement.nested(name, c === "map_int32" ? DataTypes.vector_t : DataTypes.dictionary_t, "", elements);
}

function packNumeric(name: string, t: TypeDefinition, v: unknown, p: PrimitiveInfo): MessageElement
{
    if (t.array === "multidimarray")
    {
        const { dims, array: source } = toMultiDim(v, t, name);
        const array = toNumericArray(source, p, name);
        if (dims.reduce((a, b) => a * b, 1) * p.stride !== array.length) throw dataError("Array dimension mismatch for " + name);
        return MessageElement.nested(name, DataTypes.multidimarray_t, "", [new MessageElement("dims", DataTypes.uint32_t, dims), new MessageElement("array", p.type, array)]);
    }
    if (t.array)
    {
        const a = toNumericArray(v, p, name);
        verifyArrayLength(a.length / p.stride, t);
        return new MessageElement(name, p.type, a);
    }
    return new MessageElement(name, p.type, toScalarArray(v, p, name));
}

function flatPodFieldType(t: TypeDefinition): TypeDefinition
{
    return { ...t, array: "array", arrayLength: [t.arrayLength!.reduce((a, b) => a * b, 1)], arrayVarLength: false };
}

function packFields(v: Record<string, unknown>, r: ResolvedType, ctx: TypeContext): MessageElement[]
{
    if (typeof v !== "object" || isArrayValue(v)) throw dataError("Expected object for " + r.qualifiedName);
    return r.entry!.members.map((m) =>
    {
        const t = m.type!;
        // Fixed multidimensional pod fields are sent flattened since the dimensions are known
        if (r.kind !== "pod" || t.array !== "multidimarray") return packElement(m.name, t, v[m.name], r.def, ctx);
        return packElement(m.name, flatPodFieldType(t), toMultiDim(v[m.name], t, m.name).array, r.def, ctx);
    });
}

function packStructure(name: string, v: unknown, r: ResolvedType, ctx: TypeContext): MessageElement
{
    if (v === null || v === undefined) return new MessageElement(name, DataTypes.void_t, null);
    return MessageElement.nested(name, DataTypes.structure_t, r.qualifiedName, packFields(v as Record<string, unknown>, r, ctx));
}

function packPodArray(name: string, items: Record<string, unknown>[], r: ResolvedType, ctx: TypeContext): MessageElement
{
    const elements = items.map((x, i) => MessageElement.nested(String(i), DataTypes.pod_t, "", packFields(x, r, ctx)));
    return MessageElement.nested(name, DataTypes.pod_array_t, r.qualifiedName, elements);
}

function packPod(name: string, t: TypeDefinition, v: unknown, r: ResolvedType, ctx: TypeContext): MessageElement
{
    if (v === null || v === undefined) throw dataError("Expected pod for " + name);
    if (t.array === "multidimarray")
    {
        const { dims, array } = toMultiDim(v, t, name);
        const items = toItems(array, name);
        if (dims.reduce((a, b) => a * b, 1) !== items.length) throw dataError("Array dimension mismatch for " + name);
        return MessageElement.nested(name, DataTypes.pod_multidimarray_t, r.qualifiedName, [new MessageElement("dims", DataTypes.uint32_t, dims), packPodArray("array", items, r, ctx)]);
    }
    if (t.array)
    {
        const items = toItems(v, name);
        verifyArrayLength(items.length, t);
        return packPodArray(name, items, r, ctx);
    }
    return packPodArray(name, [v as Record<string, unknown>], r, ctx);
}

function packNamedArrayItems(name: string, items: Record<string, unknown>[], r: ResolvedType, ctx: TypeContext): MessageElement
{
    const l = ctx.namedArrayLayout(r);
    const a = new l.prim.ctor(items.length * l.length);
    items.forEach((x, i) => writeNamedArray(l, x, a, i * l.length));
    return MessageElement.nested(name, DataTypes.namedarray_array_t, r.qualifiedName, [new MessageElement("array", l.prim.type, a)]);
}

function packNamedArray(name: string, t: TypeDefinition, v: unknown, r: ResolvedType, ctx: TypeContext): MessageElement
{
    if (v === null || v === undefined) throw dataError("Expected named array for " + name);
    if (t.array === "multidimarray")
    {
        const { dims, array } = toMultiDim(v, t, name);
        const items = toItems(array, name);
        if (dims.reduce((a, b) => a * b, 1) !== items.length) throw dataError("Array dimension mismatch for " + name);
        return MessageElement.nested(name, DataTypes.namedarray_multidimarray_t, r.qualifiedName, [new MessageElement("dims", DataTypes.uint32_t, dims), packNamedArrayItems("array", items, r, ctx)]);
    }
    if (t.array)
    {
        const items = toItems(v, name);
        verifyArrayLength(items.length, t);
        return packNamedArrayItems(name, items, r, ctx);
    }
    return packNamedArrayItems(name, [v as Record<string, unknown>], r, ctx);
}

/** Unpack a message element according to the given type */
export function unpackElement(e: MessageElement, t: TypeDefinition, scope: ServiceDefinition, ctx: TypeContext): unknown
{
    if (t.container)
    {
        return unpackContainer(e, t, scope, ctx);
    }
    if (t.type === "varvalue")
    {
        return unpackVarValue(e, scope, ctx);
    }
    if (e.elementType === DataTypes.void_t) return null;
    if (t.type === "string") return e.castString();

    const p = primitivesByName.get(t.type);
    if (p) return unpackNumeric(e, t, p);

    const r = ctx.resolve(t.type, scope);
    switch (r.kind)
    {
    case "enum":
        return (e.data as Int32Array)[0];
    case "struct":
        return unpackFields(e.castNested(DataTypes.structure_t).elements, r, ctx);
    case "pod":
        return unpackPod(e, t, r, ctx);
    case "namedarray":
        return unpackNamedArray(e, t, r, ctx);
    default:
        throw dataError("Cannot unpack object type: " + t.type);
    }
}

function unpackContainer(e: MessageElement, t: TypeDefinition, scope: ServiceDefinition, ctx: TypeContext): unknown
{
    if (e.elementType === DataTypes.void_t) return null;
    const item = withoutContainer(t);
    if (t.container === "list")
    {
        return e.castNested(DataTypes.list_t).elements.map((x, i) =>
        {
            if (Number(x.elementName) !== i) throw dataError("Error in list format");
            return unpackElement(x, item, scope, ctx);
        });
    }
    if (t.container === "map_int32")
    {
        return new Map(e.castNested(DataTypes.vector_t).elements.map((x) => [Number(x.elementName), unpackElement(x, item, scope, ctx)]));
    }
    return new Map(e.castNested(DataTypes.dictionary_t).elements.map((x) => [x.elementName, unpackElement(x, item, scope, ctx)]));
}

function unpackNumeric(e: MessageElement, t: TypeDefinition, p: PrimitiveInfo): unknown
{
    if (t.array === "multidimarray")
    {
        const l = e.castNested(DataTypes.multidimarray_t).elements;
        const dims = findData(l, "dims") as Uint32Array;
        const array = findData(l, "array") as NumericArray;
        if (dims.reduce((a, b) => a * b, 1) * p.stride !== array.length) throw dataError("Array dimension mismatch");
        return { dims, array };
    }
    if (e.elementType !== p.type) throw dataError("Unexpected data type for " + e.elementName);
    const a = e.data as NumericArray;
    if (t.array)
    {
        verifyArrayLength(a.length / p.stride, t);
        return a;
    }
    if (a.length !== p.stride) throw dataError("Invalid scalar for " + e.elementName);
    return scalarFromArray(a, p, 0);
}

function findData(l: MessageElement[], name: string): unknown
{
    const e = l.find((x) => x.elementName === name);
    if (!e) throw dataError("Message element not found: " + name);
    return e.data;
}

function unpackFields(elements: MessageElement[], r: ResolvedType, ctx: TypeContext): Record<string, unknown>
{
    const o: Record<string, unknown> = {};
    for (const m of r.entry!.members)
    {
        const e = elements.find((x) => x.elementName === m.name);
        const t = m.type!;
        if (e && r.kind === "pod" && t.array === "multidimarray")
        {
            o[m.name] = { dims: Uint32Array.from(t.arrayLength!), array: unpackElement(e, flatPodFieldType(t), r.def, ctx) };
            continue;
        }
        o[m.name] = e ? unpackElement(e, t, r.def, ctx) : null;
    }
    return o;
}

function unpackPodArray(e: MessageElement, r: ResolvedType, ctx: TypeContext): Record<string, unknown>[]
{
    return e.castNested(DataTypes.pod_array_t).elements.map((x) => unpackFields(x.castNested(DataTypes.pod_t).elements, r, ctx));
}

function unpackPod(e: MessageElement, t: TypeDefinition, r: ResolvedType, ctx: TypeContext): unknown
{
    if (t.array === "multidimarray")
    {
        const l = e.castNested(DataTypes.pod_multidimarray_t).elements;
        const a = l.find((x) => x.elementName === "array");
        if (!a) throw dataError("Message element not found: array");
        return { dims: findData(l, "dims"), array: unpackPodArray(a, r, ctx) };
    }
    const items = unpackPodArray(e, r, ctx);
    if (t.array)
    {
        verifyArrayLength(items.length, t);
        return items;
    }
    if (items.length !== 1) throw dataError("Invalid pod scalar");
    return items[0];
}

function unpackNamedArrayItems(e: MessageElement, r: ResolvedType, ctx: TypeContext): Record<string, unknown>[]
{
    const a = findData(e.castNested(DataTypes.namedarray_array_t).elements, "array") as NumericArray;
    const l = ctx.namedArrayLayout(r);
    if (a.length % l.length !== 0) throw dataError("Invalid named array length");
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < a.length; i += l.length) items.push(readNamedArray(l, a, i));
    return items;
}

function unpackNamedArray(e: MessageElement, t: TypeDefinition, r: ResolvedType, ctx: TypeContext): unknown
{
    if (t.array === "multidimarray")
    {
        const l = e.castNested(DataTypes.namedarray_multidimarray_t).elements;
        const a = l.find((x) => x.elementName === "array");
        if (!a) throw dataError("Message element not found: array");
        return { dims: findData(l, "dims"), array: unpackNamedArrayItems(a, r, ctx) };
    }
    const items = unpackNamedArrayItems(e, r, ctx);
    if (t.array)
    {
        verifyArrayLength(items.length, t);
        return items;
    }
    if (items.length !== 1) throw dataError("Invalid named array scalar");
    return items[0];
}

function varTypeString(e: MessageElement): string | null
{
    const name = e.elementTypeName;
    switch (e.elementType)
    {
    case DataTypes.void_t:
        return null;
    case DataTypes.string_t:
        return "string";
    case DataTypes.structure_t:
        return name;
    case DataTypes.pod_array_t:
    case DataTypes.namedarray_array_t:
        return name + "[]";
    case DataTypes.pod_multidimarray_t:
    case DataTypes.namedarray_multidimarray_t:
        return name + "[*]";
    case DataTypes.list_t:
        return "varvalue{list}";
    case DataTypes.vector_t:
        return "varvalue{int32}";
    case DataTypes.dictionary_t:
        return "varvalue{string}";
    case DataTypes.multidimarray_t:
        {
            const a = e.castNested().elements.find((x) => x.elementName === "array");
            return primitivesByType.get(a?.elementType as number)?.name + "[*]";
        }
    }
    const p = primitivesByType.get(e.elementType);
    if (!p) throw dataError("Invalid varvalue data type");
    return p.name + "[]";
}

function unpackVarValue(e: MessageElement, scope: ServiceDefinition, ctx: TypeContext): VarValue | null
{
    const type = varTypeString(e);
    if (type === null) return null;
    return new VarValue(unpackElement(e, parseTypeDefinition(type), scope, ctx), type);
}
