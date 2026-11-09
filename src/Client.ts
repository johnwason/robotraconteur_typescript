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
import { findElement, getElement, Message, MessageElement, MessageEntry } from "./Message.js";
import { NodeID } from "./NodeID.js";
import { RobotRaconteurNode } from "./Node.js";
import { packElement, TypeContext, unpackElement, VarValue } from "./Pack.js";
import { EntryDefinition, MemberDefinition, MemberKind, parseServiceDefinition, ServiceDefinition, TypeDefinition } from "./ServiceDefinition.js";
import { ITransportConnection, parseConnectionUrl, Transport } from "./Transport.js";
import { PipeAckHandler, PipeClosedHandler, PipeHandle, PipePacketHandler } from "./PipeMember.js";
import { MemberContext, MemberDirection, memberDirection, packWirePacket, timeNow, unpackWirePacket, WireClosedHandler, WireHandle, WireValue, WireValueChangedHandler } from "./WireMember.js";

const VARVALUE_MAP: TypeDefinition = { type: "varvalue", container: "map_string" };
const VARVALUE: TypeDefinition = { type: "varvalue" };

interface PendingRequest
{
    resolve: (m: MessageEntry) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export type EventHandler = (...args: any[]) => unknown;
export type CallbackHandler = (...args: any[]) => unknown;

/**
 * Handle for a generator returned by callFunction or callGenerator. It can be used with for await
 * if the generator does not take a value at each step. Leaving the loop early closes the generator.
 */
export class GeneratorHandle<T = unknown> implements AsyncIterable<T, void, unknown>
{
    constructor(readonly memberName: string, readonly index: number, readonly returnType: TypeDefinition | undefined, readonly paramType: TypeDefinition | undefined, private stub?: ServiceStub) {}

    [Symbol.asyncIterator](): AsyncIterator<T, void, unknown>
    {
        const stub = this.stub!;
        let done = false;
        return {
            next: async (param?: unknown): Promise<IteratorResult<T, void>> =>
            {
                if (done) return { done: true, value: undefined };
                try
                {
                    return { done: false, value: await stub.callFunctionGenNext(this, param) as T };
                }
                catch (e)
                {
                    done = true;
                    if (e instanceof RobotRaconteurError && e.isStopIteration) return { done: true, value: undefined };
                    throw e;
                }
            },
            return: async (): Promise<IteratorResult<T, void>> =>
            {
                if (!done)
                {
                    done = true;
                    await stub.callFunctionGenClose(this);
                }
                return { done: true, value: undefined };
            }
        };
    }
}

function error(code: MessageErrorType, name: string, message: string): RobotRaconteurError
{
    return new RobotRaconteurError(code, "RobotRaconteur." + name, message);
}

/** Encode an objref index for use in a service path. Only ASCII letters and digits are left unescaped */
export function encodeServicePathIndex(index: string): string
{
    let out = "";
    for (const b of new TextEncoder().encode(index))
    {
        const c = String.fromCharCode(b);
        out += /[a-zA-Z0-9]/.test(c) ? c : "%" + b.toString(16).padStart(2, "0");
    }
    return out;
}

function isGeneratorType(t: TypeDefinition | undefined): boolean
{
    return t?.container === "generator";
}

function itemType(t: TypeDefinition | undefined): TypeDefinition | undefined
{
    if (!t || t.type === "void") return undefined;
    const { container: _, ...rest } = t;
    return rest;
}

/** Client for one object in a service. Members are accessed by name */
export class ServiceStub
{
    /** Set when the service has released this object. Requests through a released stub fail */
    released = false;

    private event_listeners = new Map<string, Set<EventHandler>>();
    private callbacks = new Map<string, CallbackHandler>();
    private wires = new Map<string, WireHandle>();
    private pipes = new Map<string, Map<number, PipeHandle>>();
    private early_pipes = new Map<string, PipeHandle>();
    private connecting_pipes: { name: string; index: number }[] = [];
    private member_context: MemberContext = {
        servicePath: this.servicePath,
        pack: (name, t, v) => this.pack(name, t, v),
        unpack: (e, t) => this.unpack(e, t),
        request: (type, name, elements) => this.request(type, name, elements),
        send: (e) =>
        {
            e.servicePath = this.servicePath;
            this.context.sendEntry(e);
        },
        sendWait: (e) =>
        {
            e.servicePath = this.servicePath;
            return this.context.sendEntryWait(e);
        }
    };

    constructor(readonly context: ClientContext, readonly servicePath: string, readonly objectType: string) {}

    private member(name: string, kind: MemberKind): MemberDefinition
    {
        const m = this.context.findMember(this.objectType, name);
        if (!m || m.kind !== kind) throw error(MessageErrorType.MemberNotFound, "MemberNotFound", `Could not find ${kind} member "${name}" in ${this.objectType}`);
        return m;
    }

    private scope(): ServiceDefinition
    {
        return this.context.serviceDefForType(this.objectType);
    }

    private pack(name: string, t: TypeDefinition, v: unknown): MessageElement
    {
        return packElement(name, t, v, this.scope(), this.context.types);
    }

    private unpack(e: MessageElement, t: TypeDefinition): unknown
    {
        return unpackElement(e, t, this.scope(), this.context.types);
    }

    private request(type: MessageEntryType, name: string, elements: MessageElement[] = [], err = MessageErrorType.None): Promise<MessageEntry>
    {
        if (this.released) throw error(MessageErrorType.ServiceError, "ServiceError", "Reference has been released");
        const m = new MessageEntry(type, name);
        m.servicePath = this.servicePath;
        m.elements = elements;
        m.error = err;
        return this.context.processRequest(m);
    }

    async getProperty(name: string): Promise<unknown>
    {
        const m = this.member(name, "property");
        const ret = await this.request(MessageEntryType.PropertyGetReq, name);
        return this.unpack(getElement(ret.elements, "value"), m.type!);
    }

    async setProperty(name: string, value: unknown): Promise<void>
    {
        const m = this.member(name, "property");
        await this.request(MessageEntryType.PropertySetReq, name, [this.pack("value", m.type!, value)]);
    }

    /**
     * Call a function member. Parameters may be an array in declaration order or an object keyed
     * by parameter name. Generator functions return a GeneratorHandle.
     */
    async callFunction(name: string, params?: unknown[] | Record<string, unknown>): Promise<unknown>
    {
        const m = this.member(name, "function");
        const all = m.parameters!;
        const last = all[all.length - 1];
        const is_gen = isGeneratorType(m.type) || isGeneratorType(last?.type);
        const decl = isGeneratorType(last?.type) ? all.slice(0, -1) : all;

        let values: unknown[];
        if (Array.isArray(params))
        {
            values = params;
        }
        else
        {
            const p = params ?? {};
            for (const d of decl)
            {
                if (!(d.name in p)) throw error(MessageErrorType.DataTypeError, "DataTypeError", `Missing parameter "${d.name}" for function "${name}"`);
            }
            values = decl.map((d) => p[d.name]);
        }
        if (values.length !== decl.length) throw error(MessageErrorType.DataTypeError, "DataTypeError", `Function "${name}" expects ${decl.length} parameters`);

        const ret = await this.request(MessageEntryType.FunctionCallReq, name, decl.map((d, i) => this.pack(d.name, d.type, values[i])));

        if (is_gen)
        {
            const index = (getElement(ret.elements, "index").data as Int32Array)[0]!;
            return new GeneratorHandle(name, index, itemType(m.type), isGeneratorType(last?.type) ? itemType(last!.type) : undefined, this);
        }
        if (m.type!.type === "void") return undefined;
        return this.unpack(getElement(ret.elements, "return"), m.type!);
    }

    /** Call a generator function. T is the type of the values it produces */
    async callGenerator<T = unknown>(name: string, params?: unknown[] | Record<string, unknown>): Promise<GeneratorHandle<T>>
    {
        const m = this.member(name, "function");
        if (!isGeneratorType(m.type) && !isGeneratorType(m.parameters![m.parameters!.length - 1]?.type))
        {
            throw error(MessageErrorType.InvalidOperation, "InvalidOperation", `Function "${name}" is not a generator`);
        }
        return await this.callFunction(name, params) as GeneratorHandle<T>;
    }

    private generatorRequest(handle: GeneratorHandle, err: MessageErrorType, error_name: string): Promise<MessageEntry>
    {
        return this.request(MessageEntryType.GeneratorNextReq, handle.memberName, [
            MessageElement.string("errorname", "RobotRaconteur." + error_name),
            MessageElement.string("errorstring", "Generator " + error_name),
            new MessageElement("index", DataTypes.int32_t, Int32Array.of(handle.index))
        ], err);
    }

    /** Advance a generator. Throws a RobotRaconteurError with isStopIteration set at the end */
    async callFunctionGenNext(handle: GeneratorHandle, param?: unknown): Promise<unknown>
    {
        const elements = [new MessageElement("index", DataTypes.int32_t, Int32Array.of(handle.index))];
        if (handle.paramType) elements.push(this.pack("parameter", handle.paramType, param));
        const ret = await this.request(MessageEntryType.GeneratorNextReq, handle.memberName, elements);
        if (!handle.returnType) return undefined;
        return this.unpack(getElement(ret.elements, "return"), handle.returnType);
    }

    async callFunctionGenClose(handle: GeneratorHandle): Promise<void>
    {
        await this.generatorRequest(handle, MessageErrorType.StopIteration, "StopIteration");
    }

    async callFunctionGenAbort(handle: GeneratorHandle): Promise<void>
    {
        await this.generatorRequest(handle, MessageErrorType.AbortOperation, "AbortOperation");
    }

    /** Get a client for an object reference member, with an index for array and map objrefs */
    async getObjRef(name: string, index?: number | string): Promise<ServiceStub>
    {
        this.member(name, "objref");
        const path = this.servicePath + "." + name + (index === undefined ? "" : `[${encodeServicePathIndex(String(index))}]`);
        return this.context.findObjRef(path);
    }

    /**
     * Listen for an event. The handler receives the event parameters as arguments. Handlers run
     * as messages arrive, so long running work should be moved out of the handler.
     */
    addEventListener(name: string, handler: EventHandler): void
    {
        this.member(name, "event");
        let listeners = this.event_listeners.get(name);
        if (!listeners)
        {
            listeners = new Set();
            this.event_listeners.set(name, listeners);
        }
        listeners.add(handler);
    }

    removeEventListener(name: string, handler: EventHandler): void
    {
        this.member(name, "event");
        this.event_listeners.get(name)?.delete(handler);
    }

    /**
     * Provide the function that the service calls for a callback member. The handler receives the
     * callback parameters as arguments and may return a value or a promise. Pass null to clear it.
     */
    setCallback(name: string, handler: CallbackHandler | null): void
    {
        this.member(name, "callback");
        if (handler) this.callbacks.set(name, handler);
        else this.callbacks.delete(name);
    }

    private unpackParameters(m: MemberDefinition, e: MessageEntry): unknown[]
    {
        return m.parameters!.map((p) => this.unpack(getElement(e.elements, p.name), p.type));
    }

    /** Errors in a handler must not affect the connection or the other handlers */
    private reportHandlerError(name: string, e: unknown): void
    {
        console.error(`Error in handler for event "${name}" of ${this.servicePath}:`, e);
    }

    dispatchEvent(e: MessageEntry): void
    {
        const listeners = this.event_listeners.get(e.memberName);
        if (!listeners || listeners.size === 0) return;
        const m = this.context.findMember(this.objectType, e.memberName);
        if (!m || m.kind !== "event") return;

        let args: unknown[];
        try
        {
            args = this.unpackParameters(m, e);
        }
        catch (err)
        {
            this.reportHandlerError(e.memberName, err);
            return;
        }

        for (const handler of [...listeners])
        {
            try
            {
                const result = handler(...args) as { catch?: (f: (x: unknown) => void) => void } | undefined;
                result?.catch?.((err) => this.reportHandlerError(e.memberName, err));
            }
            catch (err)
            {
                this.reportHandlerError(e.memberName, err);
            }
        }
    }

    /** Run a callback requested by the service and return the response */
    async callbackCall(e: MessageEntry): Promise<MessageEntry>
    {
        const r = new MessageEntry(MessageEntryType.CallbackCallRet, e.memberName);
        r.servicePath = e.servicePath;
        r.requestID = e.requestID;
        try
        {
            const m = this.member(e.memberName, "callback");
            const handler = this.callbacks.get(e.memberName);
            if (!handler) throw error(MessageErrorType.InvalidOperation, "InvalidOperation", `Callback "${e.memberName}" has not been set`);

            const ret = await handler(...this.unpackParameters(m, e));
            // Services expect a return element even from void callbacks
            r.addElement(m.type!.type === "void" ? new MessageElement("return", DataTypes.int32_t, Int32Array.of(0)) : this.pack("return", m.type!, ret));
        }
        catch (err)
        {
            r.elements = [];
            this.context.errorToEntry(err, r);
        }
        return r;
    }

    private async peek(type: MessageEntryType, name: string): Promise<WireValue>
    {
        const m = this.member(name, "wire");
        const ret = await this.request(type, name);
        return unpackWirePacket(this.member_context, m.type!, ret.elements);
    }

    peekWireInValue(name: string): Promise<WireValue>
    {
        return this.peek(MessageEntryType.WirePeekInValueReq, name);
    }

    peekWireOutValue(name: string): Promise<WireValue>
    {
        return this.peek(MessageEntryType.WirePeekOutValueReq, name);
    }

    async pokeWireOutValue(name: string, value: unknown): Promise<void>
    {
        const m = this.member(name, "wire");
        await this.request(MessageEntryType.WirePokeOutValueReq, name, packWirePacket(this.member_context, m.type!, value, timeNow()));
    }

    getWireDirection(name: string): MemberDirection
    {
        return memberDirection(this.member(name, "wire"));
    }

    /** Create a streaming connection to a wire. Only one connection per wire is allowed */
    async connectWire(name: string): Promise<WireHandle>
    {
        const m = this.member(name, "wire");
        if (this.wires.has(name)) throw error(MessageErrorType.InvalidOperation, "InvalidOperation", `Wire "${name}" is already connected`);

        // The handle exists before the request because packets can arrive ahead of the response
        const h = new WireHandle(this.member_context, name, m.type!, memberDirection(m), (x) =>
        {
            if (this.wires.get(name) === x) this.wires.delete(name);
        });
        this.wires.set(name, h);
        try
        {
            await this.request(MessageEntryType.WireConnectReq, name);
        }
        catch (e)
        {
            this.wires.delete(name);
            throw e;
        }
        return h;
    }

    closeWire(handle: WireHandle): Promise<void>
    {
        return handle.close();
    }

    /** Send a new value. Values waiting to be sent are replaced by newer ones */
    setWireOutValue(handle: WireHandle, value: unknown): void
    {
        handle.setOutValue(value);
    }

    /** The most recent received value and its timestamp. Throws if no valid value has been received */
    getWireInValue(handle: WireHandle): WireValue
    {
        return handle.getInValue();
    }

    /** The most recent received value and its timestamp, or null if there is no valid value */
    tryGetWireInValue(handle: WireHandle): WireValue | null
    {
        return handle.tryGetInValue();
    }

    getWireOutValue(handle: WireHandle): WireValue
    {
        return handle.getOutValue();
    }

    tryGetWireOutValue(handle: WireHandle): WireValue | null
    {
        return handle.tryGetOutValue();
    }

    isWireInValueValid(handle: WireHandle): boolean
    {
        return handle.inValueValid;
    }

    isWireOutValueValid(handle: WireHandle): boolean
    {
        return handle.outValueValid;
    }

    /** Wait up to timeout milliseconds, or indefinitely if negative. Returns whether the value is valid */
    waitWireInValueValid(handle: WireHandle, timeout = -1): Promise<boolean>
    {
        return handle.waitInValueValid(timeout);
    }

    waitWireOutValueValid(handle: WireHandle, timeout = -1): Promise<boolean>
    {
        return handle.waitOutValueValid(timeout);
    }

    /** Received values become invalid after this many milliseconds. Negative for no limit */
    setWireInValueLifespan(handle: WireHandle, milliseconds: number): void
    {
        handle.inValueLifespan = milliseconds;
    }

    getWireInValueLifespan(handle: WireHandle): number
    {
        return handle.inValueLifespan;
    }

    setWireOutValueLifespan(handle: WireHandle, milliseconds: number): void
    {
        handle.outValueLifespan = milliseconds;
    }

    getWireOutValueLifespan(handle: WireHandle): number
    {
        return handle.outValueLifespan;
    }

    setWireIgnoreInValue(handle: WireHandle, ignore: boolean): void
    {
        handle.ignoreInValue = ignore;
    }

    getWireIgnoreInValue(handle: WireHandle): boolean
    {
        return handle.ignoreInValue;
    }

    addWireValueChangedListener(handle: WireHandle, listener: WireValueChangedHandler): void
    {
        handle.listeners.add(listener);
    }

    removeWireValueChangedListener(handle: WireHandle, listener: WireValueChangedHandler): void
    {
        handle.listeners.delete(listener);
    }

    /** Called if the connection ends other than through closeWire */
    setWireCloseCallback(handle: WireHandle, callback: WireClosedHandler | null): void
    {
        handle.closeCallback = callback;
    }

    getPipeDirection(name: string): MemberDirection
    {
        return memberDirection(this.member(name, "pipe"));
    }

    isPipeUnreliable(name: string): boolean
    {
        return this.member(name, "pipe").modifiers?.includes("unreliable") ?? false;
    }

    private pipeClosed(h: PipeHandle): void
    {
        const endpoints = this.pipes.get(h.memberName);
        if (endpoints?.get(h.index) === h) endpoints.delete(h.index);
    }

    private createPipeHandle(m: MemberDefinition, index: number, unreliable: boolean): PipeHandle
    {
        return new PipeHandle(this.member_context, m.name, index, m.type!, memberDirection(m), unreliable, (h) => this.pipeClosed(h));
    }

    /** Connect a pipe endpoint. The default index of -1 lets the service choose one */
    async connectPipe(name: string, index = -1): Promise<PipeHandle>
    {
        const m = this.member(name, "pipe");
        const unreliable = this.isPipeUnreliable(name);
        const elements = [new MessageElement("index", DataTypes.int32_t, Int32Array.of(index))];
        if (unreliable) elements.push(new MessageElement("unreliable", DataTypes.int32_t, Int32Array.of(1)));

        const connecting = { name, index };
        this.connecting_pipes.push(connecting);
        try
        {
            const ret = await this.request(MessageEntryType.PipeConnectReq, name, elements);
            const rindex = (getElement(ret.elements, "index").data as Int32Array)[0]!;
            const ret_unreliable = (findElement(ret.elements, "unreliable")?.data as Int32Array | undefined)?.[0] === 1;

            // Packets can arrive ahead of the response, in which case the endpoint already exists
            const key = name + "\0" + rindex;
            const h = this.early_pipes.get(key) ?? this.createPipeHandle(m, rindex, ret_unreliable);
            this.early_pipes.delete(key);
            h.unreliable = ret_unreliable;

            let endpoints = this.pipes.get(name);
            if (!endpoints)
            {
                endpoints = new Map();
                this.pipes.set(name, endpoints);
            }
            endpoints.set(rindex, h);
            return h;
        }
        finally
        {
            this.connecting_pipes.splice(this.connecting_pipes.indexOf(connecting), 1);
            if (this.connecting_pipes.length === 0) this.early_pipes.clear();
        }
    }

    closePipe(handle: PipeHandle): Promise<void>
    {
        return handle.close();
    }

    /** Resolves with the packet number once sent. Await it to avoid outrunning the connection */
    sendPipePacket(handle: PipeHandle, value: unknown): Promise<number>
    {
        return handle.sendPacket(value);
    }

    /** Take the next packet. Throws if none are waiting */
    receivePipePacket(handle: PipeHandle): unknown
    {
        return handle.receivePacket();
    }

    /** Wait up to timeout milliseconds for a packet, or indefinitely if negative */
    receivePipePacketWait(handle: PipeHandle, timeout = -1): Promise<unknown>
    {
        return handle.receivePacketWait(timeout, false);
    }

    /** Read the next packet without removing it. Throws if none are waiting */
    peekPipePacket(handle: PipeHandle): unknown
    {
        return handle.peekPacket();
    }

    peekPipePacketWait(handle: PipeHandle, timeout = -1): Promise<unknown>
    {
        return handle.receivePacketWait(timeout, true);
    }

    /** Resolves with `{ value }`, or null instead of throwing if no packet arrives in time */
    tryReceivePipePacketWait(handle: PipeHandle, timeout = -1, peek = false): Promise<{ value: unknown } | null>
    {
        return handle.tryReceivePacketWait(timeout, peek);
    }

    getPipePacketsAvailable(handle: PipeHandle): number
    {
        return handle.available;
    }

    getPipeIndex(handle: PipeHandle): number
    {
        return handle.index;
    }

    /** Ask the peer to acknowledge each packet this endpoint sends */
    setPipeRequestPacketAck(handle: PipeHandle, request: boolean): void
    {
        handle.requestPacketAck = request;
    }

    getPipeRequestPacketAck(handle: PipeHandle): boolean
    {
        return handle.requestPacketAck;
    }

    setPipeIgnoreInValue(handle: PipeHandle, ignore: boolean): void
    {
        handle.ignoreInValue = ignore;
    }

    getPipeIgnoreInValue(handle: PipeHandle): boolean
    {
        return handle.ignoreInValue;
    }

    /** The endpoint closes if more packets than this are waiting. Zero for no limit */
    setPipeMaxReceiveQueue(handle: PipeHandle, packets: number): void
    {
        handle.maxReceiveQueue = packets;
    }

    getPipeMaxReceiveQueue(handle: PipeHandle): number
    {
        return handle.maxReceiveQueue;
    }

    addPipePacketReceivedListener(handle: PipeHandle, listener: PipePacketHandler): void
    {
        handle.packetListeners.add(listener);
    }

    removePipePacketReceivedListener(handle: PipeHandle, listener: PipePacketHandler): void
    {
        handle.packetListeners.delete(listener);
    }

    addPipePacketAckListener(handle: PipeHandle, listener: PipeAckHandler): void
    {
        handle.ackListeners.add(listener);
    }

    removePipePacketAckListener(handle: PipeHandle, listener: PipeAckHandler): void
    {
        handle.ackListeners.delete(listener);
    }

    /** Called if the endpoint ends other than through closePipe */
    setPipeCloseCallback(handle: PipeHandle, callback: PipeClosedHandler | null): void
    {
        handle.closeCallback = callback;
    }

    dispatchWire(e: MessageEntry): void
    {
        const h = this.wires.get(e.memberName);
        if (!h) return;
        if (e.entryType === MessageEntryType.WireClosed)
        {
            h.remoteClosed();
            return;
        }
        try
        {
            h.packetReceived(e);
        }
        catch (err)
        {
            console.error(`Error receiving packet for wire "${e.memberName}":`, err);
        }
    }

    private findPipe(name: string, index: number): PipeHandle | undefined
    {
        return this.pipes.get(name)?.get(index);
    }

    private findOrCreateEarlyPipe(name: string, index: number): PipeHandle | undefined
    {
        const found = this.findPipe(name, index);
        if (found) return found;
        const key = name + "\0" + index;
        const early = this.early_pipes.get(key);
        if (early) return early;
        if (!this.connecting_pipes.some((x) => x.name === name && (x.index === -1 || x.index === index))) return undefined;
        const m = this.context.findMember(this.objectType, name);
        if (!m || m.kind !== "pipe") return undefined;
        const h = this.createPipeHandle(m, index, this.isPipeUnreliable(name));
        this.early_pipes.set(key, h);
        return h;
    }

    dispatchPipe(e: MessageEntry): void
    {
        try
        {
            if (e.entryType === MessageEntryType.PipeClosed)
            {
                this.findPipe(e.memberName, (getElement(e.elements, "index").data as Int32Array)[0]!)?.remoteClosed();
            }
            else if (e.entryType === MessageEntryType.PipePacket)
            {
                for (const el of e.elements) this.findOrCreateEarlyPipe(e.memberName, Number(el.elementName))?.packetReceived(el);
            }
            else
            {
                for (const el of e.elements) this.findPipe(e.memberName, Number(el.elementName))?.ackReceived((el.data as Uint32Array)[0]!);
            }
        }
        catch (err)
        {
            console.error(`Error receiving packet for pipe "${e.memberName}":`, err);
        }
    }

    /** The object or connection is gone, so close everything streaming through it */
    closeMembers(): void
    {
        for (const h of [...this.wires.values()]) h.remoteClosed();
        for (const endpoints of [...this.pipes.values()])
        {
            for (const h of [...endpoints.values()]) h.remoteClosed();
        }
    }
}

/** Client side of a connection to one service */
export class ClientContext
{
    localEndpoint = 0;
    remoteEndpoint = 0;
    remoteNodeID = NodeID.Any;
    remoteNodeName = "";
    serviceName = "";
    connected = false;
    /** Attributes reported by the service */
    attributes = new Map<string, unknown>();
    readonly types: TypeContext;

    private transport: ITransportConnection | null = null;
    private stubs = new Map<string, ServiceStub>();
    private pending = new Map<number, PendingRequest>();
    private request_number = 0;
    private message_number = 0;
    private members = new Map<string, Map<string, MemberDefinition>>();
    private cleanup_timer: ReturnType<typeof setInterval> | undefined;
    private last_sent = Date.now();
    private last_received = Date.now();
    private closing = false;
    private close_listeners = new Set<() => void>();

    constructor(readonly node: RobotRaconteurNode)
    {
        this.types = new TypeContext(new Map(node.serviceTypes));
    }

    async connectService(transport: Transport, url: string, username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, object_type?: string): Promise<ServiceStub>
    {
        const u = parseConnectionUrl(url);
        this.remoteNodeID = u.nodeid;
        this.remoteNodeName = u.nodename;
        this.serviceName = u.service;

        this.transport = await transport.createTransportConnection(url, this);
        this.connected = true;

        try
        {
            let type: string;
            if (this.transport.useCombinedConnection)
            {
                type = await this.connectCombined(username, credentials, object_type);
            }
            else
            {
                type = await this.connectSeparate(username, credentials, object_type);
            }

            const stub = new ServiceStub(this, this.serviceName, type);
            this.stubs.set(this.serviceName, stub);
            this.cleanup_timer = setInterval(() => this.periodicCleanup(), 5000);
            (this.cleanup_timer as unknown as { unref?: () => void }).unref?.();
            return stub;
        }
        catch (e)
        {
            this.shutdownConnection();
            throw e;
        }
    }

    private newEntry(type: MessageEntryType, member = ""): MessageEntry
    {
        const e = new MessageEntry(type, member);
        e.servicePath = this.serviceName;
        return e;
    }

    private packCredentials(credentials: Map<string, unknown> | Record<string, unknown>, name: string): MessageElement
    {
        // Credentials contain only varvalue entries, so no service definition is needed
        const scope = { name: "" } as ServiceDefinition;
        return packElement(name, VARVALUE_MAP, credentials, scope, this.types);
    }

    private async connectCombined(username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, object_type?: string): Promise<string>
    {
        const e = this.newEntry(MessageEntryType.ConnectClientCombined);
        e.addElement(MessageElement.string("clientversion", RobotRaconteurNode.Version));
        e.addElement(MessageElement.string("returnservicedefs", "true"));
        if (username) e.addElement(MessageElement.string("username", username));
        if (credentials) e.addElement(this.packCredentials(credentials, "credentials"));

        const ret = await this.processRequest(e);
        for (const d of getElement(ret.elements, "servicedefs").castNested(DataTypes.list_t).elements)
        {
            this.addServiceDefinition(parseServiceDefinition(d.castString()));
        }

        let type = getElement(ret.elements, "objecttype").castString();
        if (type === "") throw error(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Could not find object type");

        if (object_type && object_type !== type)
        {
            const implemented = findElement(ret.elements, "objectimplements")?.castNested(DataTypes.list_t).elements.map((x) => x.castString()) ?? [];
            if (!implemented.includes(object_type)) this.verifyObjectImplements(type, object_type);
            type = object_type;
        }

        this.readAttributes(ret);
        return type;
    }

    private async connectSeparate(username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, object_type?: string): Promise<string>
    {
        await this.pullServiceDefinitionAndImports(undefined);

        const e = this.newEntry(MessageEntryType.ObjectTypeName);
        e.addElement(MessageElement.string("clientversion", RobotRaconteurNode.Version));
        const ret = await this.processRequest(e);
        let type = getElement(ret.elements, "objecttype").castString();
        if (type === "") throw error(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Could not find object type");

        if (object_type)
        {
            this.verifyObjectImplements(type, object_type);
            type = object_type;
        }

        const connect = this.newEntry(MessageEntryType.ConnectClient, "registerclient");
        await this.processRequest(connect);

        if (username)
        {
            const auth = this.newEntry(MessageEntryType.ClientSessionOpReq, "AuthenticateUser");
            auth.addElement(MessageElement.string("username", username));
            if (credentials) auth.addElement(this.packCredentials(credentials, "credentials"));
            await this.processRequest(auth);
        }
        return type;
    }

    private readAttributes(ret: MessageEntry): void
    {
        const a = findElement(ret.elements, "attributes");
        if (a)
        {
            this.attributes = unpackElement(a, VARVALUE_MAP, { name: "" } as ServiceDefinition, this.types) as Map<string, unknown>;
        }
    }

    private addServiceDefinition(d: ServiceDefinition): void
    {
        this.types.defs.set(d.name, d);
    }

    private async pullServiceDefinition(service_type: string | undefined): Promise<ServiceDefinition>
    {
        const e = this.newEntry(MessageEntryType.GetServiceDesc);
        if (service_type !== undefined) e.addElement(MessageElement.string("ServiceType", service_type));
        e.addElement(MessageElement.string("clientversion", RobotRaconteurNode.Version));
        const ret = await this.processRequest(e);
        const d = parseServiceDefinition(getElement(ret.elements, "servicedef").castString());
        if (service_type === undefined) this.readAttributes(ret);
        return d;
    }

    private async pullServiceDefinitionAndImports(service_type: string | undefined, seen = new Set<string>()): Promise<void>
    {
        const d = await this.pullServiceDefinition(service_type);
        this.addServiceDefinition(d);
        seen.add(d.name);
        for (const i of d.imports)
        {
            if (!seen.has(i)) await this.pullServiceDefinitionAndImports(i, seen);
        }
    }

    /** Check that an object type implements another, following implements statements */
    verifyObjectImplements(object_type: string, implements_type: string): void
    {
        const check = (t: string, seen: Set<string>): boolean =>
        {
            if (t === implements_type) return true;
            if (seen.has(t)) return false;
            seen.add(t);
            const i = t.lastIndexOf(".");
            const d = this.types.defs.get(t.substring(0, i));
            const o = d?.objects.find((x) => x.name === t.substring(i + 1));
            if (!d || !o) return false;
            return o.implements.some((n) => check(n.includes(".") ? n : d.name + "." + n, seen));
        };
        if (!check(object_type, new Set())) throw error(MessageErrorType.ObjectNotFound, "ServiceError", "Invalid object type");
    }

    serviceDefForType(object_type: string): ServiceDefinition
    {
        const d = this.types.defs.get(object_type.substring(0, object_type.lastIndexOf(".")));
        if (!d) throw error(MessageErrorType.ObjectNotFound, "ServiceError", "Could not find service definition for " + object_type);
        return d;
    }

    private objectEntry(object_type: string): EntryDefinition
    {
        const n = object_type.substring(object_type.lastIndexOf(".") + 1);
        const o = this.serviceDefForType(object_type).objects.find((x) => x.name === n);
        if (!o) throw error(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Unknown object type: " + object_type);
        return o;
    }

    findMember(object_type: string, name: string): MemberDefinition | undefined
    {
        let m = this.members.get(object_type);
        if (!m)
        {
            m = new Map(this.objectEntry(object_type).members.map((x) => [x.name, x]));
            this.members.set(object_type, m);
        }
        return m.get(name);
    }

    async findObjRef(path: string): Promise<ServiceStub>
    {
        const existing = this.stubs.get(path);
        if (existing) return existing;

        const e = new MessageEntry(MessageEntryType.ObjectTypeName);
        e.servicePath = path;
        e.addElement(MessageElement.string("clientversion", RobotRaconteurNode.Version));
        const ret = await this.processRequest(e);
        const type = getElement(ret.elements, "objecttype").castString();
        if (type === "") throw error(MessageErrorType.ObjectNotFound, "ObjectNotFound", "Object type was not returned");

        const def_name = type.substring(0, type.lastIndexOf("."));
        if (!this.types.defs.has(def_name)) await this.pullServiceDefinitionAndImports(def_name);

        const current = this.stubs.get(path);
        if (current) return current;
        const stub = new ServiceStub(this, path, type);
        this.stubs.set(path, stub);
        return stub;
    }

    processRequest(m: MessageEntry): Promise<MessageEntry>
    {
        return new Promise<MessageEntry>((resolve, reject) =>
        {
            this.request_number = this.request_number === 0xffffffff ? 1 : this.request_number + 1;
            const id = this.request_number;
            m.requestID = id;

            const timer = setTimeout(() =>
            {
                this.pending.delete(id);
                reject(error(MessageErrorType.RequestTimeout, "RequestTimeout", "Request timed out"));
            }, this.node.requestTimeout);
            this.pending.set(id, { resolve, reject, timer });

            try
            {
                this.sendEntry(m);
            }
            catch (e)
            {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e as Error);
            }
        }).then((ret) =>
        {
            if (ret.error !== MessageErrorType.None) throw this.entryToError(ret);
            return ret;
        });
    }

    private entryToError(e: MessageEntry): RobotRaconteurError
    {
        const err = new RobotRaconteurError(e.error, findElement(e.elements, "errorname")?.castString() ?? "RobotRaconteur.RemoteError", findElement(e.elements, "errorstring")?.castString() ?? "");
        const sub = findElement(e.elements, "errorsubname");
        if (sub) err.errorSubName = sub.castString();
        const param = findElement(e.elements, "errorparam");
        if (param)
        {
            err.errorParam = unpackElement(param, VARVALUE, { name: "" } as ServiceDefinition, this.types) as VarValue | null;
        }
        return err;
    }

    /** Fill in a response entry for a failure in application code */
    errorToEntry(err: unknown, entry: MessageEntry): void
    {
        const e = err as Partial<RobotRaconteurError> & { name?: string; message?: string };
        const is_rr = err instanceof RobotRaconteurError;
        entry.error = is_rr ? (e.errorCode as MessageErrorType) : MessageErrorType.RemoteError;
        entry.addElement(MessageElement.string("errorname", is_rr ? e.errorName! : (e.name ?? "Error")));
        entry.addElement(MessageElement.string("errorstring", e.message ?? String(err)));
        if (is_rr && e.errorSubName) entry.addElement(MessageElement.string("errorsubname", e.errorSubName));
    }

    sendEntry(e: MessageEntry): void
    {
        this.transportOrThrow().sendMessage(this.newMessage(e));
    }

    /** Resolves once the entry has been handed to the network */
    sendEntryWait(e: MessageEntry): Promise<void>
    {
        return this.transportOrThrow().sendMessageWait(this.newMessage(e));
    }

    private transportOrThrow(): ITransportConnection
    {
        if (!this.connected || !this.transport) throw error(MessageErrorType.ConnectionError, "ConnectionError", "Client has been disconnected");
        return this.transport;
    }

    private newMessage(e: MessageEntry): Message
    {
        const m = new Message();
        m.entries.push(e);
        const h = m.header;
        if (e.entryType <= 500)
        {
            h.receiverNodeName = this.remoteNodeName;
            h.senderNodeName = this.node.nodeName;
        }
        h.senderEndpoint = this.localEndpoint;
        h.receiverEndpoint = this.remoteEndpoint;
        h.senderNodeID = this.node.nodeID;
        h.receiverNodeID = this.remoteNodeID;
        h.messageID = this.message_number;
        this.message_number = (this.message_number + 1) & 0xffff;

        this.last_sent = Date.now();
        return m;
    }

    messageReceived(m: Message): void
    {
        this.last_received = Date.now();
        const first = m.entries[0];
        if (first?.entryType === MessageEntryType.ConnectClientRet || first?.entryType === MessageEntryType.ConnectClientCombinedRet)
        {
            this.remoteEndpoint = m.header.senderEndpoint;
            this.remoteNodeID = m.header.senderNodeID;
            this.remoteNodeName = m.header.senderNodeName;
        }

        for (const e of m.entries)
        {
            if (e.error === MessageErrorType.InvalidEndpoint)
            {
                this.shutdownConnection();
                return;
            }
            this.entryReceived(e);
        }
    }

    private entryReceived(e: MessageEntry): void
    {
        switch (e.entryType)
        {
        case MessageEntryType.ServicePathReleasedReq:
            for (const path of [...this.stubs.keys()])
            {
                if (path === e.servicePath || path.startsWith(e.servicePath + "."))
                {
                    const stub = this.stubs.get(path)!;
                    stub.released = true;
                    stub.closeMembers();
                    this.stubs.delete(path);
                }
            }
            return;
        case MessageEntryType.EventReq:
            this.stubs.get(e.servicePath)?.dispatchEvent(e);
            return;
        case MessageEntryType.WirePacket:
        case MessageEntryType.WireClosed:
            this.stubs.get(e.servicePath)?.dispatchWire(e);
            return;
        case MessageEntryType.PipePacket:
        case MessageEntryType.PipePacketRet:
        case MessageEntryType.PipeClosed:
            this.stubs.get(e.servicePath)?.dispatchPipe(e);
            return;
        case MessageEntryType.CallbackCallReq:
            void this.processCallbackCall(e);
            return;
        case MessageEntryType.ServiceClosed:
            this.shutdownConnection();
            return;
        case MessageEntryType.EndpointCheckCapability:
            {
                const r = new MessageEntry(MessageEntryType.EndpointCheckCapabilityRet, e.memberName);
                r.requestID = e.requestID;
                r.addElement(new MessageElement("return", DataTypes.uint32_t, Uint32Array.of(0)));
                this.sendEntry(r);
                return;
            }
        }

        if (e.entryType % 2 === 0 && e.requestID !== 0)
        {
            const p = this.pending.get(e.requestID);
            if (p)
            {
                clearTimeout(p.timer);
                this.pending.delete(e.requestID);
                p.resolve(e);
            }
        }
    }

    private async processCallbackCall(e: MessageEntry): Promise<void>
    {
        const stub = this.stubs.get(e.servicePath);
        let r: MessageEntry;
        if (stub)
        {
            r = await stub.callbackCall(e);
        }
        else
        {
            r = new MessageEntry(MessageEntryType.CallbackCallRet, e.memberName);
            r.servicePath = e.servicePath;
            r.requestID = e.requestID;
            this.errorToEntry(error(MessageErrorType.ServiceError, "ServiceError", "Stub not found"), r);
        }
        try
        {
            this.sendEntry(r);
        }
        catch
        {
            // The connection closed while the callback was running
        }
    }

    private periodicCleanup(): void
    {
        const now = Date.now();
        if (now - this.last_received > this.node.endpointInactivityTimeout)
        {
            this.shutdownConnection();
            return;
        }
        if (this.remoteEndpoint !== 0 && now - this.last_sent > 60000)
        {
            try
            {
                this.sendEntry(this.newEntry(MessageEntryType.ClientKeepAliveReq));
            }
            catch
            {
                this.shutdownConnection();
            }
        }
    }

    transportConnectionClosed(): void
    {
        this.shutdownConnection();
    }

    private shutdownConnection(): void
    {
        if (this.closing) return;
        this.closing = true;
        this.connected = false;
        clearInterval(this.cleanup_timer);

        const closed = error(MessageErrorType.ConnectionError, "ConnectionError", "Connection closed");
        for (const p of this.pending.values())
        {
            clearTimeout(p.timer);
            p.reject(closed);
        }
        this.pending.clear();
        for (const stub of this.stubs.values()) stub.closeMembers();
        this.stubs.clear();
        this.transport?.close();
        this.node.deleteEndpoint(this);

        for (const l of [...this.close_listeners])
        {
            try
            {
                l();
            }
            catch (e)
            {
                console.error("Error in client close listener:", e);
            }
        }
        this.close_listeners.clear();
    }

    /** Notify when this client is disconnected for any reason */
    addCloseListener(listener: () => void): void
    {
        this.close_listeners.add(listener);
    }

    removeCloseListener(listener: () => void): void
    {
        this.close_listeners.delete(listener);
    }

    /** Disconnect from the service */
    async close(): Promise<void>
    {
        if (this.closing) return;
        try
        {
            const e = new MessageEntry(MessageEntryType.DisconnectClient);
            e.addElement(MessageElement.string("servicename", this.serviceName));
            await this.processRequest(e);
        }
        catch
        {
            // The connection is being closed regardless
        }
        this.shutdownConnection();
    }
}
