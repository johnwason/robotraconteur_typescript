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

import { createServer, connect, Server, Socket } from "node:net";
import assert from "node:assert/strict";
import { RobotRaconteurError, RobotRaconteurNode, ServiceStub, ServiceSubscription, subscribeService } from "../../src/index.js";
import type { Transport } from "../../src/index.js";
import type { ClientTest } from "./ClientTests.js";

const S1 = "RobotRaconteurTestService";
const TIMEOUT = 15000;

/** A TCP relay whose connections can be cut, standing in for a network or service failure */
export class TcpProxy
{
    private server: Server;
    private sockets = new Set<Socket>();
    /** New connections are refused while this is set */
    refusing = false;
    accepted = 0;
    port = 0;

    constructor(private target: number)
    {
        this.server = createServer((client) =>
        {
            if (this.refusing)
            {
                client.destroy();
                return;
            }
            this.accepted++;
            const remote = connect({ host: "localhost", port: this.target });
            for (const [a, b] of [[client, remote], [remote, client]] as const)
            {
                this.sockets.add(a);
                a.on("error", () => undefined);
                a.on("close", () =>
                {
                    this.sockets.delete(a);
                    b.destroy();
                });
                a.pipe(b);
            }
        });
    }

    start(): Promise<void>
    {
        return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () =>
        {
            this.port = (this.server.address() as { port: number }).port;
            resolve();
        }));
    }

    /** Cut every current connection */
    drop(): void
    {
        for (const s of [...this.sockets]) s.destroy();
    }

    close(): void
    {
        this.drop();
        this.server.close();
    }
}

async function until(condition: () => boolean, what: string): Promise<void>
{
    const deadline = Date.now() + TIMEOUT;
    while (!condition())
    {
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Tests of subscriptions, using a proxy so that connections can be lost on demand */
export function subscriptionTests(node: RobotRaconteurNode, proxy: TcpProxy, target_port: number, scheme: string, new_transport: (n: RobotRaconteurNode) => Transport): ClientTest[]
{
    const url = (s = S1, port = proxy.port) => `${scheme}://127.0.0.1:${port}?service=${s}`;
    const tests: ClientTest[] = [];
    const add = (name: string, fn: (s: ServiceSubscription) => Promise<void>) =>
    {
        tests.push({
            name: "subscription: " + name,
            run: async () =>
            {
                proxy.refusing = false;
                const s = subscribeService(node, url());
                s.connectRetryDelay = 50;
                try
                {
                    await fn(s);
                }
                finally
                {
                    s.close();
                }
            }
        });
    };

    add("connects and reports the client", async (s) =>
    {
        const connected: ServiceStub[] = [];
        s.addClientConnectListener((_, __, c) => connected.push(c));
        const c = await s.getDefaultClientWait(TIMEOUT);
        await until(() => connected.length === 1, "connect notification");
        assert.equal(connected[0], c);
        assert.equal(s.getDefaultClient(), c);
        assert.equal(s.getConnectedClients().length, 1);
        assert.ok(!s.getConnectedClients()[0]!.nodeID.isAnyNode);
        assert.equal(s.getConnectedClients()[0]!.serviceName, S1);
        assert.deepEqual(s.getServiceURL(), [url()]);
    });

    add("reconnects after the connection is lost", async (s) =>
    {
        const lost: ServiceStub[] = [];
        s.addClientDisconnectListener((_, __, c) => lost.push(c));
        const first = await s.getDefaultClientWait(TIMEOUT);
        await first.getProperty("d1");

        proxy.drop();
        await until(() => lost.length === 1, "disconnect notification");
        assert.equal(lost[0], first);
        assert.ok(!first.context.connected);

        const second = await s.getDefaultClientWait(TIMEOUT);
        assert.notEqual(second, first);
        assert.ok(second.context.connected);
        await second.getProperty("d1");
    });

    add("keeps retrying while the service is unavailable", async (s) =>
    {
        await s.getDefaultClientWait(TIMEOUT);
        const failures: unknown[] = [];
        s.addClientConnectFailedListener((_, __, urls, e) =>
        {
            assert.deepEqual(urls, [url()]);
            failures.push(e);
        });
        proxy.refusing = true;
        proxy.drop();
        await until(() => failures.length >= 3, "connection failures");
        assert.ok(failures[0] instanceof RobotRaconteurError);
        assert.equal(s.tryGetDefaultClient(), null);
        assert.equal(await s.tryGetDefaultClientWait(0), null);
        await assert.rejects(s.getDefaultClientWait(10), RobotRaconteurError);
        assert.throws(() => s.getDefaultClient(), RobotRaconteurError);

        proxy.refusing = false;
        await s.getDefaultClientWait(TIMEOUT);
    });

    add("wires are connected again and carry values", async (s) =>
    {
        const w = s.subscribeWire("w1");
        await s.getDefaultClientWait(TIMEOUT);
        await until(() => w.activeConnectionCount === 1, "wire connection");
        const changes: unknown[] = [];
        w.addWireValueChangedListener((_, v) => changes.push(v));

        w.setOutValueAll(Float64Array.of(1, 2));
        assert.ok(await w.waitInValueValid(TIMEOUT));
        await until(() => (w.getInValue().value as Float64Array)[0] === 1, "first value");
        assert.ok(changes.length > 0);

        proxy.drop();
        await until(() => w.activeConnectionCount === 0, "wire disconnect");
        await until(() => w.activeConnectionCount === 1, "wire reconnect");

        await new Promise((resolve) => setTimeout(resolve, 5));
        w.setOutValueAll(Float64Array.of(3, 4));
        await until(() => (w.getInValue().value as Float64Array)[0] === 3, "value after reconnecting");
        assert.ok(w.tryGetInValue()!.timestamp.seconds > 0n);
    });

    add("a wire value expires after its lifespan", async (s) =>
    {
        const w = s.subscribeWire("w1");
        w.inValueLifespan = 100;
        await until(() => w.activeConnectionCount === 1, "wire connection");
        assert.equal(await w.waitInValueValid(0), false);
        w.setOutValueAll(Float64Array.of(5));
        assert.ok(await w.waitInValueValid(TIMEOUT));
        await until(() => !w.inValueValid, "lifespan to expire");
        assert.equal(w.tryGetInValue(), null);
        assert.throws(() => w.getInValue(), RobotRaconteurError);
    });

    add("pipes are connected again and carry packets", async (s) =>
    {
        const p = s.subscribePipe("p1");
        await until(() => p.activeConnectionCount === 1, "pipe connection");
        let notified = 0;
        p.addPipePacketReceivedListener(() => notified++);

        p.sendPacketAll(Float64Array.of(1, 2, 3));
        const first = await p.tryReceivePacketWait(TIMEOUT);
        assert.equal((first!.value as Float64Array)[2], 3);
        assert.ok(notified > 0);
        assert.equal(p.tryReceivePacket(), null);
        assert.throws(() => p.receivePacket(), RobotRaconteurError);

        proxy.drop();
        await until(() => p.activeConnectionCount === 0, "pipe disconnect");
        await until(() => p.activeConnectionCount === 1, "pipe reconnect");

        p.sendPacketAll(Float64Array.of(7));
        const peeked = await p.tryReceivePacketWait(TIMEOUT, true);
        assert.equal((peeked!.value as Float64Array)[0], 7);
        assert.equal(p.available, 1);
        assert.equal((p.receivePacket() as Float64Array)[0], 7);
    });

    add("a member added after connecting is connected", async (s) =>
    {
        await s.getDefaultClientWait(TIMEOUT);
        const w = s.subscribeWire("w1");
        await until(() => w.activeConnectionCount === 1, "wire connection");
        w.close();
        await until(() => w.activeConnectionCount === 0, "wire to close");
    });

    add("members of sub objects are connected", async (s) =>
    {
        const o = s.subscribeSubObject("*.o1");
        const sub = await o.getDefaultClientWait(TIMEOUT);
        assert.equal(sub.objectType, "com.robotraconteur.testing.TestService1.sub1");
        assert.equal((await o.tryGetDefaultClient())?.objectType, sub.objectType);

        const missing = s.subscribeSubObject("*.no_such_object");
        assert.equal(await missing.tryGetDefaultClient(), null);
        await assert.rejects(missing.getDefaultClient(), RobotRaconteurError);
    });

    add("closing stops reconnecting and fails waits", async (s) =>
    {
        const c = await s.getDefaultClientWait(TIMEOUT);
        const w = s.subscribeWire("w1");
        await until(() => w.activeConnectionCount === 1, "wire connection");
        const wait = w.waitInValueValid();
        const closed: boolean[] = [];
        s.addCloseListener(() => closed.push(true));

        s.close();
        s.close();
        assert.deepEqual(closed, [true]);
        await until(() => !c.context.connected, "client to disconnect");
        assert.equal(await wait, false);
        assert.equal(s.tryGetDefaultClient(), null);
        assert.equal(await s.tryGetDefaultClientWait(), null);

        const accepted = proxy.accepted;
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(proxy.accepted, accepted, "reconnected after closing");
    });

    add("a claimed client survives closing", async (s) =>
    {
        const c = await s.getDefaultClientWait(TIMEOUT);
        s.claimClient(c);
        s.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(c.context.connected);
        await c.getProperty("d1");
        await node.disconnectService(c);
    });

    add("soft close disconnects, keeps members, and can start again", async (s) =>
    {
        let disconnected = 0;
        s.addClientDisconnectListener(() => disconnected++);
        const first = await s.getDefaultClientWait(TIMEOUT);
        const w = s.subscribeWire("w1");
        await until(() => w.activeConnectionCount === 1, "wire connection");

        s.softClose();
        await until(() => s.tryGetDefaultClient() === null && !first.context.connected, "disconnection");
        await until(() => disconnected === 1, "disconnect notification");
        assert.equal(s.getClientIDs().length, 0);
        assert.throws(() => s.getServiceURL(), RobotRaconteurError);

        s.initServiceURL([url()]);
        const second = await s.getDefaultClientWait(TIMEOUT);
        assert.notEqual(second, first);
        await until(() => w.activeConnectionCount === 1, "wire to resume");
    });

    add("the URL can be changed", async (s) =>
    {
        const first = await s.getDefaultClientWait(TIMEOUT);
        const direct = url(S1, target_port);
        s.updateServiceURL(direct, undefined, undefined, undefined, true);
        assert.deepEqual(s.getServiceURL(), [direct]);
        await until(() => !first.context.connected, "old connection to close");
        const accepted = proxy.accepted;
        const second = await s.getDefaultClientWait(TIMEOUT);
        await second.getProperty("d1");
        assert.equal(proxy.accepted, accepted, "connected through the old URL");
        assert.throws(() => s.updateServiceURL([url("a"), url("b")]), RobotRaconteurError);
    });

    tests.push({
        name: "subscription: candidate URLs must name one service",
        run: async () =>
        {
            assert.throws(() => subscribeService(node, []), RobotRaconteurError);
            assert.throws(() => subscribeService(node, [url("a"), url("b")]), RobotRaconteurError);
        }
    });

    tests.push({
        name: "several candidate URLs connect using the one that works",
        run: async () =>
        {
            const c = await node.connectService([`${scheme}://127.0.0.1:1?service=${S1}`, url(S1, target_port)]);
            await c.getProperty("d1");
            await node.disconnectService(c);
            await assert.rejects(node.connectService([`${scheme}://127.0.0.1:1?service=${S1}`, `${scheme}://127.0.0.1:2?service=${S1}`]), RobotRaconteurError);
            await assert.rejects(node.connectService([]), RobotRaconteurError);
        }
    });

    tests.push({
        name: "subscription: shutting down the node closes subscriptions",
        run: async () =>
        {
            const n = new RobotRaconteurNode();
            n.registerTransport(new_transport(n));
            const s = subscribeService(n, url());
            s.connectRetryDelay = 50;
            const c = await s.getDefaultClientWait(TIMEOUT);
            await n.shutdown();
            assert.ok(!c.context.connected);
            assert.equal(s.tryGetDefaultClient(), null);
            const accepted = proxy.accepted;
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(proxy.accepted, accepted, "reconnected after shutdown");
        }
    });

    return tests;
}
