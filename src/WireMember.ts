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

import { DataTypes, MessageEntryType, MessageErrorType } from "./DataTypes.js";
import { RobotRaconteurError } from "./Error.js";
import { getElement, MessageElement, MessageEntry } from "./Message.js";
import { MemberDefinition, TypeDefinition } from "./ServiceDefinition.js";

const TIMESPEC = "RobotRaconteur.TimeSpec";

/** A timestamp as Robot Raconteur sends it: seconds and nanoseconds since the Unix epoch */
export interface TimeSpec
{
    /** Seconds since the Unix epoch */
    seconds: bigint;
    /** Nanoseconds within the second, from 0 to 999999999 */
    nanoseconds: number;
}

/** Which way a wire or pipe carries values, as seen by this client. Set with the readonly and writeonly modifiers in the service definition */
export type MemberDirection = "both" | "readonly" | "writeonly";

/** What wire and pipe handles need from the object that owns them */
export interface MemberContext
{
    readonly servicePath: string;
    pack(name: string, t: TypeDefinition, v: unknown): MessageElement;
    unpack(e: MessageElement, t: TypeDefinition): unknown;
    request(type: MessageEntryType, name: string, elements?: MessageElement[]): Promise<MessageEntry>;
    send(e: MessageEntry): void;
    sendWait(e: MessageEntry): Promise<void>;
}

export function memberError(code: MessageErrorType, name: string, message: string): RobotRaconteurError
{
    return new RobotRaconteurError(code, "RobotRaconteur." + name, message);
}

export function memberDirection(m: MemberDefinition): MemberDirection
{
    if (m.modifiers?.includes("readonly")) return "readonly";
    if (m.modifiers?.includes("writeonly")) return "writeonly";
    return "both";
}

export function timeNow(): TimeSpec
{
    const now = Date.now();
    return { seconds: BigInt(Math.floor(now / 1000)), nanoseconds: (now % 1000) * 1000000 };
}

function isAfter(a: TimeSpec, b: TimeSpec): boolean
{
    return a.seconds > b.seconds || (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds);
}

export function packWirePacket(ctx: MemberContext, type: TypeDefinition, value: unknown, time: TimeSpec): MessageElement[]
{
    return [
        MessageElement.nested("packettime", DataTypes.structure_t, TIMESPEC, [
            new MessageElement("seconds", DataTypes.int64_t, BigInt64Array.of(time.seconds)),
            new MessageElement("nanoseconds", DataTypes.int32_t, Int32Array.of(time.nanoseconds))
        ]),
        ctx.pack("packet", type, value)
    ];
}

export function unpackWirePacket(ctx: MemberContext, type: TypeDefinition, elements: MessageElement[]): { value: unknown; timestamp: TimeSpec }
{
    const ts = getElement(elements, "packettime").castNested(DataTypes.structure_t).elements;
    return {
        value: ctx.unpack(getElement(elements, "packet"), type),
        timestamp: {
            seconds: (getElement(ts, "seconds").data as BigInt64Array)[0]!,
            nanoseconds: (getElement(ts, "nanoseconds").data as Int32Array)[0]!
        }
    };
}

/** A value received on a wire, with the time the sender gave it */
export interface WireValue
{
    /** The value, unpacked as the wire's type */
    value: unknown;
    /** When the sender sent the value, by its own clock */
    timestamp: TimeSpec;
}

export function reportHandlerError(what: string, e: unknown): void
{
    console.error(`Error in handler for ${what}:`, e);
}

/** Resolves pending waits when a wire value or pipe packet arrives, or on timeout */
export class Waiters
{
    private waiting = new Set<() => void>();

    /** Wait until notified or the timeout expires. A negative timeout waits indefinitely */
    wait(timeout: number): Promise<void>
    {
        return new Promise<void>((resolve) =>
        {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const done = () =>
            {
                clearTimeout(timer);
                this.waiting.delete(done);
                resolve();
            };
            this.waiting.add(done);
            if (timeout >= 0) timer = setTimeout(done, timeout);
        });
    }

    notifyAll(): void
    {
        for (const w of [...this.waiting]) w();
    }
}

/** Called with the connection, the new value, and its timestamp. It may return a promise */
export type WireValueChangedHandler = (handle: WireHandle, value: unknown, timestamp: TimeSpec) => unknown;
/** Called when a wire connection ends other than by closing it */
export type WireClosedHandler = (handle: WireHandle) => unknown;

/** A streaming connection to a wire member. Use the wire functions of ServiceStub with it */
export class WireHandle
{
    /** True once the connection has closed */
    closed = false;
    /** Milliseconds a received value stays valid, or -1 for it not to expire */
    inValueLifespan = -1;
    /** Milliseconds a sent value stays valid, or -1 for it not to expire */
    outValueLifespan = -1;
    /** Ignore values from the service */
    ignoreInValue = false;
    /** Called if the connection ends other than by closing it */
    closeCallback: WireClosedHandler | null = null;
    /** Functions called with each new value */
    readonly listeners = new Set<WireValueChangedHandler>();

    private in_value: WireValue | null = null;
    private in_local = 0;
    private out_value: WireValue | null = null;
    private out_local = 0;
    private last_send: TimeSpec = { seconds: 0n, nanoseconds: 0 };
    private in_waiters = new Waiters();
    private out_waiters = new Waiters();

    /**
     * @internal Created by ServiceStub.connectWire
     *
     * @param memberName The wire member
     * @param direction Whether the wire is readonly or writeonly from this client
     */
    constructor(private ctx: MemberContext, readonly memberName: string, private type: TypeDefinition, readonly direction: MemberDirection, private on_closed: (h: WireHandle) => void) {}

    private expired(local: number, lifespan: number): boolean
    {
        return lifespan >= 0 && Date.now() - local > lifespan;
    }

    /** Whether a value has been received and has not expired */
    get inValueValid(): boolean
    {
        return this.in_value !== null && !this.expired(this.in_local, this.inValueLifespan);
    }

    /** Whether a value has been sent and has not expired */
    get outValueValid(): boolean
    {
        return this.out_value !== null && !this.expired(this.out_local, this.outValueLifespan);
    }

    private checkRead(): void
    {
        if (this.direction === "writeonly") throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only member");
    }

    private checkWrite(): void
    {
        if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only member");
    }

    /** The last value received. Throws ValueNotSet if none has been received or it has expired */
    getInValue(): WireValue
    {
        this.checkRead();
        if (!this.inValueValid) throw memberError(MessageErrorType.ValueNotSet, "ValueNotSet", "Value not set");
        return this.in_value!;
    }

    /** The last value received, or null if none has been received or it has expired */
    tryGetInValue(): WireValue | null
    {
        this.checkRead();
        return this.inValueValid ? this.in_value : null;
    }

    /** The last value sent. Throws ValueNotSet if none has been sent or it has expired */
    getOutValue(): WireValue
    {
        this.checkWrite();
        if (!this.outValueValid) throw memberError(MessageErrorType.ValueNotSet, "ValueNotSet", "Value not set");
        return this.out_value!;
    }

    /** The last value sent, or null if none has been sent or it has expired */
    tryGetOutValue(): WireValue | null
    {
        this.checkWrite();
        return this.outValueValid ? this.out_value : null;
    }

    /** Send a value. Only the latest value matters on a wire, so values are not queued behind each other */
    setOutValue(value: unknown): void
    {
        this.checkWrite();
        if (this.closed) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Wire has been closed");

        // Receivers discard packets that are not strictly newer than the last one
        let time = timeNow();
        if (!isAfter(time, this.last_send))
        {
            const n = this.last_send.nanoseconds + 1;
            time = n < 1000000000 ? { seconds: this.last_send.seconds, nanoseconds: n } : { seconds: this.last_send.seconds + 1n, nanoseconds: 0 };
        }

        const m = new MessageEntry(MessageEntryType.WirePacket, this.memberName);
        m.elements = packWirePacket(this.ctx, this.type, value, time);
        this.ctx.send(m);

        this.last_send = time;
        this.out_value = { value, timestamp: time };
        this.out_local = Date.now();
        this.out_waiters.notifyAll();
    }

    /** Wait until InValue is valid. Returns whether it is valid, as a timeout also ends the wait */
    async waitInValueValid(timeout: number): Promise<boolean>
    {
        this.checkRead();
        if (!this.inValueValid && !this.closed) await this.in_waiters.wait(timeout);
        return this.inValueValid;
    }

    /** Wait until a value has been sent, for up to timeout milliseconds or indefinitely if negative. Resolves with whether it is valid */
    async waitOutValueValid(timeout: number): Promise<boolean>
    {
        this.checkWrite();
        if (!this.outValueValid && !this.closed) await this.out_waiters.wait(timeout);
        return this.outValueValid;
    }

    /** @internal Called by the stub when a value arrives */
    packetReceived(m: MessageEntry): void
    {
        if (this.ignoreInValue || this.direction === "writeonly") return;
        const v = unpackWirePacket(this.ctx, this.type, m.elements);
        // Older packets can arrive after newer ones on some transports
        if (this.in_value && !isAfter(v.timestamp, this.in_value.timestamp)) return;

        this.in_value = v;
        this.in_local = Date.now();
        this.in_waiters.notifyAll();
        for (const h of [...this.listeners])
        {
            try
            {
                const r = h(this, v.value, v.timestamp) as { catch?: (f: (x: unknown) => void) => void } | undefined;
                r?.catch?.((e) => reportHandlerError(`wire "${this.memberName}"`, e));
            }
            catch (e)
            {
                reportHandlerError(`wire "${this.memberName}"`, e);
            }
        }
    }

    /** The connection was closed by the user. No further values are accepted */
    markClosed(): void
    {
        this.closed = true;
        this.in_waiters.notifyAll();
        this.out_waiters.notifyAll();
    }

    /** The connection ended without the user closing it */
    remoteClosed(): void
    {
        if (this.closed) return;
        this.markClosed();
        this.on_closed(this);
        try
        {
            const r = this.closeCallback?.(this) as { catch?: (f: (x: unknown) => void) => void } | undefined;
            r?.catch?.((e) => reportHandlerError(`wire "${this.memberName}" close`, e));
        }
        catch (e)
        {
            reportHandlerError(`wire "${this.memberName}" close`, e);
        }
    }

    /** Close the connection. The close callback is not called */
    async close(): Promise<void>
    {
        if (this.closed) return;
        this.markClosed();
        try
        {
            await this.ctx.request(MessageEntryType.WireDisconnectReq, this.memberName);
        }
        finally
        {
            this.on_closed(this);
        }
    }
}
