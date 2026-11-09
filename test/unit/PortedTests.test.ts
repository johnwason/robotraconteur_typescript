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

import { encodeServicePathIndex } from "../../src/Client.js";
import { deserializeMessage, Message, serializeMessage } from "../../src/Message.js";
import { parseServiceDefinition } from "../../src/ServiceDefinition.js";
import { LFSRSeqGen, newRandomTestMessage, newTestMessage } from "../common/MessageTestUtil.js";

function compareRoundTrip(m: Message): void
{
    const data = serializeMessage(m);
    const r = deserializeMessage(data);
    assert.deepEqual(r, m);
    assert.deepEqual(serializeMessage(r), data);
}

test("MessageSerialization Test", () =>
{
    compareRoundTrip(newTestMessage());
});

test("MessageSerialization RandomTest", () =>
{
    const rng = new LFSRSeqGen(35913226, "message_serialization_random_test");
    for (let i = 0; i < 100; i++) compareRoundTrip(newRandomTestMessage(rng));
});

test("LFSR sequence matches the Core lfsr.py generator", () =>
{
    const g = new LFSRSeqGen(35913226, "Hello World!");
    assert.deepEqual([g.nextUInt32(), g.nextUInt32(), g.nextUInt32(), g.nextUInt8(), g.nextUInt16(), g.nextLen(16), g.nextLen(256), g.nextDist(101, 120)], [1105658246, 552829123, 2423898209, 48, 28696, 12, 126, 116]);
    assert.equal(g.next2(), 14285953486140011392n);
    assert.equal(g.nextStringVarLen(1).length, 0);
});

test("EncodeServicePathIndex matches Core", () =>
{
    assert.equal(encodeServicePathIndex("alphaname1"), "alphaname1");
    assert.equal(encodeServicePathIndex("gamma_with_special!%$moreWords()*.[]"), "gamma%5fwith%5fspecial%21%25%24moreWords%28%29%2a%2e%5b%5d");
    assert.equal(encodeServicePathIndex("delta_index_with_special!%$morewords()*.[]\n\t4927`\"?-"), "delta%5findex%5fwith%5fspecial%21%25%24morewords%28%29%2a%2e%5b%5d%0a%094927%60%22%3f%2d");
    assert.match(encodeServicePathIndex("29471``\"'epsilon_with_special?\n\\-!%$more.[]words()*long_string_of_garbage\t\r"), /^[a-zA-Z0-9%]+$/);
    assert.equal(encodeServicePathIndex("café"), "caf%c3%a9");
});

test("member modifiers follow RobDefTest", () =>
{
    const d = parseServiceDefinition("service a.b\nstdver 0.10\nobject o\nproperty int32 readme [readonly]\nproperty int32 writeme [writeonly]\npipe int32 u [unreliable,readonly]\nwire int32 w [ readonly ]\nmemory double[] m [readonly]\nproperty double p\nproperty int32 x [unknown, unknown_3(23, 45.8e-5, c), nolock]\nend\n");
    const mods = Object.fromEntries(d.objects[0]!.members.map((m) => [m.name, m.modifiers]));
    assert.deepEqual(mods.readme, ["readonly"]);
    assert.deepEqual(mods.writeme, ["writeonly"]);
    assert.deepEqual(mods.u, ["unreliable", "readonly"]);
    assert.deepEqual(mods.w, ["readonly"]);
    assert.deepEqual(mods.m, ["readonly"]);
    assert.equal(mods.p, undefined);
    assert.deepEqual(mods.x, ["unknown", "unknown_3(23, 45.8e-5, c)", "nolock"]);
});
