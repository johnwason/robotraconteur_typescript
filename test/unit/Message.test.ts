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
import { test } from "node:test";

import { DataTypes, MessageEntryType, MessageErrorType } from "../../src/DataTypes.js";
import { RobotRaconteurError } from "../../src/Error.js";
import { deserializeMessage, Message, MessageElement, MessageEntry, serializeMessage } from "../../src/Message.js";
import { NodeID } from "../../src/NodeID.js";
import { parseConnectionUrl } from "../../src/Transport.js";

function sample(): Message
{
    const m = new Message();
    m.header.senderNodeID = NodeID.newUniqueID();
    m.header.receiverNodeID = NodeID.newUniqueID();
    m.header.senderEndpoint = 0xdeadbeef;
    m.header.receiverEndpoint = 12;
    m.header.senderNodeName = "sender";
    m.header.receiverNodeName = "réceiver";
    m.header.metaData = "meta";
    m.header.messageID = 65000;
    m.header.messageResID = 7;

    const e = new MessageEntry(MessageEntryType.FunctionCallReq, "func");
    e.servicePath = "service.obj";
    e.requestID = 0x80000001;
    e.error = MessageErrorType.StopIteration;
    e.metaData = "entry meta";
    e.addElement(new MessageElement("d", DataTypes.double_t, Float64Array.of(1.5, -2.5e300)));
    e.addElement(new MessageElement("s", DataTypes.single_t, Float32Array.of(1.5)));
    e.addElement(new MessageElement("i8", DataTypes.int8_t, Int8Array.of(-128, 127)));
    e.addElement(new MessageElement("u16", DataTypes.uint16_t, Uint16Array.of(65535)));
    e.addElement(new MessageElement("i64", DataTypes.int64_t, BigInt64Array.of(-9007199254740993n)));
    e.addElement(new MessageElement("u64", DataTypes.uint64_t, BigUint64Array.of(18446744073709551615n)));
    e.addElement(new MessageElement("c", DataTypes.cdouble_t, Float64Array.of(1, 2, 3, 4)));
    e.addElement(new MessageElement("b", DataTypes.bool_t, Uint8Array.of(1, 0)));
    e.addElement(MessageElement.string("str", "héllo 😁"));
    e.addElement(new MessageElement("v", DataTypes.void_t, null));
    e.addElement(MessageElement.nested("st", DataTypes.structure_t, "a.b.c", [MessageElement.nested("in", DataTypes.list_t, "", [MessageElement.string("0", "x")])]));
    m.entries.push(e);
    m.entries.push(new MessageEntry(MessageEntryType.ConnectionTest));
    return m;
}

test("message round trip", () =>
{
    const m = sample();
    const data = serializeMessage(m);
    const r = deserializeMessage(data);
    // Element sizes and offsets are recomputed so compare structure rather than object identity
    assert.deepEqual(r.header, m.header);
    assert.equal(r.entries.length, 2);
    const a = m.entries[0]!;
    const b = r.entries[0]!;
    assert.equal(b.entryType, a.entryType);
    assert.equal(b.requestID, a.requestID);
    assert.equal(b.error, a.error);
    assert.equal(b.servicePath, a.servicePath);
    assert.equal(b.memberName, a.memberName);
    assert.equal(b.metaData, a.metaData);
    assert.deepEqual(b.elements, a.elements);
    assert.deepEqual(serializeMessage(r), data);
});

test("message layout matches Message Version 2", () =>
{
    const m = new Message();
    m.entries.push(new MessageEntry(MessageEntryType.ConnectionTest));
    const d = serializeMessage(m);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    assert.equal(new TextDecoder().decode(d.subarray(0, 4)), "RRAC");
    assert.equal(v.getUint32(4, true), d.length);
    assert.equal(v.getUint16(8, true), 2);
    assert.equal(v.getUint16(10, true), 64);
    assert.equal(d.length, 64 + 22);
    assert.equal(v.getUint32(64, true), 22);
    assert.equal(v.getUint16(68, true), 111);
});

test("type names are only written for nested elements", () =>
{
    const m = new Message();
    const e = new MessageEntry(MessageEntryType.ConnectionTest);
    const el = new MessageElement("a", DataTypes.double_t, Float64Array.of(1));
    el.elementTypeName = "not.written";
    e.addElement(el);
    m.entries.push(e);
    assert.equal(deserializeMessage(serializeMessage(m)).entries[0]!.elements[0]!.elementTypeName, "");
});

test("deserialize rejects corrupted messages", () =>
{
    const good = serializeMessage(sample());
    const mutate = (at: number, value: number) =>
    {
        const b = good.slice();
        new DataView(b.buffer).setUint32(at, value, true);
        return b;
    };
    assert.throws(() => deserializeMessage(mutate(0, 0)));
    assert.throws(() => deserializeMessage(mutate(4, good.length + 1)));
    assert.throws(() => deserializeMessage(good.subarray(0, good.length - 1)));

    const first_entry = new DataView(good.buffer, good.byteOffset).getUint16(10, true);
    assert.throws(() => deserializeMessage(mutate(first_entry, good.length)));

    const b = good.slice();
    for (let i = first_entry + 4; i < b.length; i += 7)
    {
        const c = b.slice();
        c[i] = c[i]! ^ 0xff;
        try
        {
            deserializeMessage(c);
        }
        catch (e)
        {
            assert.ok(e instanceof RangeError || e instanceof TypeError);
        }
    }
});

test("serialize rejects a header longer than 65535 bytes", () =>
{
    // Each string fits in its uint16 length, but the header size does not, as in Core MessageHeader::ComputeSize
    const m = sample();
    m.header.senderNodeName = "a".repeat(30000);
    m.header.metaData = "b".repeat(40000);
    assert.throws(() => serializeMessage(m), RangeError);
});

test("deserialize limits the nesting depth of element lists to 512, as Core", () =>
{
    const nested = (levels: number) =>
    {
        let e = new MessageElement("v", DataTypes.int32_t, Int32Array.of(1));
        for (let i = 0; i < levels; i++) e = MessageElement.nested("v", DataTypes.list_t, "", [e]);
        const m = new Message();
        const entry = new MessageEntry(MessageEntryType.FunctionCallReq, "f");
        entry.addElement(e);
        m.entries.push(entry);
        return serializeMessage(m);
    };
    assert.equal(deserializeMessage(nested(512)).entries[0]!.elements.length, 1);
    assert.throws(() => deserializeMessage(nested(513)), RangeError);
});

test("unknown element types are reported as malformed messages or data type errors", () =>
{
    const m = new Message();
    const entry = new MessageEntry(MessageEntryType.FunctionCallReq, "f");
    entry.addElement(new MessageElement("v", DataTypes.int32_t, Int32Array.of(1)));
    m.entries.push(entry);
    const b = serializeMessage(m);
    // The element's name ("v", length 1) is followed by its type
    let i = 0;
    while (!(b[i] === 1 && b[i + 1] === 0 && b[i + 2] === 0x76)) i++;
    b[i + 3] = 50;
    assert.throws(() => deserializeMessage(b), RangeError);

    entry.elements = [new MessageElement("v", 50 as DataTypes, Int32Array.of(1))];
    assert.throws(() => serializeMessage(m), (e: RobotRaconteurError) => e.errorName === "RobotRaconteur.DataTypeError");
});

test("only the nested element types Core reads are accepted", () =>
{
    const message = (type: number) =>
    {
        const m = new Message();
        const e = new MessageEntry(MessageEntryType.FunctionCallReq, "f");
        e.addElement(MessageElement.nested("x", type as DataTypes, "t", [new MessageElement("a", DataTypes.int32_t, Int32Array.of(1))]));
        m.entries.push(e);
        return serializeMessage(m);
    };
    for (const type of [101, 102, 103, 108, 109, 110, 111, 115, 116, 117])
    {
        const el = deserializeMessage(message(type)).entries[0]!.elements[0]!;
        assert.equal(el.elementType, type);
        assert.equal(el.elementTypeName, "t");
    }
    // As Core's MessageElement::Read: object_t, varvalue_t, varobject_t, enum_t, namedtype_t, namedarray_t and
    // undefined types are errors
    for (const type of [104, 105, 106, 107, 112, 113, 114, 118, 200, 1000, 65535])
    {
        assert.throws(() => deserializeMessage(message(type)), RangeError, String(type));
    }
});

test("NodeID parsing and formatting", () =>
{
    const s = "{00112233-4455-6677-8899-aabbccddeeff}";
    const n = new NodeID(s);
    assert.equal(n.toString(), s);
    assert.ok(n.equals(new NodeID("00112233-4455-6677-8899-AABBCCDDEEFF")));
    assert.ok(NodeID.Any.isAnyNode);
    assert.ok(!n.isAnyNode);
    assert.throws(() => new NodeID("bad"));
});

test("connection URL parsing", () =>
{
    const u = parseConnectionUrl("rr+ws://localhost:22223/path?nodename=my_node&service=svc%20a");
    assert.equal(u.scheme, "rr+ws");
    assert.equal(u.host, "localhost");
    assert.equal(u.port, 22223);
    assert.equal(u.nodename, "my_node");
    assert.equal(u.service, "svc a");
    assert.ok(u.nodeid.isAnyNode);

    const v6 = parseConnectionUrl("rr+wss://[::1]?service=s&nodeid={00112233-4455-6677-8899-aabbccddeeff}");
    assert.equal(v6.host, "[::1]");
    assert.equal(v6.port, 443);
    assert.ok(!v6.nodeid.isAnyNode);

    const old = parseConnectionUrl("tcp://localhost:48653/node/service");
    assert.equal(old.nodename, "node");
    assert.equal(old.service, "service");

    for (const bad of ["nonsense", "rr+ws://localhost", "rr+ws://localhost?nodename=x", "rr+ws://localhost?service=s&nodename=1bad", "rr+ws://localhost?service=a%zz"])
    {
        assert.throws(() => parseConnectionUrl(bad), (e: unknown) => e instanceof RobotRaconteurError && e.errorCode === MessageErrorType.ConnectionError, bad);
    }
});

test("connection URLs with an invalid node ID give a connection URL error", () =>
{
    for (const bad of ["rr+tcp://localhost:1/?nodeid=x&service=s", "rr+ws://localhost?service=s&nodeid={0011}", "tcp://localhost:1/{x}/s"])
    {
        assert.throws(() => parseConnectionUrl(bad), (e: unknown) => e instanceof RobotRaconteurError && e.errorCode === MessageErrorType.ConnectionError && e.message === "Invalid connection URL", bad);
    }
});
