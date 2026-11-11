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

import { EntryDefinition, MemberDefinition, readLines, ServiceDefinition, TypeDefinition } from "./ServiceDefinition.js";

// Semantic checks for parsed service definitions. Imported separately through
// "robotraconteur/validators" so applications that trust their definitions do not bundle this.

export class ServiceDefinitionVerifyError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = "ServiceDefinitionVerifyError";
    }
}

const NUMERIC = new Set(["double", "single", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "cdouble", "csingle", "bool"]);
const RESERVED = new Set([
    "object", "end", "option", "service", "struct", "import", "implements", "field", "property", "function", "event", "objref",
    "pipe", "callback", "wire", "memory", "void", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
    "single", "double", "string", "varvalue", "varobject", "exception", "using", "constant", "enum", "pod", "namedarray",
    "cdouble", "csingle", "bool", "stdver"
]);

const INT = "[+\\-]?(?:0|[1-9]\\d*)";
const HEX = "[+\\-]?0x[\\da-fA-F]+";
const FLOAT = "[+\\-]?(?:(?:0|[1-9]\\d*)(?:\\.\\d*)?|(?:\\.\\d+))(?:[eE][+\\-]?\\d+)?";
const R_INT = new RegExp(`^(?:${INT}|${HEX})$`);
const R_FLOAT = new RegExp(`^${FLOAT}$`);
const R_STRING = /^"(?:\\["\\/bfnrt]|\\u[\da-fA-F]{4}|[^"\\])*"$/;
const R_NAME = /^[a-zA-Z](?:\w*[a-zA-Z0-9])?$/;

const INT_RANGES: Record<string, [bigint, bigint]> = {
    int8: [-128n, 127n],
    uint8: [0n, 255n],
    int16: [-32768n, 32767n],
    uint16: [0n, 65535n],
    int32: [-2147483648n, 2147483647n],
    uint32: [0n, 4294967295n],
    int64: [-9223372036854775808n, 9223372036854775807n],
    uint64: [0n, 18446744073709551615n]
};

function fail(message: string): never
{
    throw new ServiceDefinitionVerifyError(message);
}

function verifyName(name: string, what: string): void
{
    if (!R_NAME.test(name)) fail(`Invalid ${what} name "${name}"`);
    if (/^(?:rr|robotraconteur)/i.test(name) || /^(?:get_|set_|async_)/.test(name)) fail(`${what} name "${name}" uses a reserved prefix`);
    if (RESERVED.has(name)) fail(`${what} name "${name}" is a keyword`);
}

function verifyUnique(names: string[], scope: string): void
{
    const seen = new Set<string>();
    for (const n of names)
    {
        if (seen.has(n)) fail(`Duplicate name "${n}" in ${scope}`);
        seen.add(n);
    }
}

function parseIntValue(s: string): bigint
{
    const negative = s.startsWith("-");
    const v = BigInt(s.replace(/^[+\-]/, ""));
    return negative ? -v : v;
}

function verifyIntValue(s: string, type: string, name: string): void
{
    if (!R_INT.test(s)) fail(`Invalid value for constant "${name}"`);
    const v = parseIntValue(s);
    const r = INT_RANGES[type]!;
    if (v < r[0] || v > r[1]) fail(`Value out of range for constant "${name}"`);
}

function verifyConstant(c: ServiceDefinition["constants"][number], def: ServiceDefinition): void
{
    verifyName(c.name, "constant");
    const t = c.type;
    const v = c.value;

    if (t.type === "struct")
    {
        if (!/^\{[ \t]*(?:\w+[ \t]*:[ \t]*\w+(?:[ \t]*,[ \t]*\w+[ \t]*:[ \t]*\w+)*[ \t]*)?\}$/.test(v)) fail(`Invalid struct constant "${c.name}"`);
        for (const m of v.matchAll(/:[ \t]*(\w+)/g))
        {
            if (!def.constants.some((x) => x.name === m[1])) fail(`Unknown constant "${m[1]}" in "${c.name}"`);
        }
        return;
    }
    if (t.container) fail(`Invalid type for constant "${c.name}"`);
    if (t.type === "string")
    {
        if (t.array || !R_STRING.test(v)) fail(`Invalid value for constant "${c.name}"`);
        return;
    }

    const is_float = t.type === "double" || t.type === "single";
    if (!is_float && !(t.type in INT_RANGES)) fail(`Invalid type for constant "${c.name}"`);
    const verifyOne = (s: string) =>
    {
        if (is_float)
        {
            if (!R_FLOAT.test(s)) fail(`Invalid value for constant "${c.name}"`);
        }
        else
        {
            verifyIntValue(s, t.type, c.name);
        }
    };

    if (!t.array)
    {
        verifyOne(v);
        return;
    }
    if (t.array !== "array" || t.arrayLength![0] !== 0) fail(`Invalid type for constant "${c.name}"`);
    const a = /^\{(.*)\}$/.exec(v);
    if (!a) fail(`Invalid value for constant "${c.name}"`);
    if (a[1]!.trim() !== "") a[1]!.split(",").forEach((x) => verifyOne(x.trim()));
}

type Resolved = { kind: "struct" | "pod" | "namedarray" | "object" | "enum" | "exception"; name: string; entry?: EntryDefinition; def: ServiceDefinition };

function resolve(name: string, def: ServiceDefinition, defs: Map<string, ServiceDefinition>): Resolved
{
    let q = name;
    if (!q.includes("."))
    {
        const u = def.using.find((x) => x.unqualifiedName === q);
        if (u) q = u.qualifiedName;
    }

    let target = def;
    let entry_name = q;
    const i = q.lastIndexOf(".");
    if (i >= 0)
    {
        const s = q.substring(0, i);
        entry_name = q.substring(i + 1);
        if (s !== def.name && !def.imports.includes(s)) fail(`Service "${s}" used by "${name}" is not imported by ${def.name}`);
        const t = defs.get(s);
        if (!t) fail(`Service definition "${s}" not found`);
        target = t;
    }

    const groups: [Resolved["kind"], EntryDefinition[]][] = [["struct", target.structures], ["pod", target.pods], ["namedarray", target.namedArrays], ["object", target.objects]];
    for (const [kind, list] of groups)
    {
        const entry = list.find((x) => x.name === entry_name);
        if (entry) return { kind, name: entry_name, entry, def: target };
    }
    if (target.enums.some((x) => x.name === entry_name)) return { kind: "enum", name: entry_name, def: target };
    if (target.exceptions.some((x) => x.name === entry_name)) return { kind: "exception", name: entry_name, def: target };
    fail(`Unknown type "${name}" in ${def.name}`);
}

interface VerifyContext
{
    def: ServiceDefinition;
    defs: Map<string, ServiceDefinition>;
}

function verifyType(t: TypeDefinition, where: string, c: VerifyContext, opt: { void?: boolean; generator?: boolean; object?: boolean } = {}): void
{
    if (t.container === "generator" && !opt.generator) fail(`Generator type not allowed for ${where}`);
    if (t.type === "void")
    {
        if (!opt.void || t.array || (t.container && t.container !== "generator")) fail(`Invalid void type for ${where}`);
        return;
    }
    if (t.type === "varobject")
    {
        if (!opt.object) fail(`Invalid type for ${where}`);
        return;
    }
    if (t.type === "varvalue" || t.type === "string")
    {
        if (t.array) fail(`Type ${t.type} may not be an array for ${where}`);
        return;
    }
    if (NUMERIC.has(t.type)) return;

    const r = resolve(t.type, c.def, c.defs);
    if (r.kind === "object" && !opt.object) fail(`Object type not allowed for ${where}`);
    if (r.kind === "exception") fail(`Exception type not allowed for ${where}`);
    if ((r.kind === "struct" || r.kind === "enum") && t.array) fail(`Type "${t.type}" may not be an array for ${where}`);
}

function verifyPodField(t: TypeDefinition, where: string, c: VerifyContext): void
{
    if (t.container || (t.array && (t.arrayLength!.length === 0 || t.arrayLength!.includes(0)))) fail(`Invalid pod field type for ${where}`);
    if (t.array === "multidimarray" && t.arrayVarLength) fail(`Invalid pod field type for ${where}`);
    if (NUMERIC.has(t.type)) return;
    const r = resolve(t.type, c.def, c.defs);
    if (r.kind !== "pod" && r.kind !== "namedarray") fail(`Invalid pod field type for ${where}`);
}

function namedArrayPrimitive(e: EntryDefinition, def: ServiceDefinition, defs: Map<string, ServiceDefinition>, path: Set<EntryDefinition>): string
{
    if (path.has(e)) fail(`Recursive namedarray "${e.name}"`);
    path.add(e);
    let prim: string | undefined;
    for (const m of e.members)
    {
        const t = m.type!;
        if (t.container || t.array === "multidimarray" || (t.array && (t.arrayVarLength || !t.arrayLength![0]))) fail(`Invalid namedarray field "${m.name}"`);
        let p = t.type;
        if (!NUMERIC.has(p))
        {
            const r = resolve(p, def, defs);
            if (r.kind !== "namedarray") fail(`Invalid namedarray field "${m.name}"`);
            p = namedArrayPrimitive(r.entry!, r.def, defs, path);
        }
        if (prim !== undefined && p !== prim) fail(`Namedarray "${e.name}" must use a single numeric type`);
        prim = p;
    }
    path.delete(e);
    if (prim === undefined) fail(`Namedarray "${e.name}" has no fields`);
    return prim;
}

function verifyPodRecursion(e: EntryDefinition, def: ServiceDefinition, defs: Map<string, ServiceDefinition>, path: Set<EntryDefinition>): void
{
    if (path.has(e)) fail(`Recursive pod "${e.name}"`);
    path.add(e);
    for (const m of e.members)
    {
        if (NUMERIC.has(m.type!.type)) continue;
        const r = resolve(m.type!.type, def, defs);
        if (r.kind === "pod") verifyPodRecursion(r.entry!, r.def, defs, path);
    }
    path.delete(e);
}

function verifyMember(m: MemberDefinition, c: VerifyContext): void
{
    const where = `member "${m.name}"`;
    verifyName(m.name, "member");
    const t = m.type;
    const params = m.parameters ?? [];
    verifyUnique(params.map((x) => x.name), where);
    params.forEach((p, i) =>
    {
        verifyName(p.name, "parameter");
        verifyType(p.type, `parameter "${p.name}" of ${where}`, c, { generator: m.kind === "function" && i === params.length - 1 });
    });

    switch (m.kind)
    {
    case "function":
        verifyType(t!, where, c, { void: true, generator: true });
        break;
    case "callback":
        verifyType(t!, where, c, { void: true });
        break;
    case "objref":
        if (t!.type !== "varobject" && resolve(t!.type, c.def, c.defs).kind !== "object") fail(`Invalid objref type for ${where}`);
        if (t!.array && (t!.array !== "array" || !t!.arrayVarLength || t!.arrayLength![0] !== 0)) fail(`Invalid objref type for ${where}`);
        if (t!.container === "list" || t!.container === "generator") fail(`Invalid objref type for ${where}`);
        break;
    case "memory":
        if (!t!.array || t!.container || !t!.arrayVarLength || (t!.array === "array" && t!.arrayLength![0] !== 0)) fail(`Invalid memory type for ${where}`);
        if (!NUMERIC.has(t!.type))
        {
            const r = resolve(t!.type, c.def, c.defs);
            if (r.kind !== "pod" && r.kind !== "namedarray") fail(`Invalid memory type for ${where}`);
        }
        break;
    case "event":
        break;
    default:
        verifyType(t!, where, c);
    }
}

function typeString(t: TypeDefinition | undefined, def: ServiceDefinition, defs: Map<string, ServiceDefinition>): string
{
    if (!t) return "";
    let name = t.type;
    if (!NUMERIC.has(name) && !["string", "void", "varvalue", "varobject"].includes(name))
    {
        const r = resolve(name, def, defs);
        name = r.def.name + "." + r.name;
    }
    return `${name}|${t.array ?? ""}|${(t.arrayLength ?? []).join(",")}|${t.arrayVarLength ?? ""}|${t.container ?? ""}`;
}

function memberSignature(m: MemberDefinition, def: ServiceDefinition, defs: Map<string, ServiceDefinition>): string
{
    const params = (m.parameters ?? []).map((p) => `${p.name}:${typeString(p.type, def, defs)}`).join(";");
    return `${m.kind} ${typeString(m.type, def, defs)} (${params})`;
}

function verifyImplements(e: EntryDefinition, c: VerifyContext): void
{
    for (const name of e.implements)
    {
        const r = resolve(name, c.def, c.defs);
        if (r.kind !== "object") fail(`Object "${e.name}" implements non-object "${name}"`);
        for (const m of r.entry!.members)
        {
            const own = e.members.find((x) => x.name === m.name);
            if (!own) fail(`Object "${e.name}" does not implement member "${m.name}" of "${name}"`);
            if (memberSignature(own, c.def, c.defs) !== memberSignature(m, r.def, c.defs))
            {
                fail(`Member "${m.name}" of "${e.name}" does not match "${name}"`);
            }
        }
    }
}

function verifyEntry(e: EntryDefinition, kind: "struct" | "pod" | "namedarray" | "object", c: VerifyContext): void
{
    verifyName(e.name, kind);
    verifyUnique([...e.constants.map((x) => x.name), ...e.members.map((x) => x.name)], `${kind} "${e.name}"`);
    e.constants.forEach((x) => verifyConstant(x, c.def));
    if (kind !== "object" && e.members.length === 0) fail(`${kind} "${e.name}" has no fields`);

    if (kind === "object")
    {
        e.members.forEach((m) => verifyMember(m, c));
        verifyImplements(e, c);
        return;
    }

    for (const m of e.members)
    {
        verifyName(m.name, "field");
        if (kind === "struct") verifyType(m.type!, `field "${m.name}"`, c);
        if (kind === "pod") verifyPodField(m.type!, `field "${m.name}"`, c);
    }
    if (kind === "pod") verifyPodRecursion(e, c.def, c.defs, new Set());
    if (kind === "namedarray") namedArrayPrimitive(e, c.def, c.defs, new Set());
}

/** Verify one service definition against the other definitions it imports */
export function verifyServiceDefinition(def: ServiceDefinition, others: Iterable<ServiceDefinition> = []): void
{
    const defs = new Map<string, ServiceDefinition>();
    for (const d of others) defs.set(d.name, d);
    defs.set(def.name, def);
    const c: VerifyContext = { def, defs };

    if (!/^[a-zA-Z](?:\w*[a-zA-Z0-9])?(?:\.[a-zA-Z](?:\w*[a-zA-Z0-9])?)*$/.test(def.name)) fail(`Invalid service name "${def.name}"`);
    verifyUnique(def.imports, `imports of ${def.name}`);

    const top = [
        ...def.constants.map((x) => x.name),
        ...def.enums.map((x) => x.name),
        ...def.exceptions.map((x) => x.name),
        ...def.structures.map((x) => x.name),
        ...def.pods.map((x) => x.name),
        ...def.namedArrays.map((x) => x.name),
        ...def.objects.map((x) => x.name),
        ...def.using.map((x) => x.unqualifiedName)
    ];
    verifyUnique(top, def.name);

    for (const imp of def.imports)
    {
        if (!defs.has(imp)) fail(`Service definition "${imp}" imported by ${def.name} not found`);
    }
    for (const u of def.using)
    {
        verifyName(u.unqualifiedName, "using");
        resolve(u.qualifiedName, def, defs);
    }

    def.constants.forEach((x) => verifyConstant(x, def));
    def.exceptions.forEach((x) => verifyName(x.name, "exception"));
    for (const e of def.enums)
    {
        verifyName(e.name, "enum");
        verifyUnique(e.values.map((x) => x.name), `enum "${e.name}"`);
        for (const v of e.values)
        {
            verifyName(v.name, "enum value");
            if (v.value < -2147483648 || v.value > 2147483647) fail(`Enum value "${v.name}" out of range`);
        }
    }

    def.structures.forEach((e) => verifyEntry(e, "struct", c));
    def.pods.forEach((e) => verifyEntry(e, "pod", c));
    def.namedArrays.forEach((e) => verifyEntry(e, "namedarray", c));
    def.objects.forEach((e) => verifyEntry(e, "object", c));
}

/** Verify a set of service definitions that may import each other */
export function verifyServiceDefinitions(defs: Iterable<ServiceDefinition>): void
{
    const all = [...defs];
    verifyUnique(all.map((x) => x.name), "service definition set");
    all.forEach((d) => verifyServiceDefinition(d, all));
}

/** For each top level entry, the order it sets, the order it must come before, and the error otherwise */
const ENTRY_ORDER = new Map<string, [number, number, string]>([
    ["stdver", [2, 2, "stdver must be first after service name"]],
    ["import", [4, 5, "import must be before all but options"]],
    ["using", [5, 6, "using must be after imports and before all others except options"]],
    ["exception", [6, 9, "exception must be before struct and object"]],
    ["constant", [7, 9, "constant must be before struct and object"]],
    ["enum", [8, 9, "enum must be before struct and object"]]
]);

/**
 * Verify that the entries of a service definition are in the order Core requires: stdver, then
 * imports, then using, then exceptions, constants, and enums, then structures and objects. Options
 * may be anywhere. Core rejects definitions in another order, so services check the definitions
 * they send to clients. The parser itself accepts any order.
 */
export function verifyServiceDefinitionOrder(text: string): void
{
    let order = 0;
    let in_block = false;
    for (const line of readLines(text))
    {
        const keyword = /^[ \t]*(\w*)/.exec(line.text)![1]!;
        if (in_block)
        {
            in_block = keyword !== "end";
            continue;
        }
        if (keyword === "service" || keyword === "option") continue;
        const o = ENTRY_ORDER.get(keyword);
        if (o && order >= o[1]) fail(`${o[2]} (line ${line.number})`);
        order = o ? o[0] : 9;
        // enum, struct, pod, namedarray, and object are blocks closed by end
        in_block = !o || keyword === "enum";
    }
}
