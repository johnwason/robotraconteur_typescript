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

// Protocol constants. These are const enums so that only the numbers used end up in the bundle.

export const enum DataTypes
{
    void_t = 0,
    double_t,
    single_t,
    int8_t,
    uint8_t,
    int16_t,
    uint16_t,
    int32_t,
    uint32_t,
    int64_t,
    uint64_t,
    string_t,
    cdouble_t,
    csingle_t,
    bool_t,
    structure_t = 101,
    vector_t,
    dictionary_t,
    object_t,
    varvalue_t,
    varobject_t,
    list_t = 108,
    pod_t,
    pod_array_t,
    pod_multidimarray_t,
    enum_t,
    namedtype_t,
    namedarray_t,
    namedarray_array_t,
    namedarray_multidimarray_t,
    multidimarray_t
}

export const enum MessageEntryType
{
    Null = 0,
    StreamOp = 1,
    StreamOpRet,
    StreamCheckCapability,
    StreamCheckCapabilityRet,
    GetServiceDesc = 101,
    GetServiceDescRet,
    ObjectTypeName,
    ObjectTypeNameRet,
    ServiceClosed,
    ServiceClosedRet,
    ConnectClient,
    ConnectClientRet,
    DisconnectClient,
    DisconnectClientRet,
    ConnectionTest,
    ConnectionTestRet,
    ConnectClientCombined = 121,
    ConnectClientCombinedRet,
    EndpointCheckCapability = 501,
    EndpointCheckCapabilityRet,
    ClientKeepAliveReq = 1105,
    ClientKeepAliveRet,
    ClientSessionOpReq = 1107,
    ClientSessionOpRet,
    ServicePathReleasedReq,
    PropertyGetReq = 1111,
    PropertyGetRes,
    PropertySetReq,
    PropertySetRes,
    FunctionCallReq = 1121,
    FunctionCallRes,
    GeneratorNextReq,
    GeneratorNextRes,
    EventReq = 1131,
    CallbackCallReq = 1151,
    CallbackCallRet,
    WirePacket = 1161,
    WirePeekInValueReq = 1181,
    WirePeekInValueRet,
    WirePeekOutValueReq,
    WirePeekOutValueRet,
    WirePokeOutValueReq,
    WirePokeOutValueRet
}

export const enum MessageErrorType
{
    None = 0,
    ConnectionError = 1,
    ProtocolError,
    ServiceNotFound,
    ObjectNotFound,
    InvalidEndpoint,
    ServiceError = 8,
    MemberNotFound,
    DataTypeError = 12,
    InvalidOperation = 17,
    RemoteError = 100,
    RequestTimeout,
    NotImplementedError = 104,
    AbortOperation = 107,
    OperationAborted,
    StopIteration
}

export const enum TransportCapabilityCode
{
    PageMask = 0xfff00000,
    Message2BasicPage = 0x02000000,
    Message2BasicEnable = 0x00000001,
    Message2BasicConnectCombined = 0x00000002
}

export type NumericArray =
    | Float64Array
    | Float32Array
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array;

export interface PrimitiveInfo
{
    name: string;
    type: DataTypes;
    /** Bytes per logical element */
    size: number;
    ctor: { new (buffer: ArrayBuffer | number): NumericArray; from(a: ArrayLike<unknown>): NumericArray };
    /** Typed array entries per logical element. 2 for interleaved complex numbers */
    stride: number;
}

function p(name: string, type: DataTypes, size: number, ctor: unknown, stride = 1): PrimitiveInfo
{
    return { name, type, size, ctor: ctor as PrimitiveInfo["ctor"], stride };
}

const primitive_list = [
    p("double", DataTypes.double_t, 8, Float64Array),
    p("single", DataTypes.single_t, 4, Float32Array),
    p("int8", DataTypes.int8_t, 1, Int8Array),
    p("uint8", DataTypes.uint8_t, 1, Uint8Array),
    p("int16", DataTypes.int16_t, 2, Int16Array),
    p("uint16", DataTypes.uint16_t, 2, Uint16Array),
    p("int32", DataTypes.int32_t, 4, Int32Array),
    p("uint32", DataTypes.uint32_t, 4, Uint32Array),
    p("int64", DataTypes.int64_t, 8, BigInt64Array),
    p("uint64", DataTypes.uint64_t, 8, BigUint64Array),
    p("cdouble", DataTypes.cdouble_t, 16, Float64Array, 2),
    p("csingle", DataTypes.csingle_t, 8, Float32Array, 2),
    p("bool", DataTypes.bool_t, 1, Uint8Array)
];

export const primitivesByName = new Map(primitive_list.map((x) => [x.name, x]));
export const primitivesByType = new Map(primitive_list.map((x) => [x.type as number, x]));
