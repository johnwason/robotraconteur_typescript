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

import { RobotRaconteurError } from "../../src/Error.js";
import { RobotRaconteurNode } from "../../src/Node.js";
import type { Endpoint, ITransportConnection, Transport } from "../../src/Transport.js";

const select = (urls: string[]) => RobotRaconteurNode.selectRemoteNodeURL(urls);

test("URLs are preferred in the same order as Core", () =>
{
    const plain = "rr+tcp://192.168.1.5:48653/?service=s";
    const tls = "rrs+tcp://192.168.1.5:48653/?service=s";
    assert.equal(select([plain, tls]), tls);
    assert.equal(select(["rr+ws://h/?service=s", plain]), plain);
    assert.equal(select(["rr+ws://h/?service=s", "rr+wss://h/?service=s"]), "rr+ws://h/?service=s");

    // Local transports first, then TLS and plain TCP, each preferring loopback then link-local
    assert.equal(select([tls, "rr+local:///?nodename=n&service=s", "rr+intra:///?nodename=n&service=s"]), "rr+intra:///?nodename=n&service=s");
    assert.equal(select([tls, "rr+local:///?nodename=n&service=s"]), "rr+local:///?nodename=n&service=s");
    assert.equal(select([tls, "rrs+tcp://[FE80::1%25eth0]:48653/?service=s", "rrs+tcp://LOCALHOST:1/?service=s"]), "rrs+tcp://LOCALHOST:1/?service=s");
    assert.equal(select(["rrs+tcp://localhost:1/?service=s", "rrs+tcp://[::1]:1/?service=s", "rrs+tcp://127.0.0.1:1/?service=s"]), "rrs+tcp://127.0.0.1:1/?service=s");
    assert.equal(select([tls, "rrs+tcp://[fe80::1]:1/?service=s"]), "rrs+tcp://[fe80::1]:1/?service=s");
    assert.equal(select(["rr+tcp://127.0.0.1:1/?service=s", tls]), tls);
    assert.throws(() => select([]), RobotRaconteurError);
});

test("candidate URLs are started in order of preference, shortly apart", async () =>
{
    const started: { url: string; time: number }[] = [];
    const transport: Transport = {
        canConnectService: () => true,
        createTransportConnection: async (url: string, _endpoint: Endpoint): Promise<ITransportConnection> =>
        {
            started.push({ url, time: Date.now() });
            throw new RobotRaconteurError(1, "RobotRaconteur.ConnectionError", "refused " + url);
        },
        close: () => undefined
    };
    const node = new RobotRaconteurNode();
    node.registerTransport(transport);
    const urls = ["rr+ws://h/?service=s", "rr+tcp://h:1/?service=s", "rrs+tcp://h:1/?service=s"];
    await assert.rejects(node.connectService(urls), /refused rrs\+tcp/);
    assert.deepEqual(started.map((s) => s.url), ["rrs+tcp://h:1/?service=s", "rr+tcp://h:1/?service=s", "rr+ws://h/?service=s"]);
    assert.ok(started[1]!.time - started[0]!.time >= 10, "the next URL waits for the preferred one to start");
    await node.shutdown();
});
