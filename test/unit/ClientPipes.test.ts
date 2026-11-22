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

import { DataTypes, MessageEntryType } from "../../src/DataTypes.js";
import { Message, MessageElement, MessageEntry } from "../../src/Message.js";
import { RobotRaconteurNode } from "../../src/Node.js";
import { NodeID } from "../../src/NodeID.js";
import type { Endpoint, ITransportConnection, Transport } from "../../src/Transport.js";

const DEF = `service experimental.fake_pipes

stdver 0.10

object obj
    pipe double p
end
`;

/** A service answered by the test: connects, then holds other requests until the test replies */
function fakeService()
{
    const service_id = NodeID.newUniqueID();
    const held: MessageEntry[] = [];
    let endpoint: Endpoint | undefined;
    const reply = (entries: MessageEntry[]) =>
    {
        const m = new Message();
        m.header.senderNodeID = service_id;
        m.header.senderEndpoint = 77;
        m.header.receiverEndpoint = endpoint!.localEndpoint;
        m.entries = entries;
        endpoint!.messageReceived(m);
    };
    const send = (m: Message) =>
    {
        for (const e of m.entries)
        {
            if (e.entryType !== MessageEntryType.ConnectClientCombined && e.entryType !== MessageEntryType.DisconnectClient)
            {
                held.push(e);
                continue;
            }
            const r = new MessageEntry((e.entryType + 1) as MessageEntryType, "");
            r.requestID = e.requestID;
            r.servicePath = e.servicePath;
            if (e.entryType === MessageEntryType.ConnectClientCombined) r.addElement(MessageElement.nested("servicedefs", DataTypes.list_t, "", [MessageElement.string("0", DEF)]));
            if (e.entryType === MessageEntryType.ConnectClientCombined) r.addElement(MessageElement.string("objecttype", "experimental.fake_pipes.obj"));
            queueMicrotask(() => reply([r]));
        }
    };
    const transport: Transport = {
        canConnectService: () => true,
        createTransportConnection: async (_url: string, ep: Endpoint): Promise<ITransportConnection> =>
        {
            endpoint = ep;
            return { remoteNodeID: service_id, useCombinedConnection: true, sendMessage: send, sendMessageWait: async (m: Message) => send(m), close: () => undefined };
        },
        close: () => undefined
    };
    return { transport, held, reply };
}

function pipePacket(index: number, value: number): MessageEntry
{
    const e = new MessageEntry(MessageEntryType.PipePacket, "p");
    e.servicePath = "svc";
    e.addElement(MessageElement.nested(String(index), DataTypes.dictionary_t, "", [new MessageElement("packetnumber", DataTypes.uint32_t, Uint32Array.of(1)), new MessageElement("packet", DataTypes.double_t, Float64Array.of(value))]));
    return e;
}

test("packets that arrive before a pipe connect reply create at most one early endpoint per connect", async () =>
{
    const f = fakeService();
    const node = new RobotRaconteurNode();
    node.registerTransport(f.transport);
    try
    {
        const stub = await node.connectService("rr+tcp://h:1/?service=svc");
        const connecting = stub.connectPipe("p");
        connecting.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 0));
        const req = f.held.find((e) => e.entryType === MessageEntryType.PipeConnectReq)!;
        assert.ok(req);

        // The service sends packets for many indexes before it answers
        for (let i = 1; i <= 100; i++) f.reply([pipePacket(i, i)]);
        assert.ok((stub as unknown as { early_pipes: Map<string, unknown> }).early_pipes.size <= 1);

        const r = new MessageEntry(MessageEntryType.PipeConnectRet, "p");
        r.requestID = req.requestID;
        r.servicePath = "svc";
        r.addElement(new MessageElement("index", DataTypes.int32_t, Int32Array.of(1)));
        f.reply([r]);
        const h = await connecting;
        assert.equal(h.index, 1);
        assert.equal(h.available, 1);
    }
    finally
    {
        await node.shutdown();
    }
});
