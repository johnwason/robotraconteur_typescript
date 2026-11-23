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

import { MessageEntryType } from "../../src/DataTypes.js";
import { Message, MessageEntry } from "../../src/Message.js";
import { RobotRaconteurNode } from "../../src/Node.js";
import { StreamConnection, type SocketAdapter, type StreamTransportParent } from "../../src/StreamTransport.js";

/** Starts the heartbeat on a socket without the create connection handshake */
class TestConnection extends StreamConnection
{
    begin(socket: SocketAdapter): void
    {
        this.start(socket);
        this.startHeartbeat();
    }

    get isConnected(): boolean
    {
        return this.connected;
    }
}

test("the receive timeout closes a connection whose writes never complete", async () =>
{
    const node = new RobotRaconteurNode();
    const parent: StreamTransportParent = {
        node,
        heartbeatPeriod: 1000,
        defaultReceiveTimeout: 1500,
        maxMessageSize: 12 * 1024 * 1024,
        removeConnection: () => {}
    };
    let closed = false;
    // The peer stopped reading: no write ever completes, and nothing is received
    const socket: SocketAdapter = {
        write: () => new Promise<void>(() => {}),
        close: () =>
        {
            closed = true;
        }
    };
    const c = new TestConnection(parent);
    c.begin(socket);
    try
    {
        const m = new Message();
        m.entries.push(new MessageEntry(MessageEntryType.ConnectionTest));
        c.sendMessage(m);

        const end = Date.now() + 6000;
        while (c.isConnected && Date.now() < end)
        {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(!c.isConnected, "connection still open after the receive timeout");
        assert.ok(closed);
    }
    finally
    {
        c.close();
    }
});
