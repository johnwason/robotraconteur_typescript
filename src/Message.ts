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

import { DataTypes, MessageEntryType, MessageErrorType, NumericArray, primitivesByType } from "./DataTypes.js";
import { NodeID } from "./NodeID.js";

// Message Format Version 2 serialization. All values are little-endian. Typed array contents are
// copied directly, so this assumes a little-endian host, which covers all browser platforms.

const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder();

export type MessageElementData = NumericArray | string | MessageElementNestedElementList | null;

export class MessageElementNestedElementList
{
    constructor(public type: DataTypes, public typeName: string, public elements: MessageElement[]) {}
}

export class MessageElement
{
    elementTypeName = "";
    metaData = "";

    constructor(public elementName: string, public elementType: DataTypes, public data: MessageElementData) {}

    /** Create an element containing a nested element list */
    static nested(name: string, type: DataTypes, typeName: string, elements: MessageElement[]): MessageElement
    {
        const e = new MessageElement(name, type, new MessageElementNestedElementList(type, typeName, elements));
        e.elementTypeName = typeName;
        return e;
    }

    static string(name: string, value: string): MessageElement
    {
        return new MessageElement(name, DataTypes.string_t, value);
    }

    castNested(expected?: DataTypes): MessageElementNestedElementList
    {
        const d = this.data;
        if (!(d instanceof MessageElementNestedElementList) || (expected !== undefined && d.type !== expected))
        {
            throw new TypeError("Unexpected data type for message element " + this.elementName);
        }
        return d;
    }

    castString(): string
    {
        if (typeof this.data !== "string") throw new TypeError("Message element is not a string: " + this.elementName);
        return this.data;
    }
}

export function findElement(elements: MessageElement[], name: string): MessageElement | undefined
{
    return elements.find((x) => x.elementName === name);
}

export function getElement(elements: MessageElement[], name: string): MessageElement
{
    const e = findElement(elements, name);
    if (!e) throw new TypeError("Message element not found: " + name);
    return e;
}

export class MessageEntry
{
    servicePath = "";
    requestID = 0;
    error: MessageErrorType = MessageErrorType.None;
    metaData = "";
    elements: MessageElement[] = [];

    constructor(public entryType: MessageEntryType, public memberName = "") {}

    addElement(e: MessageElement): void
    {
        this.elements.push(e);
    }
}

export class MessageHeader
{
    senderNodeID = NodeID.Any;
    receiverNodeID = NodeID.Any;
    senderEndpoint = 0;
    receiverEndpoint = 0;
    senderNodeName = "";
    receiverNodeName = "";
    metaData = "";
    messageID = 0;
    messageResID = 0;
}

export class Message
{
    header = new MessageHeader();
    entries: MessageEntry[] = [];
}

class ArrayBinaryWriter
{
    buf = new Uint8Array(1024);
    view = new DataView(this.buf.buffer);
    pos = 0;

    ensure(n: number): void
    {
        if (this.pos + n <= this.buf.length) return;
        const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
        b.set(this.buf.subarray(0, this.pos));
        this.buf = b;
        this.view = new DataView(b.buffer);
    }

    u16(v: number): void
    {
        if (v > 0xffff) throw new RangeError("Value exceeds maximum message field length");
        this.ensure(2);
        this.view.setUint16(this.pos, v, true);
        this.pos += 2;
    }

    u32(v: number): void
    {
        this.ensure(4);
        this.view.setUint32(this.pos, v, true);
        this.pos += 4;
    }

    bytes(b: Uint8Array): void
    {
        this.ensure(b.length);
        this.buf.set(b, this.pos);
        this.pos += b.length;
    }

    /** Write a string with a uint16 byte count prefix */
    string16(s: string): void
    {
        const b = text_encoder.encode(s);
        this.u16(b.length);
        this.bytes(b);
    }

    patchU16(at: number, v: number): void
    {
        this.view.setUint16(at, v, true);
    }

    patchU32(at: number, v: number): void
    {
        this.view.setUint32(at, v, true);
    }
}

function writeElement(w: ArrayBinaryWriter, e: MessageElement): void
{
    const start = w.pos;
    const d = e.data;
    w.u32(0);
    w.string16(e.elementName);
    w.u16(e.elementType);
    w.string16(d instanceof MessageElementNestedElementList ? d.typeName : e.elementTypeName);
    w.string16(e.metaData);

    const count_pos = w.pos;
    w.u32(0);
    let count = 0;
    if (typeof d === "string")
    {
        const b = text_encoder.encode(d);
        count = b.length;
        w.bytes(b);
    }
    else if (d instanceof MessageElementNestedElementList)
    {
        count = d.elements.length;
        for (const n of d.elements) writeElement(w, n);
    }
    else if (d !== null)
    {
        const info = primitivesByType.get(e.elementType);
        if (!info) throw new TypeError("Invalid numeric message element type");
        count = d.byteLength / info.size;
        w.bytes(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    }
    w.patchU32(count_pos, count);
    w.patchU32(start, w.pos - start);
}

function writeEntry(w: ArrayBinaryWriter, e: MessageEntry): void
{
    const start = w.pos;
    w.u32(0);
    w.u16(e.entryType);
    w.u16(0);
    w.string16(e.servicePath);
    w.string16(e.memberName);
    w.u32(e.requestID);
    w.u16(e.error);
    w.string16(e.metaData);
    w.u16(e.elements.length);
    for (const n of e.elements) writeElement(w, n);
    w.patchU32(start, w.pos - start);
}

/** Serialize a message to Message Format Version 2 */
export function serializeMessage(m: Message): Uint8Array
{
    const w = new ArrayBinaryWriter();
    const h = m.header;
    w.bytes(text_encoder.encode("RRAC"));
    w.u32(0);
    w.u16(2);
    w.u16(0);
    w.bytes(h.senderNodeID.bytes);
    w.bytes(h.receiverNodeID.bytes);
    w.u32(h.senderEndpoint);
    w.u32(h.receiverEndpoint);
    w.string16(h.senderNodeName);
    w.string16(h.receiverNodeName);
    w.string16(h.metaData);
    w.u16(m.entries.length);
    w.u16(h.messageID);
    w.u16(h.messageResID);
    w.patchU16(10, w.pos);
    for (const e of m.entries) writeEntry(w, e);
    w.patchU32(4, w.pos);
    return w.buf.subarray(0, w.pos);
}

class ArrayBinaryReader
{
    view: DataView;
    pos = 0;

    constructor(public data: Uint8Array)
    {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    u16(): number
    {
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u32(): number
    {
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    take(n: number, end: number): Uint8Array
    {
        if (this.pos + n > end) throw new RangeError("Message field exceeds its bounds");
        const b = this.data.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }

    string16(end: number): string
    {
        return text_decoder.decode(this.take(this.u16(), end));
    }

    /** Read the size prefix of a section starting at the current position and return its end */
    sectionEnd(limit: number): number
    {
        const start = this.pos;
        const end = start + this.u32();
        if (end > limit || end < this.pos) throw new RangeError("Message section exceeds its bounds");
        return end;
    }
}

function readElement(r: ArrayBinaryReader, limit: number): MessageElement
{
    const end = r.sectionEnd(limit);
    const name = r.string16(end);
    const type = r.u16() as DataTypes;
    const type_name = r.string16(end);
    const meta = r.string16(end);
    const count = r.u32();

    let data: MessageElementData = null;
    if (type === DataTypes.string_t)
    {
        data = text_decoder.decode(r.take(count, end));
    }
    else if (type >= DataTypes.structure_t)
    {
        const elements: MessageElement[] = [];
        for (let i = 0; i < count; i++) elements.push(readElement(r, end));
        data = new MessageElementNestedElementList(type, type_name, elements);
    }
    else if (type !== DataTypes.void_t)
    {
        const info = primitivesByType.get(type);
        if (!info) throw new TypeError("Unknown message element data type: " + type);
        const b = r.take(count * info.size, end);
        // Copy so that the typed array is correctly aligned and does not hold the receive buffer
        data = new info.ctor(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    }
    if (r.pos !== end) throw new RangeError("Error reading message element");

    const e = new MessageElement(name, type, data);
    e.elementTypeName = type_name;
    e.metaData = meta;
    return e;
}

function readEntry(r: ArrayBinaryReader, limit: number): MessageEntry
{
    const end = r.sectionEnd(limit);
    const e = new MessageEntry(r.u16() as MessageEntryType);
    r.u16();
    e.servicePath = r.string16(end);
    e.memberName = r.string16(end);
    e.requestID = r.u32();
    e.error = r.u16() as MessageErrorType;
    e.metaData = r.string16(end);
    const count = r.u16();
    for (let i = 0; i < count; i++) e.elements.push(readElement(r, end));
    if (r.pos !== end) throw new RangeError("Error reading message entry");
    return e;
}

/** Deserialize a complete Message Format Version 2 message */
export function deserializeMessage(data: Uint8Array): Message
{
    const r = new ArrayBinaryReader(data);
    if (text_decoder.decode(r.take(4, data.length)) !== "RRAC") throw new RangeError("Invalid message magic");
    const size = r.u32();
    if (size !== data.length) throw new RangeError("Invalid message length");
    if (r.u16() !== 2) throw new RangeError("Unsupported message version");
    const header_end = r.u16();
    if (header_end > size) throw new RangeError("Invalid message header length");

    const m = new Message();
    const h = m.header;
    h.senderNodeID = new NodeID(r.take(16, header_end).slice());
    h.receiverNodeID = new NodeID(r.take(16, header_end).slice());
    h.senderEndpoint = r.u32();
    h.receiverEndpoint = r.u32();
    h.senderNodeName = r.string16(header_end);
    h.receiverNodeName = r.string16(header_end);
    h.metaData = r.string16(header_end);
    const count = r.u16();
    h.messageID = r.u16();
    h.messageResID = r.u16();
    if (r.pos !== header_end) throw new RangeError("Error reading message header");

    for (let i = 0; i < count; i++) m.entries.push(readEntry(r, size));
    if (r.pos !== size) throw new RangeError("Error reading message");
    return m;
}
