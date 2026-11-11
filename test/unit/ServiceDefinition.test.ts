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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { EntryDefinition, MemberDefinition, parseServiceDefinition, parseTypeDefinition, ServiceDefinition, TypeDefinition } from "../../src/ServiceDefinition.js";
import { verifyServiceDefinition, verifyServiceDefinitions } from "../../src/ServiceDefinitionValidators.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const robdef_dir = join(root, "test/robdef");
const oracle = JSON.parse(readFileSync(join(root, "test/fixtures/robdef_oracle.json"), "utf8"));
const files = readdirSync(robdef_dir).filter((x) => x.endsWith(".robdef"));
const parsed = new Map<string, ServiceDefinition>(files.map((f) => [f, parseServiceDefinition(readFileSync(join(robdef_dir, f), "utf8"))]));

function typeToString(t: TypeDefinition): string
{
    let s = t.type;
    if (t.array === "multidimarray")
    {
        s += t.arrayVarLength ? "[*]" : `[${t.arrayLength!.join(",")}${t.arrayLength!.length === 1 ? "," : ""}]`;
    }
    else if (t.array)
    {
        const n = t.arrayLength![0]!;
        s += n === 0 ? "[]" : `[${n}${t.arrayVarLength ? "-" : ""}]`;
    }
    if (t.container)
    {
        s += "{" + { list: "list", map_int32: "int32", map_string: "string", generator: "generator" }[t.container] + "}";
    }
    return s;
}

function memberToString(m: MemberDefinition): string
{
    const mods = m.modifiers && m.modifiers.length > 0 ? ` [${m.modifiers.join(",")}]` : "";
    const params = () => "(" + m.parameters!.map((p) => `${typeToString(p.type)} ${p.name}`).join(", ") + ")";
    const kw = m.kind === "field" ? "property" : m.kind;
    if (m.kind === "event") return `event ${m.name}${params()}${mods}`;
    if (m.parameters) return `${kw} ${typeToString(m.type!)} ${m.name}${params()}${mods}`;
    return `${kw} ${typeToString(m.type!)} ${m.name}${mods}`;
}

function normalize(s: string): string
{
    return s.replace(/\s+/g, " ").trim();
}

function compareEntries(actual: EntryDefinition[], expected: { name: string; implements: string[]; options: string[]; constants: string[]; members: string[] }[]): void
{
    assert.deepEqual(actual.map((x) => x.name), expected.map((x) => x.name));
    actual.forEach((e, i) =>
    {
        const x = expected[i]!;
        assert.deepEqual(e.implements, x.implements, e.name);
        assert.deepEqual(e.options, x.options, e.name);
        assert.deepEqual(e.constants.map((c) => normalize(`constant ${typeToString(c.type)} ${c.name} ${c.value}`)), x.constants.map(normalize), e.name);
        assert.deepEqual(e.members.map(memberToString), x.members.map(normalize), e.name);
    });
}

for (const f of files)
{
    test(`parser matches the Core parser for ${f}`, () =>
    {
        const d = parsed.get(f)!;
        const x = oracle[f];
        assert.equal(d.name, x.name);
        assert.deepEqual(d.imports, x.imports);
        assert.deepEqual(d.options, x.options);
        assert.deepEqual(d.using.map((u) => [u.qualifiedName, u.unqualifiedName]), x.using);
        assert.deepEqual(d.constants.map((c) => normalize(`constant ${typeToString(c.type)} ${c.name} ${c.value}`)), x.constants.map(normalize));
        assert.deepEqual(d.exceptions.map((e) => e.name), x.exceptions);
        assert.deepEqual(d.enums.map((e) => ({ name: e.name, values: e.values.map((v) => [v.name, v.value]) })), x.enums);
        compareEntries(d.structures, x.structures);
        compareEntries(d.pods, x.pods);
        compareEntries(d.namedArrays, x.namedArrays);
        compareEntries(d.objects, x.objects);
    });
}

test("parsed definitions are JSON round trippable", () =>
{
    for (const d of parsed.values()) assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});

test("standard definitions pass verification", () =>
{
    verifyServiceDefinitions(parsed.values());
});

test("documentation comments follow the Core rules", () =>
{
    const d = parsed.get("com.robotraconteur.testing.TestService4.robdef")!;
    assert.equal(d.docString, "\n service docstring line 1\n service docstring line 2\n\n service docstring line 3");
    assert.equal(d.structures[0]!.docString, " struct docstring line 1\n\n struct docstring line 3");
    const e = d.enums[0]!;
    assert.equal(e.values[0]!.docString, " enum_val1 docstring line1\n enum_val1 docstring line2");
    assert.equal(e.values[2]!.docString, " enum_val3 docstring");
    assert.equal(e.values[3]!.docString, undefined);
});

test("type parsing", () =>
{
    assert.deepEqual(parseTypeDefinition("double"), { type: "double" });
    assert.deepEqual(parseTypeDefinition("double[]"), { type: "double", array: "array", arrayLength: [0], arrayVarLength: true });
    assert.deepEqual(parseTypeDefinition("double[6]"), { type: "double", array: "array", arrayLength: [6], arrayVarLength: false });
    assert.deepEqual(parseTypeDefinition("double[6-]"), { type: "double", array: "array", arrayLength: [6], arrayVarLength: true });
    assert.deepEqual(parseTypeDefinition("double[*]"), { type: "double", array: "multidimarray", arrayLength: [], arrayVarLength: true });
    assert.deepEqual(parseTypeDefinition("a.b.c[3,2]{list}"), { type: "a.b.c", array: "multidimarray", arrayLength: [3, 2], arrayVarLength: false, container: "list" });
    assert.throws(() => parseTypeDefinition("double[]{bad}"));
    assert.throws(() => parseTypeDefinition("double[-]"));
});

function svc(body: string): string
{
    return `service test.svc\nstdver 0.10\n${body}\n`;
}

test("parser rejects malformed definitions", () =>
{
    const bad = [
        "object a\n",
        "stdver 0.10\nservice test.svc\n",
        "service test.svc\nservice test.svc2\n",
        svc("bogus statement"),
        svc("struct a\nfield double\nend"),
        svc("struct a\nproperty double b\nend"),
        svc("object a\nfield double b\nend"),
        svc("object a\nproperty double b\nimplements c\nend"),
        svc("struct a\nfield double b\nend struct"),
        svc("enum a\nb\nend"),
        svc("object a\nfunction double b\nend"),
        svc("object a\nproperty double b(int32 c)\nend"),
        svc("object a\nevent double b()\nend"),
        svc("object a\nproperty café b\nend"),
        svc("object a"),
        "service test.svc\\"
    ];
    for (const s of bad) assert.throws(() => parseServiceDefinition(s), Error, s);
});

test("entries must be in the same order as Core requires", () =>
{
    const object = "object o\nproperty double p\nend\n";
    const order_errors: [string, RegExp][] = [
        [svc(object + "exception e"), /exception must be before struct and object/],
        [svc(object + "constant int32 c 1"), /constant must be before struct and object/],
        [svc("struct s\nfield double f\nend\nenum e\na = 1\nend"), /enum must be before struct and object/],
        [svc("using a.b.c\nimport a.b"), /import must be before all but options/],
        [svc("exception e\nusing a.b.c"), /using must be after imports/],
        [svc("import a.b\nstdver 0.10"), /stdver must be first after service name/]
    ];
    for (const [s, message] of order_errors) assert.throws(() => parseServiceDefinition(s), message, s);
    // Exceptions, constants, and enums may be in any order before the first structure or object
    parseServiceDefinition(svc("enum e\na = 1\nend\nexception x\nconstant int32 c 1\n" + object));
});

function verifies(body: string): void
{
    verifyServiceDefinition(parseServiceDefinition(svc(body)));
}

test("validators accept a valid definition", () =>
{
    verifies("constant int32 c1 5\nenum e\na = 1, b\nend\nstruct s\nfield double[] d\nend\nobject o\nproperty s p\nfunction e f(double[] x)\nend");
});

test("validators reject semantic errors", () =>
{
    const bad = [
        "struct a\nfield b c\nend",
        "struct a\nfield double b\nfield double b\nend",
        "struct a\nfield double b\nend\nstruct a\nfield double c\nend",
        "struct get_a\nfield double b\nend",
        "struct rr_a\nfield double b\nend",
        "struct end1\nfield double _b\nend",
        "struct a\nfield string[] b\nend",
        "constant int8 c 500",
        "constant double c abc",
        'constant string c "bad\\q"',
        "pod a\nfield double[] b\nend",
        "pod a\nfield string b\nend",
        "pod a\nfield a b\nend",
        "namedarray a\nfield double x\nfield single y\nend",
        "namedarray a\nfield a b\nend",
        "object a\nproperty void b\nend",
        "object a\nproperty double{generator} b\nend",
        "object a\nmemory double b\nend",
        "object a\nobjref double b\nend",
        "object a\nfunction void f(double{generator} g, double b)\nend",
        "object a\nimplements b\nend",
        "object b\nproperty double c\nend\nobject a\nimplements b\nend",
        "object b\nproperty double c\nend\nobject a\nimplements b\nproperty int32 c\nend",
        "import other.svc"
    ];
    for (const b of bad) assert.throws(() => verifies(b), Error, b);
});
