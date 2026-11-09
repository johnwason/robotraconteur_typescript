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

const VARVALUE_MAP: TypeDefinition = { type: "varvalue", container: "map_string" };
const VARVALUE: TypeDefinition = { type: "varvalue" };
const TIMESPEC = "RobotRaconteur.TimeSpec";

interface PendingRequest
{
    resolve: (m: MessageEntry) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** A value received from a wire member and the time it was sampled by the sender */
export interface WireValue
{
    value: unknown;
    timestamp: { seconds: bigint; nanoseconds: number };
}

/** Handle for a generator returned by callFunction */
export class GeneratorHandle
{
    constructor(readonly memberName: string, readonly index: number, readonly returnType: TypeDefinition | undefined, readonly paramType: TypeDefinition | undefined) {}
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
            return new GeneratorHandle(name, index, itemType(m.type), isGeneratorType(last?.type) ? itemType(last!.type) : undefined);
        }
        if (m.type!.type === "void") return undefined;
        return this.unpack(getElement(ret.elements, "return"), m.type!);
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

    private async peek(type: MessageEntryType, name: string): Promise<WireValue>
    {
        const m = this.member(name, "wire");
        const ret = await this.request(type, name);
        const ts = getElement(ret.elements, "packettime").castNested(DataTypes.structure_t).elements;
        return {
            value: this.unpack(getElement(ret.elements, "packet"), m.type!),
            timestamp: {
                seconds: (getElement(ts, "seconds").data as BigInt64Array)[0]!,
                nanoseconds: (getElement(ts, "nanoseconds").data as Int32Array)[0]!
            }
        };
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
        const now = Date.now();
        const time = MessageElement.nested("packettime", DataTypes.structure_t, TIMESPEC, [
            new MessageElement("seconds", DataTypes.int64_t, BigInt64Array.of(BigInt(Math.floor(now / 1000)))),
            new MessageElement("nanoseconds", DataTypes.int32_t, Int32Array.of((now % 1000) * 1000000))
        ]);
        await this.request(MessageEntryType.WirePokeOutValueReq, name, [time, this.pack("packet", m.type!, value)]);
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

    private sendEntry(e: MessageEntry): void
    {
        if (!this.connected || !this.transport) throw error(MessageErrorType.ConnectionError, "ConnectionError", "Client has been disconnected");

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
        this.transport.sendMessage(m);
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
                    this.stubs.get(path)!.released = true;
                    this.stubs.delete(path);
                }
            }
            return;
        case MessageEntryType.CallbackCallReq:
            {
                // Callbacks are not implemented. Respond so that the service does not wait for a timeout
                const r = new MessageEntry(MessageEntryType.CallbackCallRet, e.memberName);
                r.servicePath = e.servicePath;
                r.requestID = e.requestID;
                r.error = MessageErrorType.NotImplementedError;
                r.addElement(MessageElement.string("errorname", "RobotRaconteur.NotImplementedError"));
                r.addElement(MessageElement.string("errorstring", "Callbacks are not implemented"));
                this.sendEntry(r);
                return;
            }
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
        this.stubs.clear();
        this.transport?.close();
        this.node.deleteEndpoint(this);
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
