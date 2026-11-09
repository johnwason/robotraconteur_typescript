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

import type { VarValue } from "./Pack.js";

/**
 * Error raised by Robot Raconteur operations, whether detected locally or returned by the service.
 * The specific error is identified by errorName, for example "RobotRaconteur.InvalidOperation" or
 * a fully qualified service exception name.
 */
export class RobotRaconteurError extends Error
{
    errorCode: number;
    errorName: string;
    errorSubName?: string;
    errorParam?: VarValue | null;

    constructor(errorCode: number, errorName: string, message: string)
    {
        super(message);
        this.name = "RobotRaconteurError";
        this.errorCode = errorCode;
        this.errorName = errorName;
    }

    /** True if a generator has no more values */
    get isStopIteration(): boolean
    {
        return this.errorName === "RobotRaconteur.StopIteration";
    }
}
