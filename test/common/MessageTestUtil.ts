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

import { DataTypes } from "../../src/DataTypes.js";
import { Message, MessageElement, MessageEntry } from "../../src/Message.js";
import { NodeID } from "../../src/NodeID.js";

// Port of the Message Format Version 2 generators from RobotRaconteurWeb MessageTestUtil.cs and
// LFSRSeqGen.cs. The same sequences are used by the Core tests.

const CHARS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

function lfsrNext(l: number): number
{
    const bit = (l ^ (l >>> 1) ^ (l >>> 21) ^ (l >>> 31)) & 1;
    return ((l >>> 1) | (bit << 31)) >>> 0;
}

export class LFSRSeqGen
{
    lfsr: number;

    constructor(seed: number, key?: string)
    {
        this.lfsr = key === undefined ? seed >>> 0 : LFSRSeqGen.initKey(seed >>> 0, key);
    }

    private static initKey(seed: number, key: string): number
    {
        for (let i = 0; i < 128; i++) seed = lfsrNext(seed);
        let h = lfsrNext(seed);
        for (let i = 0; i < key.length; i++)
        {
            h = (h + key.charCodeAt(i)) >>> 0;
            h = (h + (h << 10)) >>> 0;
            h = (h ^ (h >>> 6)) >>> 0;
        }
        h = (h + (h << 3)) >>> 0;
        h = (h ^ (h >>> 11)) >>> 0;
        h = (h + (h << 15)) >>> 0;
        for (let i = 0; i < 128; i++) h = lfsrNext(h);
        return lfsrNext(h);
    }

    next(): number
    {
        this.lfsr = lfsrNext(this.lfsr);
        return this.lfsr;
    }

    next2(): bigint
    {
        const a = BigInt(this.next());
        return (a << 32n) | BigInt(this.next());
    }

    nextUInt8(): number
    {
        return this.next() & 0xff;
    }

    nextUInt16(): number
    {
        return this.next() & 0xffff;
    }

    nextUInt32(): number
    {
        return this.next();
    }

    nextLen(max_len: number): number
    {
        const l = this.next();
        return max_len < 32 ? l % max_len : 8 + (l % (max_len - 8));
    }

    nextDist(min: number, max: number): number
    {
        return (this.next() % (max - min + 1)) + min;
    }

    nextStringVarLen(max_len: number): string
    {
        const len = this.nextLen(max_len);
        let s = "";
        for (let i = 0; i < len; i++) s += CHARS[this.next() % CHARS.length];
        return s;
    }

    nextArrayByTypeVarLen(type: DataTypes, max_len: number): MessageElement["data"]
    {
        if (type === DataTypes.string_t) return this.nextStringVarLen(max_len);
        const len = this.nextLen(max_len);
        const fill32 = (a: Uint32Array) =>
        {
            for (let i = 0; i < a.length; i++) a[i] = this.next();
            return a.buffer as ArrayBuffer;
        };
        const fill64 = () =>
        {
            const a = new BigUint64Array(len);
            for (let i = 0; i < len; i++) a[i] = this.next2();
            return a.buffer as ArrayBuffer;
        };
        switch (type)
        {
        case DataTypes.double_t:
            return new Float64Array(fill64());
        case DataTypes.single_t:
            return new Float32Array(fill32(new Uint32Array(len)));
        case DataTypes.int8_t:
            return Int8Array.from({ length: len }, () => this.next() & 0xff);
        case DataTypes.uint8_t:
            return Uint8Array.from({ length: len }, () => this.nextUInt8());
        case DataTypes.int16_t:
            return Int16Array.from({ length: len }, () => this.next() & 0xffff);
        case DataTypes.uint16_t:
            return Uint16Array.from({ length: len }, () => this.nextUInt16());
        case DataTypes.int32_t:
            return new Int32Array(fill32(new Uint32Array(len)));
        case DataTypes.uint32_t:
            return new Uint32Array(fill32(new Uint32Array(len)));
        case DataTypes.int64_t:
            return new BigInt64Array(fill64());
        case DataTypes.uint64_t:
            return new BigUint64Array(fill64());
        default:
            throw new Error("Unexpected data type");
        }
    }
}

function nestedElements(rng: LFSRSeqGen, count: number, depth: number): MessageElement[]
{
    const v: MessageElement[] = [];
    for (let i = 0; i < count; i++) v.push(newRandomMessageElement(rng, depth));
    return v;
}

function newRandomMessageElement(rng: LFSRSeqGen, depth: number): MessageElement
{
    let type: DataTypes;
    if (rng.nextDist(0, 1) === 0 || depth > 2)
    {
        type = rng.nextDist(0, 11) as DataTypes;
    }
    else
    {
        type = [DataTypes.structure_t, DataTypes.vector_t, DataTypes.dictionary_t, DataTypes.multidimarray_t, DataTypes.list_t][rng.nextDist(0, 4)]!;
    }

    const name = rng.nextStringVarLen(128);
    rng.nextStringVarLen(128); // The element type name, which Core clears for numeric and string elements
    const meta = rng.nextStringVarLen(128);

    let e: MessageElement;
    if (type === DataTypes.void_t)
    {
        e = new MessageElement(name, type, null);
    }
    else if (type <= DataTypes.string_t)
    {
        e = new MessageElement(name, type, rng.nextArrayByTypeVarLen(type, 256));
    }
    else if (type === DataTypes.multidimarray_t)
    {
        e = MessageElement.nested(name, type, "", nestedElements(rng, Math.min(rng.nextDist(1, 8), 4), 10));
    }
    else
    {
        const n = rng.nextDist(1, 8);
        const struct_name = type === DataTypes.structure_t ? rng.nextStringVarLen(128) : "";
        e = MessageElement.nested(name, type, struct_name, nestedElements(rng, n, depth + 1));
    }
    e.metaData = meta;
    return e;
}

export function newRandomTestMessage(rng: LFSRSeqGen): Message
{
    const m = new Message();
    const h = m.header;
    h.senderNodeID = new NodeID(Uint8Array.from({ length: 16 }, () => rng.nextUInt8()));
    h.receiverNodeID = new NodeID(Uint8Array.from({ length: 16 }, () => rng.nextUInt8()));
    h.senderNodeName = rng.nextStringVarLen(64);
    h.receiverNodeName = rng.nextStringVarLen(64);
    h.senderEndpoint = rng.nextUInt32();
    h.receiverEndpoint = rng.nextUInt32();
    h.metaData = rng.nextStringVarLen(256);
    h.messageID = rng.nextUInt16();
    h.messageResID = rng.nextUInt16();

    const count = rng.nextDist(1, 4);
    const add_large_entry = rng.nextDist(1, 4);
    for (let i = 0; i < count; i++)
    {
        const e = new MessageEntry(rng.nextDist(101, 120), "");
        e.servicePath = rng.nextStringVarLen(256);
        e.requestID = rng.nextUInt32();
        e.error = rng.nextDist(1, 10);
        e.metaData = rng.nextStringVarLen(256);

        if (add_large_entry === 1 && i === 0)
        {
            const a = new Uint32Array(rng.nextDist(512 * 1024, 1024 * 1024));
            for (let j = 0; j < a.length; j++) a[j] = rng.nextUInt32();
            const el = newRandomMessageElement(rng, 10);
            el.elementType = DataTypes.uint32_t;
            el.data = a;
            e.addElement(el);
        }
        else
        {
            e.elements.push(...nestedElements(rng, rng.nextDist(0, 16), 0));
        }
        m.entries.push(e);
    }
    return m;
}

function entry(type: number, member: string, path: string, request_id: number): MessageEntry
{
    const e = new MessageEntry(type, member);
    e.servicePath = path;
    e.requestID = request_id;
    return e;
}

function multiDim(name: string, dims: number[], real: Float64Array): MessageElement
{
    return MessageElement.nested(name, DataTypes.multidimarray_t, "", [new MessageElement("dims", DataTypes.uint32_t, Uint32Array.from(dims)), new MessageElement("array", DataTypes.double_t, real)]);
}

export function newTestMessage(): Message
{
    const e1 = entry(1111, "testprimitives", "aservicepath", 134576);
    e1.metaData = "md";
    const v12 = Uint32Array.from({ length: 1024 * 1024 }, (_, i) => i);
    e1.elements.push(
        new MessageElement("v1", DataTypes.double_t, Float64Array.of(1, 2, 3, 4, 5, 7.45, 8.9832)),
        new MessageElement("v2", DataTypes.single_t, Float32Array.of(1, 2, 34)),
        new MessageElement("v3", DataTypes.int8_t, Int8Array.of(1, -2, 3, 127)),
        new MessageElement("v4", DataTypes.uint8_t, Uint8Array.of(1, 2, 3, 4, 5)),
        new MessageElement("v5", DataTypes.int16_t, Int16Array.of(1, 2, 3, -4, 5, 19746, 9870)),
        new MessageElement("v6", DataTypes.uint16_t, Uint16Array.of(1, 2, 3, 4, 5, 19746, 9870)),
        new MessageElement("v7", DataTypes.int32_t, Int32Array.of(1, 2, 3, -4, 5, 19746, 9870, 2045323432)),
        new MessageElement("v8", DataTypes.uint32_t, Uint32Array.of(1, 2, 3, 4, 5, 19746, 9870, 345323432)),
        new MessageElement("v9", DataTypes.int64_t, BigInt64Array.of(1n, 2n, 3n, 4n, 5n, -19746n, 9870n, 9111111222345323432n)),
        new MessageElement("v10", DataTypes.uint64_t, BigUint64Array.of(1n, 2n, 3n, 4n, 5n, 19746n, 9870n, 12111111222345323432n)),
        MessageElement.string("v11", "This is a test string"),
        new MessageElement("v12", DataTypes.uint32_t, v12)
    );

    const vector = () => MessageElement.nested("testavector", DataTypes.vector_t, "", [new MessageElement("0", DataTypes.double_t, Float64Array.of(1, 2)), new MessageElement("1", DataTypes.double_t, Float64Array.of(1000, -2000.1))]);
    const e2 = entry(1121, "testavector", "aservicepath.o2", 4563);
    e2.addElement(vector());

    const e3 = entry(1122, "testadictionary", "aservicepath.o3", 4567);
    e3.addElement(MessageElement.nested("testavector", DataTypes.dictionary_t, "", [new MessageElement("val1", DataTypes.single_t, Float32Array.of(1, 2)), new MessageElement("val2", DataTypes.single_t, Float32Array.of(1000, -2000.1))]));

    const e4 = entry(1131, "testnamedarray", "aservicepath.o4", 4568);
    const field2 = vector();
    field2.elementName = "field2";
    e4.addElement(MessageElement.nested("teststruct", DataTypes.structure_t, "RobotRaconteurTestService.TestStruct", [new MessageElement("field1", DataTypes.int64_t, BigInt64Array.of(1n, 2n, 3n, 4n, 5n, -19746n, 9870n, 345323432n)), field2]));

    const rng = new LFSRSeqGen(7238);
    const real = Float64Array.from({ length: 125 }, () => (rng.nextUInt32() / 4294967296 - 0.5) * 1e5);
    const e5 = entry(1141, "testamultidimarray", "aservicepath.o5", 4569);
    e5.elements.push(multiDim("ar1", [5, 5, 5], real), multiDim("ar2", [25, 5], real));

    const e6 = entry(1141, "testalist", "aservicepath.o6", 459);
    e6.addElement(MessageElement.nested("testalist", DataTypes.list_t, "", [new MessageElement("val1", DataTypes.single_t, Float32Array.of(1, 3)), new MessageElement("val2", DataTypes.single_t, Float32Array.of(1003, -2000.1))]));

    const m = new Message();
    const h = m.header;
    h.receiverEndpoint = 1023;
    h.senderEndpoint = 9876;
    h.senderNodeID = NodeID.newUniqueID();
    h.receiverNodeID = NodeID.newUniqueID();
    h.senderNodeName = "Sender";
    h.receiverNodeName = "Recv";
    h.metaData = "meta";
    m.entries.push(e1, e2, e3, e4, e5, e6);
    return m;
}
