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

import { ClientContext } from "../../src/Client.js";
import { MessageEntryType } from "../../src/DataTypes.js";
import { Message, MessageEntry } from "../../src/Message.js";
import { RobotRaconteurNode } from "../../src/Node.js";
import { NodeID } from "../../src/NodeID.js";

function connectReply(type: MessageEntryType, nodeid: NodeID, endpoint: number, name: string): Message
{
    const m = new Message();
    m.header.senderNodeID = nodeid;
    m.header.senderEndpoint = endpoint;
    m.header.senderNodeName = name;
    m.entries.push(new MessageEntry(type, ""));
    return m;
}

test("the service identity is taken only from the first connect reply, from the expected node", () =>
{
    const a = NodeID.newUniqueID();
    const b = NodeID.newUniqueID();

    const c = new ClientContext(new RobotRaconteurNode());
    c.messageReceived(connectReply(MessageEntryType.ConnectClientCombinedRet, a, 5, "nodea"));
    assert.equal(c.remoteEndpoint, 5);
    assert.ok(c.remoteNodeID.equals(a));
    c.messageReceived(connectReply(MessageEntryType.ConnectClientRet, b, 9, "nodeb"));
    c.messageReceived(connectReply(MessageEntryType.ConnectClientCombinedRet, b, 9, "nodeb"));
    assert.equal(c.remoteEndpoint, 5);
    assert.ok(c.remoteNodeID.equals(a));
    assert.equal(c.remoteNodeName, "nodea");

    // The URL named a NodeID: a reply from another node is not accepted
    const d = new ClientContext(new RobotRaconteurNode());
    d.remoteNodeID = a;
    d.messageReceived(connectReply(MessageEntryType.ConnectClientCombinedRet, b, 9, "nodeb"));
    assert.equal(d.remoteEndpoint, 0);
    assert.ok(d.remoteNodeID.equals(a));
    d.messageReceived(connectReply(MessageEntryType.ConnectClientCombinedRet, a, 7, "nodea"));
    assert.equal(d.remoteEndpoint, 7);
});
