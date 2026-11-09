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
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BrowserWebSocketTransport, RobotRaconteurNode } from "../../src/index.js";
import { deserializeMessage, Message, serializeMessage } from "../../src/Message.js";
import { clientTests, Vectors } from "../common/ClientTests.js";
import { LFSRSeqGen, newRandomTestMessage, newTestMessage } from "../common/MessageTestUtil.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const vectors = JSON.parse(readFileSync(join(root, "test/fixtures/recorded_vectors.json"), "utf8")) as Vectors;

let server: ChildProcess;
let port = 0;
const node = new RobotRaconteurNode();
node.requestTimeout = 30000;
node.registerTransport(new BrowserWebSocketTransport(node));

before(async () =>
{
    assert.ok(process.env.RR_CORE_TEST, "RR_CORE_TEST must point at the Core test directory");
    server = spawn("python3", ["-u", join(root, "test/server/rr_test_server.py")], {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["pipe", "pipe", "inherit"]
    });
    port = await new Promise<number>((resolve, reject) =>
    {
        server.stdout!.on("data", (d: Buffer) =>
        {
            const m = /PORT (\d+)/.exec(d.toString());
            if (m) resolve(Number(m[1]));
        });
        server.on("exit", () => reject(new Error("Test server exited")));
    });
}, { timeout: 60000 });

after(async () =>
{
    await node.shutdown();
    server.removeAllListeners("exit");
    server.kill();
});

test("Node.js client tests", { timeout: 300000 }, async (t) =>
{
    for (const c of clientTests(node, port, vectors))
    {
        await t.test(c.name, () => c.run());
    }
});

test("Chromium client tests", { timeout: 300000 }, async (t) =>
{
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    try
    {
        const page = await browser.newPage();
        await page.goto("file://" + join(root, "dist-test/browser/index.html"));
        const outcomes = (await page.evaluate((p) => (globalThis as unknown as { runAll: (port: number) => Promise<unknown> }).runAll(p), port)) as { name: string; error?: string }[];
        assert.equal(outcomes.length, clientTests(node, port, vectors).length);
        for (const o of outcomes)
        {
            await t.test(o.name, () =>
            {
                if (o.error) throw new Error(o.error);
            });
        }
    }
    finally
    {
        await browser.close();
    }
});

test("messages are byte compatible with the Core library", { timeout: 120000 }, () =>
{
    const rng = new LFSRSeqGen(35913226, "core_message_compatibility");
    const messages: Message[] = [newTestMessage()];
    for (let i = 0; i < 100; i++) messages.push(newRandomTestMessage(rng));
    const buffers = messages.map(serializeMessage);

    const dir = mkdtempSync(join(tmpdir(), "rr_ts_"));
    try
    {
        writeFileSync(join(dir, "in.bin"), Buffer.concat(buffers));
        execFileSync("python3", [join(root, "test/server/core_message_roundtrip.py"), join(dir, "in.bin"), join(dir, "out.bin")], { stdio: "inherit" });
        const out = readFileSync(join(dir, "out.bin"));

        let pos = 0;
        buffers.forEach((b, i) =>
        {
            const size = out.readUInt32LE(pos + 4);
            const r = new Uint8Array(out.buffer, out.byteOffset + pos, size);
            assert.equal(size, b.length, `message ${i} size`);
            assert.ok(Buffer.compare(r, b) === 0, `message ${i} differs from the Core output`);
            assert.deepEqual(deserializeMessage(r.slice()).entries.length, messages[i]!.entries.length);
            pos += size;
        });
        assert.equal(pos, out.length);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
});
