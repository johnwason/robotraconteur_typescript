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

import { MessageEntryType, MessageErrorType } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import { findElement, Message, MessageElement, MessageEntry } from "./Message.js";
import { packElement, TypeContext, unpackElement, VarValue } from "./Pack.js";
import type { ServiceDefinition, TypeDefinition } from "./ServiceDefinition.js";

const VARVALUE: TypeDefinition = { type: "varvalue" };
/** Scope for packing values that only contain varvalue, which need no service definition */
const NO_SCOPE = { name: "" } as ServiceDefinition;

/** The error carried by a response entry */
export function entryToError(e: MessageEntry, types: TypeContext): RobotRaconteurError
{
    const err = new RobotRaconteurError(e.error, findElement(e.elements, "errorname")?.castString() ?? "RobotRaconteur.RemoteError", findElement(e.elements, "errorstring")?.castString() ?? "");
    const sub = findElement(e.elements, "errorsubname");
    if (sub) err.errorSubName = sub.castString();
    const param = findElement(e.elements, "errorparam");
    if (param)
    {
        err.errorParam = unpackElement(param, VARVALUE, NO_SCOPE, types) as VarValue | null;
    }
    return err;
}

/**
 * Fill in a response entry for an error. Errors that are not RobotRaconteurError are reported as
 * RemoteError with the name of the JavaScript error, as Core does for errors in other languages.
 */
export function errorToEntry(err: unknown, entry: MessageEntry, types?: TypeContext): void
{
    const e = err as Partial<RobotRaconteurError> & { name?: string; message?: string };
    const is_rr = err instanceof RobotRaconteurError;
    entry.error = is_rr ? (e.errorCode as MessageErrorType) : MessageErrorType.RemoteError;
    entry.addElement(MessageElement.string("errorname", is_rr ? e.errorName! : (e.name ?? "Error")));
    entry.addElement(MessageElement.string("errorstring", e.message ?? String(err)));
    if (is_rr && e.errorSubName) entry.addElement(MessageElement.string("errorsubname", e.errorSubName));
    if (is_rr && e.errorParam != null && types)
    {
        try
        {
            entry.addElement(packElement("errorparam", VARVALUE, e.errorParam, NO_SCOPE, types));
        }
        catch
        {
            // The error is still reported without a parameter that cannot be packed
        }
    }
}

/**
 * A response to each request in a message, reporting the same error for each, as Core's
 * GenerateErrorReturnMessage. Empty if the message has no requests.
 */
export function errorReturnMessage(m: Message, code: MessageErrorType, name: string, message: string): Message
{
    const ret = new Message();
    ret.header.receiverNodeName = m.header.senderNodeName;
    ret.header.senderNodeName = m.header.receiverNodeName;
    ret.header.receiverNodeID = m.header.senderNodeID;
    ret.header.receiverEndpoint = m.header.senderEndpoint;
    ret.header.senderEndpoint = m.header.receiverEndpoint;
    ret.header.senderNodeID = m.header.receiverNodeID;
    for (const e of m.entries)
    {
        if (e.entryType % 2 !== 1) continue;
        const r = new MessageEntry((e.entryType + 1) as MessageEntryType, e.memberName);
        r.requestID = e.requestID;
        r.servicePath = e.servicePath;
        r.error = code;
        r.addElement(MessageElement.string("errorname", name));
        r.addElement(MessageElement.string("errorstring", message));
        ret.entries.push(r);
    }
    return ret;
}
