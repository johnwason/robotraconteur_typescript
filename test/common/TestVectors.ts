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

// Reader for the test vector blob test/data/test_vectors.bin, a copy of the blob in Robot Raconteur Core.
// The format is described in Core's test/data/TEST_VECTORS_FORMAT.md.
//
// Node.js reads the file directly. The browser test page sets globalThis.rr_test_vectors_base64 before the
// tests load, because a file:// page cannot read other files.

const HEADER_SIZE = 24;
const ENTRY_SIZE = 64;
const NAME_SIZE = 48;
const SAFE = 2n ** 53n;

// name: [Robot Raconteur DataTypes code, element size]
const TYPES: Record<string, [number, number]> = {
    double: [1, 8],
    single: [2, 4],
    int8: [3, 1],
    uint8: [4, 1],
    int16: [5, 2],
    uint16: [6, 2],
    int32: [7, 4],
    uint32: [8, 4],
    int64: [9, 8],
    uint64: [10, 8]
};

let blob: DataView | undefined;

function loadBytes(): Uint8Array
{
    const g = globalThis as unknown as {
        rr_test_vectors_base64?: string;
        process?: { getBuiltinModule?: (id: string) => { readFileSync(path: URL): Uint8Array } };
    };
    if (g.rr_test_vectors_base64 !== undefined)
    {
        const text = atob(g.rr_test_vectors_base64);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes;
    }
    const fs = g.process?.getBuiltinModule?.("node:fs");
    if (!fs) throw new Error("Test vectors are not available: set rr_test_vectors_base64 or run under Node.js");
    // Compiled to dist-test/test/common, so the repository root is three levels up
    return fs.readFileSync(new URL("../../../test/data/test_vectors.bin", import.meta.url));
}

function load(): DataView
{
    if (blob) return blob;
    const bytes = loadBytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (bytes.length < HEADER_SIZE || magic !== "RRTVECTS") throw new Error("Invalid test vector blob");
    if (view.getUint32(8, true) !== 1 || view.getUint32(12, true) !== ENTRY_SIZE || view.getUint32(20, true) !== bytes.length)
    {
        throw new Error("Invalid or unsupported test vector blob");
    }
    if (HEADER_SIZE + view.getUint32(16, true) * ENTRY_SIZE > bytes.length) throw new Error("Truncated test vector index");
    blob = view;
    return view;
}

function entryName(view: DataView, entry: number): string
{
    let name = "";
    for (let i = 0; i < NAME_SIZE; i++)
    {
        const c = view.getUint8(entry + i);
        if (c === 0) break;
        name += String.fromCharCode(c);
    }
    return name;
}

function read(view: DataView, type: string, offset: number): number | bigint
{
    switch (type)
    {
        case "double": return view.getFloat64(offset, true);
        case "single": return view.getFloat32(offset, true);
        case "int8": return view.getInt8(offset);
        case "uint8": return view.getUint8(offset);
        case "int16": return view.getInt16(offset, true);
        case "uint16": return view.getUint16(offset, true);
        case "int32": return view.getInt32(offset, true);
        case "uint32": return view.getUint32(offset, true);
        default:
        {
            // Matches the test literals: a number when it is exact, otherwise a bigint
            const v = type === "int64" ? view.getBigInt64(offset, true) : view.getBigUint64(offset, true);
            return v < SAFE && v > -SAFE ? Number(v) : v;
        }
    }
}

/** Return a copy of the named vector. type must match the type stored in the blob, for example "double". */
export function getTestVector(name: string, type: string): any[]
{
    const info = TYPES[type];
    if (!info) throw new Error(`Unknown test vector type: ${type}`);
    const [code, size] = info;
    const view = load();
    const count = view.getUint32(16, true);
    for (let i = 0; i < count; i++)
    {
        const entry = HEADER_SIZE + i * ENTRY_SIZE;
        if (entryName(view, entry) !== name) continue;
        if (view.getUint32(entry + 48, true) !== code) throw new Error(`Test vector type mismatch: ${name}`);
        const n = view.getUint32(entry + 52, true);
        const offset = view.getUint32(entry + 56, true);
        if (offset + n * size > view.byteLength) throw new Error(`Test vector out of bounds: ${name}`);
        const values: any[] = new Array(n);
        for (let j = 0; j < n; j++) values[j] = read(view, type, offset + j * size);
        return values;
    }
    throw new Error(`Test vector not found: ${name}`);
}
