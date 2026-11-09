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

import { ClientContext, ServiceStub } from "./Client.js";
import { Message } from "./Message.js";
import { NodeID } from "./NodeID.js";
import { parseServiceDefinition, ServiceDefinition } from "./ServiceDefinition.js";
import { parseConnectionUrl, Transport } from "./Transport.js";
import { RobotRaconteurError } from "./Error.js";
import { MessageErrorType } from "./DataTypes.js";

export class RobotRaconteurNode
{
    /** Version reported to services. Matches the RobotRaconteurWeb protocol level */
    static readonly Version = "0.20.0";

    nodeID = NodeID.newUniqueID();
    nodeName = "";
    requestTimeout = 15000;
    transportInactivityTimeout = 600000;
    endpointInactivityTimeout = 600000;

    readonly serviceTypes = new Map<string, ServiceDefinition>();

    private transports: Transport[] = [];
    private endpoints = new Map<number, ClientContext>();

    registerTransport(transport: Transport): void
    {
        this.transports.push(transport);
    }

    /** Register a service definition from its text or parsed form */
    registerServiceType(def: string | ServiceDefinition): ServiceDefinition
    {
        const d = typeof def === "string" ? parseServiceDefinition(def) : def;
        this.serviceTypes.set(d.name, d);
        return d;
    }

    /** Connect to a service and return the client for the root object */
    async connectService(url: string, username?: string, credentials?: Map<string, unknown> | Record<string, unknown>, objectType?: string): Promise<ServiceStub>
    {
        parseConnectionUrl(url);
        const transport = this.transports.find((x) => x.canConnectService(url));
        if (!transport)
        {
            throw new RobotRaconteurError(MessageErrorType.ConnectionError, "RobotRaconteur.ConnectionError", "Could not find a transport for URL: " + url);
        }
        const c = new ClientContext(this);
        this.registerEndpoint(c);
        try
        {
            return await c.connectService(transport, url, username, credentials, objectType);
        }
        catch (e)
        {
            this.deleteEndpoint(c);
            throw e;
        }
    }

    async disconnectService(stub: ServiceStub): Promise<void>
    {
        await stub.context.close();
    }

    /** Close all clients and transports */
    async shutdown(): Promise<void>
    {
        await Promise.all([...this.endpoints.values()].map((c) => c.close()));
        this.transports.forEach((t) => t.close());
    }

    private registerEndpoint(c: ClientContext): void
    {
        const a = new Uint32Array(1);
        do
        {
            globalThis.crypto.getRandomValues(a);
        } while (a[0] === 0 || this.endpoints.has(a[0]!));
        c.localEndpoint = a[0]!;
        this.endpoints.set(c.localEndpoint, c);
    }

    deleteEndpoint(c: ClientContext): void
    {
        this.endpoints.delete(c.localEndpoint);
    }

    messageReceived(m: Message): void
    {
        if (!m.header.receiverNodeID.equals(this.nodeID)) return;
        this.endpoints.get(m.header.receiverEndpoint)?.messageReceived(m);
    }
}
