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

import { RobotRaconteurError, ServiceStub } from "../../src/index.js";
import { assert } from "./check.js";
import { errorNamed } from "./TestUtil.js";

// Port of the Core Python ServiceTestClient3.py

export async function TestProperties(r: ServiceStub): Promise<void>
{
    await r.getProperty("d1");
    await r.setProperty("d1", 3.0819);

    await assert.rejects(r.getProperty("err"), (e: RobotRaconteurError) =>
    {
        assert.equal(e.errorName, "RobotRaconteur.InvalidArgument");
        assert.equal(e.message, "Test message 1");
        return true;
    });

    await assert.rejects(r.setProperty("err", 100), errorNamed("RobotRaconteur.InvalidOperation"));
}

export async function TestFunctions(r: ServiceStub): Promise<void>
{
    await r.callFunction("f1");
    await r.callFunction("f2", [247]);
    assert.equal(await r.callFunction("f3", [1, 2]), 3);

    await assert.rejects(r.callFunction("err_func"), errorNamed("RobotRaconteur.InvalidOperation"));
    await assert.rejects(r.callFunction("err_func2"), errorNamed("com.robotraconteur.testing.TestService5.asynctestexp"));
}
