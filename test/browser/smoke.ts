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

import { BrowserWebSocketTransport, RobotRaconteurNode } from "../../src/index.js";
import { clientTests, Vectors } from "../common/ClientTests.js";

// Runs the complete shared client test suite from a real browser page

interface Outcome
{
    name: string;
    error?: string;
}

function countConstructions(name: string): () => number
{
    const g = globalThis as unknown as Record<string, new (...args: unknown[]) => object>;
    let count = 0;
    g[name] = new Proxy(g[name]!, {
        construct(target, args, new_target)
        {
            count++;
            return Reflect.construct(target, args, new_target);
        }
    });
    return () => count;
}

async function runAll(port: number, use_stream: boolean): Promise<{ outcomes: Outcome[]; streams: number; sockets: number }>
{
    const streams = countConstructions("WebSocketStream");
    const sockets = countConstructions("WebSocket");

    const node = new RobotRaconteurNode();
    node.requestTimeout = 30000;
    const transport = new BrowserWebSocketTransport(node);
    transport.useWebSocketStream = use_stream;
    node.registerTransport(transport);
    const vectors = (globalThis as unknown as { rr_vectors: Vectors }).rr_vectors;

    const out: Outcome[] = [];
    for (const t of clientTests(node, port, vectors))
    {
        try
        {
            await t.run();
            out.push({ name: t.name });
        }
        catch (e)
        {
            out.push({ name: t.name, error: String((e as Error).stack ?? e) });
        }
    }
    await node.shutdown();
    return { outcomes: out, streams: streams(), sockets: sockets() };
}

(globalThis as unknown as { runAll: typeof runAll }).runAll = runAll;
