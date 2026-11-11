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

import type { ServiceStub } from "./Client.js";
import { MessageErrorType, primitivesByName } from "./DataTypes.js";
import type { NumericArray, PrimitiveInfo } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import { NamedArrayView } from "./Pack.js";
import type { TypeContext } from "./Pack.js";
import type { ConstantDefinition, ServiceDefinition, TypeDefinition } from "./ServiceDefinition.js";

// Helpers that work from the service definitions of a connected client, matching NewStructure and
// GetConstants in Core. They are separate functions so that they are left out of a bundle if unused.

const isBig = (p: PrimitiveInfo) => p.name === "int64" || p.name === "uint64";

function defaultValue(t: TypeDefinition, scope: ServiceDefinition, types: TypeContext): unknown
{
    if (t.container || t.type === "varvalue") return null;
    if (t.type === "string") return "";

    const count = !t.arrayLength || t.arrayVarLength ? 0 : t.arrayLength.reduce((a, b) => a * b, 1);
    const dims = () => Uint32Array.from(t.arrayLength ?? [0, 0]);
    const p = primitivesByName.get(t.type);
    if (p)
    {
        if (t.array === "multidimarray") return { dims: dims(), array: new p.ctor(count * p.stride) };
        if (t.array) return new p.ctor(count * p.stride);
        if (p.stride === 2) return { real: 0, imag: 0 };
        if (isBig(p)) return 0n;
        return p.name === "bool" ? false : 0;
    }

    const r = types.resolve(t.type, scope);
    if (r.kind === "enum") return 0;
    if (r.kind !== "pod" && r.kind !== "namedarray") return null;
    const item = () => Object.fromEntries(r.entry!.members.map((m) => [m.name, defaultValue(m.type!, r.def, types)]));
    if (t.array === "multidimarray") return { dims: dims(), array: Array.from({ length: count }, item) };
    if (t.array) return Array.from({ length: count }, item);
    return item();
}

/**
 * Create a structure, pod, or named array with every field set to its default: zero, an empty string,
 * or an empty or zero filled array. Fields that hold structures, containers, or a varvalue are null.
 *
 * @param client A connected client, which holds the service definitions
 * @param type The name of the type. It must be fully qualified if it is from another service definition
 */
export function newStructure(client: ServiceStub, type: string): Record<string, unknown>
{
    const types = client.context.types;
    const r = types.resolve(type, client.context.serviceDefForType(client.objectType));
    if (r.kind !== "struct" && r.kind !== "pod" && r.kind !== "namedarray")
    {
        throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", `${type} is not a structure, pod, or named array`);
    }
    return Object.fromEntries(r.entry!.members.map((m) => [m.name, defaultValue(m.type!, r.def, types)]));
}

/**
 * Create a {@link NamedArrayView} of a named array type known to a client, for sending arrays of named
 * arrays without building an object per element.
 * @param client Any object of the connection that knows the type
 * @param type Named array type, such as `com.robotraconteur.geometry.Vector3`
 * @param countOrArray Number of zeroed elements, or a typed array of the type's number type to use as is
 */
export function newNamedArrayView(client: ServiceStub, type: string, countOrArray: number | NumericArray): NamedArrayView
{
    const types = client.context.types;
    const r = types.resolve(type, client.context.serviceDefForType(client.objectType));
    if (r.kind !== "namedarray")
    {
        throw new RobotRaconteurError(MessageErrorType.InvalidArgument, "RobotRaconteur.InvalidArgument", `${type} is not a named array`);
    }
    const l = types.namedArrayLayout(r);
    return new NamedArrayView(l, typeof countOrArray === "number" ? new l.prim.ctor(countOrArray * l.length) : countOrArray);
}

function parseNumber(s: string, p: PrimitiveInfo): number | bigint
{
    const text = s.trim();
    const negative = text.startsWith("-");
    const digits = negative || text.startsWith("+") ? text.substring(1) : text;
    if (isBig(p)) return negative ? -BigInt(digits) : BigInt(digits);
    return negative ? -Number(digits) : Number(digits);
}

function constantValue(c: ConstantDefinition): unknown
{
    if (c.type.type === "string") return JSON.parse(c.value) as string;
    const inner = () => c.value.trim().slice(1, -1).split(",").map((x) => x.trim()).filter((x) => x !== "");
    const p = primitivesByName.get(c.type.type);
    if (p) return c.type.array ? inner().map((x) => parseNumber(x, p)) : parseNumber(c.value, p);
    return Object.fromEntries(inner().map((x) => x.split(":").map((y) => y.trim())));
}

/**
 * Get the constants and enums of a service definition. Each enum is an object of its values by name.
 * The constants of a structure or object are in an object using its name.
 *
 * @param client A connected client, which holds the service definitions
 * @param serviceType The name of the service definition, for example com.robotraconteur.robotics.robot
 */
export function getConstants(client: ServiceStub, serviceType: string): Record<string, any>
{
    const def = client.context.types.defs.get(serviceType);
    if (!def) throw new RobotRaconteurError(MessageErrorType.ServiceNotFound, "RobotRaconteur.ServiceNotFound", `Could not find service definition ${serviceType}`);

    const out: Record<string, any> = Object.fromEntries(def.constants.map((c) => [c.name, constantValue(c)]));
    // A structure constant refers to other constants by name
    for (const c of def.constants)
    {
        if (primitivesByName.has(c.type.type) || c.type.type === "string") continue;
        const fields = out[c.name] as Record<string, string>;
        for (const k of Object.keys(fields)) fields[k] = out[fields[k]!];
    }
    for (const e of [...def.namedArrays, ...def.pods, ...def.structures, ...def.objects])
    {
        if (e.constants.length > 0) out[e.name] = Object.fromEntries(e.constants.map((c) => [c.name, constantValue(c)]));
    }
    for (const e of def.enums) out[e.name] = Object.fromEntries(e.values.map((v) => [v.name, v.value]));
    return out;
}
