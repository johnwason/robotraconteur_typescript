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
import { getElement, MessageElement, MessageEntry } from "./Message.js";
import { TypeDefinition } from "./ServiceDefinition.js";
import { MemberContext, MemberDirection, memberError, reportHandlerError, Waiters } from "./WireMember.js";

const MAX_PACKET_NUMBER = 0xffffffff;

/** A packet from tryReceivePacketWait and similar functions, which return null instead of throwing */
export interface PipePacketValue
{
    /** The packet, unpacked as the pipe's type */
    value: unknown;
}

/** Called when packets arrive. The handler receives them from the endpoint itself */
export type PipePacketHandler = (handle: PipeHandle) => unknown;
/** Called with the number of a packet the peer has acknowledged */
export type PipeAckHandler = (handle: PipeHandle, packetNumber: number) => unknown;
/** Called when a pipe endpoint ends other than by closing it */
export type PipeClosedHandler = (handle: PipeHandle) => unknown;

interface ReceivedPacket
{
    value: unknown;
    /** Set if the sender asked for an acknowledgement */
    ack?: number;
}

function nextPacketNumber(n: number): number
{
    return n < MAX_PACKET_NUMBER ? n + 1 : 0;
}

function callHandler(what: string, f: () => unknown): void
{
    try
    {
        const r = f() as { catch?: (g: (x: unknown) => void) => void } | undefined;
        r?.catch?.((e) => reportHandlerError(what, e));
    }
    catch (e)
    {
        reportHandlerError(what, e);
    }
}

/** A connected pipe endpoint. Use the pipe functions of ServiceStub with it */
export class PipeHandle
{
    /** True once the endpoint has closed */
    closed = false;
    /** Ask the peer to acknowledge each packet this endpoint sends */
    requestPacketAck = false;
    /** Drop packets from the service */
    ignoreInValue = false;
    /** The endpoint closes rather than losing packets if more than this many are waiting. Zero for no limit */
    maxReceiveQueue = 65536;
    /** Called if the endpoint ends other than by closing it */
    closeCallback: PipeClosedHandler | null = null;
    /** Functions called when packets arrive */
    readonly packetListeners = new Set<PipePacketHandler>();
    /** Functions called with acknowledged packet numbers */
    readonly ackListeners = new Set<PipeAckHandler>();

    private send_number = 0;
    private recv_number = 0;
    private queue: ReceivedPacket[] = [];
    private out_of_order = new Map<number, ReceivedPacket>();
    private waiters = new Waiters();
    private close_reason = "Receive queue empty";

    /**
     * @internal Created by ServiceStub.connectPipe
     *
     * @param memberName The pipe member
     * @param index The index of the endpoint
     * @param direction Whether the pipe is readonly or writeonly from this client
     * @param unreliable Whether packets may be lost or arrive out of order
     */
    constructor(private ctx: MemberContext, readonly memberName: string, readonly index: number, private type: TypeDefinition, readonly direction: MemberDirection, public unreliable: boolean, private on_closed: (h: PipeHandle) => void) {}

    /** The number of packets waiting to be received */
    get available(): number
    {
        return this.queue.length;
    }

    private checkRead(): void
    {
        if (this.direction === "writeonly") throw memberError(MessageErrorType.WriteOnlyMember, "WriteOnlyMember", "Write only pipe");
    }

    /** Resolves once the packet has been handed to the network, so awaiting it applies backpressure */
    async sendPacket(value: unknown): Promise<number>
    {
        if (this.direction === "readonly") throw memberError(MessageErrorType.ReadOnlyMember, "ReadOnlyMember", "Read only pipe");
        if (this.closed) throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", "Pipe endpoint has been closed");

        const packet = this.ctx.pack("packet", this.type, value);
        this.send_number = nextPacketNumber(this.send_number);
        const number = this.send_number;

        const elements = [new MessageElement("packetnumber", DataTypes.uint32_t, Uint32Array.of(number)), packet];
        if (this.requestPacketAck) elements.push(new MessageElement("requestack", DataTypes.uint32_t, Uint32Array.of(1)));

        const m = new MessageEntry(MessageEntryType.PipePacket, this.memberName);
        if (this.unreliable) m.metaData = "unreliable\n";
        m.addElement(MessageElement.nested(String(this.index), DataTypes.dictionary_t, "", elements));
        await this.ctx.sendWait(m);
        return number;
    }

    /**
     * Acknowledgements are sent when the application takes a packet rather than when it arrives,
     * so that a sender using them for flow control slows down to what the application consumes.
     */
    private acknowledge(p: ReceivedPacket): void
    {
        if (p.ack === undefined || this.closed) return;
        const m = new MessageEntry(MessageEntryType.PipePacketRet, this.memberName);
        if (this.unreliable) m.metaData = "unreliable\n";
        m.addElement(new MessageElement(String(this.index), DataTypes.uint32_t, Uint32Array.of(p.ack)));
        try
        {
            this.ctx.send(m);
        }
        catch
        {
            // The connection has closed
        }
    }

    private queueEmpty(): never
    {
        throw memberError(MessageErrorType.InvalidOperation, "InvalidOperation", this.close_reason);
    }

    private take(): unknown
    {
        const p = this.queue.shift()!;
        this.acknowledge(p);
        return p.value;
    }

    /** Take the next packet. Throws InvalidOperation if none are waiting */
    receivePacket(): unknown
    {
        this.checkRead();
        if (this.queue.length === 0) this.queueEmpty();
        return this.take();
    }

    /** Read the next packet without removing it. Throws InvalidOperation if none are waiting */
    peekPacket(): unknown
    {
        this.checkRead();
        if (this.queue.length === 0) this.queueEmpty();
        return this.queue[0]!.value;
    }

    /** Returns null if no packet became available within the timeout */
    async tryReceivePacketWait(timeout: number, peek: boolean): Promise<PipePacketValue | null>
    {
        this.checkRead();
        if (this.queue.length === 0 && !this.closed && timeout !== 0) await this.waiters.wait(timeout);
        if (this.queue.length === 0) return null;
        return { value: peek ? this.queue[0]!.value : this.take() };
    }

    /** Wait up to timeout milliseconds for a packet, or indefinitely if negative, then take it, or read it if peek is set. Throws if none arrives */
    async receivePacketWait(timeout: number, peek: boolean): Promise<unknown>
    {
        const r = await this.tryReceivePacketWait(timeout, peek);
        if (!r) this.queueEmpty();
        return r!.value;
    }

    private deliver(p: ReceivedPacket): void
    {
        this.queue.push(p);
        if (this.maxReceiveQueue > 0 && this.queue.length > this.maxReceiveQueue)
        {
            this.close_reason = "Pipe endpoint closed because its receive queue overflowed";
            console.error(`Pipe "${this.memberName}" index ${this.index}: ${this.close_reason}`);
            this.close().catch(() => undefined);
            this.fireClosed();
        }
    }

    /** @internal Called by the stub when a packet arrives */
    packetReceived(element: MessageElement): void
    {
        if (this.direction === "writeonly") return;
        const elements = element.castNested().elements;
        const number = (getElement(elements, "packetnumber").data as Uint32Array)[0]!;
        const value = this.ctx.unpack(getElement(elements, "packet"), this.type);
        const p: ReceivedPacket = { value };
        if (elements.some((x) => x.elementName === "requestack")) p.ack = number;

        if (this.ignoreInValue)
        {
            this.acknowledge(p);
            return;
        }

        if (this.unreliable)
        {
            this.deliver(p);
        }
        else if (number === nextPacketNumber(this.recv_number))
        {
            this.recv_number = number;
            this.deliver(p);
            for (;;)
            {
                const next = nextPacketNumber(this.recv_number);
                const held = this.out_of_order.get(next);
                if (!held) break;
                this.out_of_order.delete(next);
                this.recv_number = next;
                this.deliver(held);
            }
        }
        else
        {
            this.out_of_order.set(number, p);
            return;
        }

        this.waiters.notifyAll();
        for (const h of [...this.packetListeners]) callHandler(`pipe "${this.memberName}"`, () => h(this));
    }

    /** @internal Called by the stub when the peer acknowledges a packet */
    ackReceived(number: number): void
    {
        for (const h of [...this.ackListeners]) callHandler(`pipe "${this.memberName}" acknowledgement`, () => h(this, number));
    }

    private fireClosed(): void
    {
        this.on_closed(this);
        callHandler(`pipe "${this.memberName}" close`, () => this.closeCallback?.(this));
    }

    /** The endpoint ended without the user closing it. Packets already received can still be read */
    remoteClosed(): void
    {
        if (this.closed) return;
        this.closed = true;
        this.waiters.notifyAll();
        this.fireClosed();
    }

    /** Close the endpoint. The close callback is not called */
    async close(): Promise<void>
    {
        if (this.closed) return;
        this.closed = true;
        this.waiters.notifyAll();
        try
        {
            await this.ctx.request(MessageEntryType.PipeDisconnectReq, this.memberName, [new MessageElement("index", DataTypes.int32_t, Int32Array.of(this.index))]);
        }
        finally
        {
            this.on_closed(this);
        }
    }
}
