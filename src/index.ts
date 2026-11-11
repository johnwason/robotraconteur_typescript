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

/**
 * The Robot Raconteur client: nodes, connections, transports, subscriptions, and the service
 * definition parser.
 *
 * @module robotraconteur
 */

export { BrowserWebSocketTransport } from "./BrowserWebSocketTransport.js";
export { ClientContext, GeneratorHandle, ServiceStub } from "./Client.js";
export type { CallbackHandler, EventHandler } from "./Client.js";
export { PipeHandle } from "./PipeMember.js";
export type { PipeAckHandler, PipeClosedHandler, PipePacketHandler, PipePacketValue } from "./PipeMember.js";
export { WireHandle } from "./WireMember.js";
export type { MemberDirection, TimeSpec, WireClosedHandler, WireValue, WireValueChangedHandler } from "./WireMember.js";
export { RobotRaconteurError } from "./Error.js";
export { RobotRaconteurNode } from "./Node.js";
export { NodeID } from "./NodeID.js";
export { VarValue } from "./Pack.js";
export type { MultiDimArray } from "./Pack.js";
export { parseServiceDefinition, parseTypeDefinition, ServiceDefinitionParseError } from "./ServiceDefinition.js";
export { getConstants, newStructure } from "./ServiceTypes.js";
export type {
    ConstantDefinition,
    ContainerType,
    EntryDefinition,
    EnumDefinition,
    EnumValue,
    ExceptionDefinition,
    MemberDefinition,
    MemberKind,
    ParameterDefinition,
    ServiceDefinition,
    TypeDefinition,
    UsingDefinition
} from "./ServiceDefinition.js";
export { PipeSubscription, ServiceSubscription, SubObjectSubscription, subscribeService, WireSubscription } from "./Subscription.js";
export type {
    ClientConnectFailedHandler,
    ClientConnectionHandler,
    ConnectedClient,
    Credentials,
    PipePacketSubscriptionHandler,
    ServiceSubscriptionClient,
    ServiceSubscriptionClientID,
    ServiceSubscriptionOptions,
    WireValueSubscriptionHandler
} from "./Subscription.js";
export { parseConnectionUrl } from "./Transport.js";
export type { Endpoint, ITransportConnection, ParsedConnectionUrl, Transport } from "./Transport.js";
