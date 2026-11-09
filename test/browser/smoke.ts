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

import { BrowserWebSocketTransport, GeneratorHandle, RobotRaconteurNode, ServiceStub } from "../../src/index.js";

// Exercises each kind of client operation from a real browser page

async function runSmoke(port: number): Promise<Record<string, unknown>>
{
    const node = new RobotRaconteurNode();
    node.registerTransport(new BrowserWebSocketTransport(node));
    const r1: ServiceStub = await node.connectService(`rr+ws://localhost:${port}?service=RobotRaconteurTestService`);
    const r2: ServiceStub = await node.connectService(`rr+ws://localhost:${port}?service=RobotRaconteurTestService2`);

    await r1.setProperty("d1", 3.456);
    const d1 = await r1.getProperty("d1");
    const func3 = await r1.callFunction("func3", [2.2, 3.3]);
    const o1 = await r1.getObjRef("o1");
    await o1.setProperty("d2", { dims: [2, 1], array: [1.5, 2.5] });
    const o1_d2 = (await o1.getProperty("d2")) as { dims: Uint32Array };

    const g = (await r2.callFunction("gen_func1")) as GeneratorHandle;
    const gen: unknown[] = [];
    try
    {
        for (;;) gen.push(await r2.callFunctionGenNext(g));
    }
    catch (e)
    {
        if (!(e as { isStopIteration?: boolean }).isStopIteration) throw e;
    }

    const peek = (await r2.peekWireInValue("peekwire")).value;
    await r2.pokeWireOutValue("pokewire", 75738265);
    const poke = (await r2.peekWireOutValue("pokewire")).value;

    await node.shutdown();
    return { d1, func3, o1_dims: Array.from(o1_d2.dims), gen, peek, poke };
}

(globalThis as unknown as { runSmoke: typeof runSmoke }).runSmoke = runSmoke;
