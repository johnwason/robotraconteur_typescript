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

/** 128-bit Robot Raconteur node identifier */
export class NodeID
{
    /** The 16 bytes of the ID */
    readonly bytes: Uint8Array;

    /** @param id The 16 bytes, or a string as `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, with or without the braces and dashes */
    constructor(id: Uint8Array | string)
    {
        if (typeof id === "string")
        {
            const m = /^\{?([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})\}?$/.exec(id);
            if (!m) throw new TypeError("Invalid NodeID: " + id);
            const hex = m.slice(1).join("");
            this.bytes = new Uint8Array(16);
            for (let i = 0; i < 16; i++) this.bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            return;
        }
        if (id.length !== 16) throw new TypeError("NodeID must be 16 bytes");
        this.bytes = id;
    }

    /** The all zero ID, which means any node in URLs and requests */
    static readonly Any = new NodeID(new Uint8Array(16));

    /** A new random ID, as a version 4 UUID */
    static newUniqueID(): NodeID
    {
        const b = new Uint8Array(16);
        globalThis.crypto.getRandomValues(b);
        b[6] = (b[6]! & 0x0f) | 0x40;
        b[8] = (b[8]! & 0x3f) | 0x80;
        return new NodeID(b);
    }

    /** True for NodeID.Any */
    get isAnyNode(): boolean
    {
        return this.bytes.every((x) => x === 0);
    }

    /** True if the IDs are the same */
    equals(other: NodeID): boolean
    {
        return this.bytes.every((x, i) => x === other.bytes[i]);
    }

    /** The ID as `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, as Core writes it */
    toString(): string
    {
        const h = Array.from(this.bytes, (x) => x.toString(16).padStart(2, "0")).join("");
        return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
    }
}
