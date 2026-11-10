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

import { RobotRaconteurError } from "../../src/index.js";
import { assert } from "./check.js";

// Helpers giving the Python test idioms used by the Core test clients. `ca` uses the default
// tolerance of numpy.testing.assert_allclose, as the Core tests do.

export function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorNamed(name: string): (e: RobotRaconteurError) => boolean
{
    return (e) =>
    {
        assert.equal(e.errorName, name);
        return true;
    };
}

export function len(x: any): number
{
    return x instanceof Map ? x.size : x.length;
}

export function at(x: any, k: any): any
{
    return x instanceof Map ? x.get(k) : x[k];
}

/** Build a multidimensional array from column-major data */
export function md(array: any, dims: number[]): { dims: Uint32Array; array: any }
{
    return { dims: Uint32Array.from(dims), array };
}

function isMd(x: any): boolean
{
    return typeof x === "object" && x !== null && "dims" in x && "array" in x;
}

function isSeq(x: any): boolean
{
    return Array.isArray(x) || ArrayBuffer.isView(x);
}

function close(a: any, b: any, where: string, exact = false): void
{
    if (typeof a === "number" && typeof b === "number" && !exact)
    {
        if (a !== b && Math.abs(a - b) > 1e-7 * Math.abs(b)) throw new Error(`${where}: ${a} != ${b}`);
        return;
    }
    // Loose comparison covers bigint and number, and booleans stored as 0 and 1
    if (a != b) throw new Error(`${where}: ${String(a)} != ${String(b)}`);
}

function compareArrays(actual: any, expected: any, where: string, exact: boolean): void
{
    if (isMd(actual) || isMd(expected))
    {
        assert.ok(isMd(actual) && isMd(expected), `${where}: multidimensional array mismatch`);
        assert.deepEqual(Array.from(actual.dims as Uint32Array), Array.from(expected.dims as Uint32Array), `${where} dims`);
        compareArrays(actual.array, expected.array, where, exact);
        return;
    }
    if (isSeq(actual) || isSeq(expected))
    {
        assert.ok(isSeq(actual) && isSeq(expected), `${where}: array mismatch`);
        assert.equal(actual.length, expected.length, `${where} length`);
        for (let i = 0; i < actual.length; i++) compareArrays(actual[i], expected[i], `${where}[${i}]`, exact);
        return;
    }
    if (typeof actual === "object" && actual !== null && "real" in actual)
    {
        close(actual.real, expected.real, where + ".real", exact);
        close(actual.imag, expected.imag, where + ".imag", exact);
        return;
    }
    close(actual, expected, where, exact);
}

export function ca(actual: any, expected: any, where = "value"): void
{
    compareArrays(actual, expected, where, false);
}

/** Exact comparison, like numpy.testing.assert_array_equal, which the Core tests use for integer arrays */
export function cae(actual: any, expected: any, where = "value"): void
{
    compareArrays(actual, expected, where, true);
}

/** Python equality: exact, but bigints and booleans compare with numbers */
export function eq(actual: any, expected: any): void
{
    if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null)
    {
        assert.deepEqual(actual, expected);
        return;
    }
    if (actual != expected) throw new Error(`${String(actual)} != ${String(expected)}`);
}
