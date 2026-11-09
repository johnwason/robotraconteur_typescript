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

// Small parser for Robot Raconteur service definition files. The result is plain JSON compatible
// data described by service-definition.schema.json. Semantic checks are in
// ServiceDefinitionValidators.ts so that they are not included in bundles that do not need them.

export type ContainerType = "list" | "map_int32" | "map_string" | "generator";

export interface TypeDefinition
{
    /** Primitive type name, "varvalue", "varobject", or a possibly qualified named type */
    type: string;
    /** Omitted for types that are not arrays */
    array?: "array" | "multidimarray";
    /** Fixed or maximum dimensions. Zero or empty for unconstrained */
    arrayLength?: number[];
    /** True for variable length or unconstrained arrays */
    arrayVarLength?: boolean;
    /** Omitted for types without a container */
    container?: ContainerType;
}

export interface ParameterDefinition
{
    name: string;
    type: TypeDefinition;
}

export type MemberKind = "field" | "property" | "function" | "event" | "objref" | "pipe" | "callback" | "wire" | "memory";

export interface MemberDefinition
{
    kind: MemberKind;
    name: string;
    /** Value type, or return type for function and callback members. Omitted for events */
    type?: TypeDefinition;
    /** Present for function, event, and callback members */
    parameters?: ParameterDefinition[];
    modifiers?: string[];
    docString?: string;
}

export interface ConstantDefinition
{
    name: string;
    type: TypeDefinition;
    /** Value exactly as written in the service definition */
    value: string;
    docString?: string;
}

export interface EntryDefinition
{
    name: string;
    implements: string[];
    options: string[];
    constants: ConstantDefinition[];
    members: MemberDefinition[];
    docString?: string;
}

export interface EnumValue
{
    name: string;
    value: number;
    docString?: string;
}

export interface EnumDefinition
{
    name: string;
    values: EnumValue[];
    docString?: string;
}

export interface UsingDefinition
{
    qualifiedName: string;
    unqualifiedName: string;
}

export interface ExceptionDefinition
{
    name: string;
    docString?: string;
}

export interface ServiceDefinition
{
    name: string;
    stdVer?: string;
    docString?: string;
    imports: string[];
    using: UsingDefinition[];
    options: string[];
    constants: ConstantDefinition[];
    enums: EnumDefinition[];
    exceptions: ExceptionDefinition[];
    structures: EntryDefinition[];
    pods: EntryDefinition[];
    namedArrays: EntryDefinition[];
    objects: EntryDefinition[];
}

export class ServiceDefinitionParseError extends Error
{
    constructor(message: string, public lineNumber: number)
    {
        super(`${message} (line ${lineNumber})`);
        this.name = "ServiceDefinitionParseError";
    }
}

interface Line
{
    text: string;
    number: number;
    doc?: string;
}

const NAME = "[a-zA-Z](?:\\w*[a-zA-Z0-9])?";
const QUALIFIED = `${NAME}(?:\\.${NAME})*`;
const TYPE2 = `${QUALIFIED}(?:\\[[0-9,*\\-]*\\])?(?:\\{\\w{1,16}\\})?`;
const B = "[ \\t]";

const R_ENTRY = new RegExp(`^${B}*(service|stdver|option|import|using|exception|constant|enum|struct|object|pod|namedarray)${B}+(\\w\\S*(?:${B}+\\S+)*)${B}*$`);
const R_BLOCK_START = new RegExp(`^${B}*\\w{1,16}${B}+(${NAME})${B}*$`);
const R_END = new RegExp(`^${B}*end(?:${B}+(\\w{1,16}))?${B}*$`);
const R_MEMBER_LINE = new RegExp(`^${B}*(option|implements|constant|field|property|function|event|objref|pipe|callback|wire|memory)${B}+(\\w\\S*(?:${B}+\\S+)*)${B}*$`);
const R_MEMBER = new RegExp(`^${B}*([a-zA-Z]+)${B}+(?:([a-zA-Z][\\w{}\\[\\]*,\\-.]*)${B}+)?(\\w+)(?:${B}*(\\(([^)]*)\\)))?(?:${B}+\\[([^\\]]*)\\])?${B}*$`);
const R_PARAM = new RegExp(`^${B}*(${TYPE2})${B}+(\\w+)${B}*(?:,(.*))?$`);
const R_TYPE = new RegExp(`^${B}*([a-zA-Z][\\w.]*)(?:(\\[\\])|\\[(?:([0-9]+)|([0-9]+)-|(\\*)|([0-9]+),|([0-9,]+))\\])?(?:\\{(\\w{1,16})\\})?${B}*$`);
const R_USING = new RegExp(`^(${QUALIFIED}\\.${NAME})(?:${B}+as${B}(${NAME}))?$`);
const R_CONSTANT = new RegExp(`^(${TYPE2})${B}+(${NAME})${B}+(\\S(?:[ -~\\t]*\\S)?)$`);
const R_ENUM_VALUE = new RegExp(`^${B}*(${NAME})(?:${B}*=${B}*([+\\-]?(?:0x[\\da-fA-F]+|0|[1-9]\\d*)))?${B}*$`);
const R_ID = new RegExp(`^${QUALIFIED}$`);

const CONTAINERS: Record<string, ContainerType> = {
    list: "list",
    int32: "map_int32",
    string: "map_string",
    generator: "generator"
};

function readLines(text: string): Line[]
{
    const src = text.split("\n");
    const out: Line[] = [];
    let doc: string[] = [];
    let blank_seen = false;

    for (let i = 0; i < src.length; i++)
    {
        let l = src[i]!.replace(/\r$/, "");
        const number = i + 1;
        if (l.includes("\0")) throw new ServiceDefinitionParseError("Service definition must not contain null characters", number);

        const d = /^[ \t]*##([ -~\t]*)$/.exec(l);
        if (d)
        {
            if (blank_seen)
            {
                doc = [];
                blank_seen = false;
            }
            doc.push(d[1]!);
            continue;
        }
        if (/^[ \t]*#[ -~\t]*$/.test(l))
        {
            doc = [];
            continue;
        }
        if (/^[ \t]*$/.test(l))
        {
            blank_seen = true;
            continue;
        }

        while (l.endsWith("\\"))
        {
            i++;
            if (i >= src.length) throw new ServiceDefinitionParseError("Line continuation must not be on last line", number);
            l = l.slice(0, -1) + " " + src[i]!.replace(/\r$/, "");
        }
        if (!/^[ -~\t]*$/.test(l)) throw new ServiceDefinitionParseError("Service definition must contain only ASCII characters", number);

        const line: Line = { text: l, number };
        if (doc.length > 0) line.doc = doc.join("\n");
        out.push(line);
        doc = [];
        blank_seen = false;
    }
    return out;
}

/** Parse a type such as "double[3,3]" or "com.example.mytype{list}" */
export function parseTypeDefinition(s: string, line_number = 0): TypeDefinition
{
    const m = R_TYPE.exec(s);
    if (!m) throw new ServiceDefinitionParseError(`Could not parse type "${s.trim()}"`, line_number);

    const t: TypeDefinition = { type: m[1]! };
    const dims = (v: string) => v.split(",").map((x) => parseInt(x, 10));
    if (m[2]) Object.assign(t, { array: "array", arrayLength: [0], arrayVarLength: true });
    else if (m[3]) Object.assign(t, { array: "array", arrayLength: dims(m[3]), arrayVarLength: false });
    else if (m[4]) Object.assign(t, { array: "array", arrayLength: dims(m[4]), arrayVarLength: true });
    else if (m[5]) Object.assign(t, { array: "multidimarray", arrayLength: [], arrayVarLength: true });
    else if (m[6]) Object.assign(t, { array: "multidimarray", arrayLength: dims(m[6]), arrayVarLength: false });
    else if (m[7]) Object.assign(t, { array: "multidimarray", arrayLength: dims(m[7]), arrayVarLength: false });

    if (m[8])
    {
        t.container = CONTAINERS[m[8]];
        if (!t.container) throw new ServiceDefinitionParseError(`Could not parse type "${s.trim()}": invalid container type`, line_number);
    }
    return t;
}

function withDoc<T extends { docString?: string }>(o: T, doc?: string): T
{
    if (doc !== undefined) o.docString = doc;
    return o;
}

function parseIdentifier(rest: string, keyword: string, line: Line): string
{
    if (!R_ID.test(rest)) throw new ServiceDefinitionParseError(`Invalid ${keyword} statement`, line.number);
    return rest;
}

function parseConstant(rest: string, line: Line): ConstantDefinition
{
    const m = R_CONSTANT.exec(rest);
    if (!m) throw new ServiceDefinitionParseError("Invalid constant definition", line.number);
    return withDoc<ConstantDefinition>({ name: m[2]!, type: parseTypeDefinition(m[1]!, line.number), value: m[3]! }, line.doc);
}

function parseParameters(s: string, line: Line): ParameterDefinition[]
{
    const out: ParameterDefinition[] = [];
    let rest: string | undefined = s;
    if (/^[ \t]*$/.test(s)) return out;
    while (rest !== undefined)
    {
        const m: RegExpExecArray | null = R_PARAM.exec(rest);
        if (!m) throw new ServiceDefinitionParseError("Invalid member parameters", line.number);
        out.push({ name: m[2]!, type: parseTypeDefinition(m[1]!, line.number) });
        rest = m[3];
    }
    return out;
}

function parseModifiers(s: string): string[]
{
    return (s.match(/[^,(]+(?:\([^)]*\))?/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 0);
}

const HAS_RETURN = ["function", "callback"];
const HAS_PARAMS = ["function", "event", "callback"];

function parseMember(kind: MemberKind, line: Line): MemberDefinition
{
    const m = R_MEMBER.exec(line.text);
    if (!m) throw new ServiceDefinitionParseError(`Invalid ${kind} definition`, line.number);

    const data_type = m[2];
    const has_params = m[4] !== undefined;
    const needs_params = HAS_PARAMS.includes(kind);
    if (has_params !== needs_params || (kind === "event") !== (data_type === undefined))
    {
        throw new ServiceDefinitionParseError(`Invalid ${kind} definition`, line.number);
    }

    const member: MemberDefinition = { kind, name: m[3]! };
    if (data_type !== undefined) member.type = parseTypeDefinition(data_type, line.number);
    if (needs_params) member.parameters = parseParameters(m[5]!, line);
    if (m[6] !== undefined) member.modifiers = parseModifiers(m[6]);
    return withDoc(member, line.doc);
}

function versionAtLeast(version: string | undefined, major: number, minor: number): boolean
{
    if (!version) return false;
    const v = version.split(".").map((x) => parseInt(x, 10));
    return v[0]! > major || (v[0] === major && (v[1] ?? 0) >= minor);
}

function qualifyWithUsing(name: string, def: ServiceDefinition): string
{
    if (name.includes(".")) return name;
    return def.using.find((u) => u.unqualifiedName === name)?.qualifiedName ?? name;
}

function parseEnum(name: string, start: Line, lines: Line[], pos: { i: number }, def: ServiceDefinition): void
{
    const e = withDoc<EnumDefinition>({ name, values: [] }, start.doc);
    let next = 0;
    for (;;)
    {
        const line = lines[pos.i++];
        if (!line) throw new ServiceDefinitionParseError("Block not terminated", start.number);
        const end = R_END.exec(line.text);
        if (end)
        {
            if (end[1] !== undefined && end[1] !== "enum") throw new ServiceDefinitionParseError("Block terminator does not match start", line.number);
            break;
        }
        const parts = line.text.split(",");
        if (parts.length > 1 && /^[ \t]*$/.test(parts[parts.length - 1]!)) parts.pop();
        parts.forEach((part, idx) =>
        {
            const m = R_ENUM_VALUE.exec(part);
            if (!m) throw new ServiceDefinitionParseError("Invalid enum value", line.number);
            if (m[2] !== undefined)
            {
                next = parseInt(m[2], /0x/i.test(m[2]) ? 16 : 10);
            }
            else if (e.values.length === 0)
            {
                throw new ServiceDefinitionParseError("First enum value must be assigned", line.number);
            }
            e.values.push(withDoc<EnumValue>({ name: m[1]!, value: next++ }, idx === 0 ? line.doc : undefined));
        });
    }
    def.enums.push(e);
}

function parseBlock(keyword: string, start: Line, lines: Line[], pos: { i: number }, def: ServiceDefinition): void
{
    const m = R_BLOCK_START.exec(start.text);
    if (!m) throw new ServiceDefinitionParseError(`Invalid ${keyword} definition`, start.number);

    if (keyword === "enum")
    {
        parseEnum(m[1]!, start, lines, pos, def);
        return;
    }

    const is_object = keyword === "object";
    const entry = withDoc<EntryDefinition>({ name: m[1]!, implements: [], options: [], constants: [], members: [] }, start.doc);

    for (;;)
    {
        const line = lines[pos.i++];
        if (!line) throw new ServiceDefinitionParseError("Block not terminated", start.number);

        const end = R_END.exec(line.text);
        if (end)
        {
            if (end[1] !== undefined && (end[1] !== keyword || versionAtLeast(def.stdVer, 0, 9)))
            {
                throw new ServiceDefinitionParseError("Block terminator does not match start", line.number);
            }
            break;
        }

        const l = R_MEMBER_LINE.exec(line.text);
        if (!l) throw new ServiceDefinitionParseError("Parse error", line.number);
        const kind = l[1]!;
        const rest = l[2]!;

        if (kind === "option")
        {
            entry.options.push(rest);
        }
        else if (kind === "implements")
        {
            if (!is_object || entry.members.length > 0) throw new ServiceDefinitionParseError("Invalid implements statement", line.number);
            entry.implements.push(qualifyWithUsing(parseIdentifier(rest, "implements", line), def));
        }
        else if (kind === "constant")
        {
            if (entry.members.length > 0) throw new ServiceDefinitionParseError("Constants must come before members", line.number);
            entry.constants.push(parseConstant(rest, line));
        }
        else if (kind === "field")
        {
            if (is_object) throw new ServiceDefinitionParseError("Objects cannot contain fields, use properties instead", line.number);
            entry.members.push(parseMember("field", line));
        }
        else
        {
            if (!is_object) throw new ServiceDefinitionParseError("Structures must only contain fields, constants, and options", line.number);
            entry.members.push(parseMember(kind as MemberKind, line));
        }
    }

    if (keyword === "struct") def.structures.push(entry);
    else if (keyword === "pod") def.pods.push(entry);
    else if (keyword === "namedarray") def.namedArrays.push(entry);
    else def.objects.push(entry);
}

/** Parse the text of a service definition */
export function parseServiceDefinition(text: string): ServiceDefinition
{
    const def: ServiceDefinition = {
        name: "",
        imports: [],
        using: [],
        options: [],
        constants: [],
        enums: [],
        exceptions: [],
        structures: [],
        pods: [],
        namedArrays: [],
        objects: []
    };

    const lines = readLines(text);
    const pos = { i: 0 };
    let version_from_option = false;

    while (pos.i < lines.length)
    {
        const line = lines[pos.i++]!;
        const m = R_ENTRY.exec(line.text);
        if (!m) throw new ServiceDefinitionParseError("Parse error", line.number);
        const keyword = m[1]!;
        const rest = m[2]!;

        if (keyword === "service")
        {
            if (def.name !== "") throw new ServiceDefinitionParseError("service name already specified", line.number);
            def.name = parseIdentifier(rest, "service", line);
            if (line.doc !== undefined) def.docString = line.doc;
            continue;
        }
        if (def.name === "") throw new ServiceDefinitionParseError("service name must be first entry in service definition", line.number);

        switch (keyword)
        {
        case "stdver":
            if (def.stdVer !== undefined) throw new ServiceDefinitionParseError("stdver already specified", line.number);
            if (!/^\d+(?:\.\d+){1,3}$/.test(rest)) throw new ServiceDefinitionParseError("Invalid stdver", line.number);
            def.stdVer = rest;
            break;
        case "option":
            {
                def.options.push(rest);
                const v = /^version[ \t]+(\d+(?:\.\d+)*)$/.exec(rest);
                if (v)
                {
                    if (def.stdVer !== undefined || version_from_option) throw new ServiceDefinitionParseError("Robot Raconteur version already specified", line.number);
                    def.stdVer = v[1]!;
                    version_from_option = true;
                }
            }
            break;
        case "import":
            def.imports.push(parseIdentifier(rest, "import", line));
            break;
        case "using":
            {
                const u = R_USING.exec(rest);
                if (!u) throw new ServiceDefinitionParseError("Format error for using definition", line.number);
                def.using.push({ qualifiedName: u[1]!, unqualifiedName: u[2] ?? u[1]!.substring(u[1]!.lastIndexOf(".") + 1) });
            }
            break;
        case "exception":
            def.exceptions.push(withDoc<ExceptionDefinition>({ name: parseIdentifier(rest, "exception", line) }, line.doc));
            break;
        case "constant":
            def.constants.push(parseConstant(rest, line));
            break;
        default:
            parseBlock(keyword, line, lines, pos, def);
        }
    }

    if (def.name === "") throw new ServiceDefinitionParseError("Service name not found", 0);
    return def;
}
