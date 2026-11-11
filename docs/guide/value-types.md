---
title: Value types
---

# Value types

Values are packed and unpacked using the service definition, so they are plain JavaScript values.

| Robot Raconteur type | JavaScript value |
| --- | --- |
| `double`, `single`, 8 to 32 bit integers | `number` |
| `int64`, `uint64` | `bigint` |
| `bool` | `boolean` |
| `cdouble`, `csingle` | `{ real, imag }` |
| `string` | `string` |
| Numeric arrays | Typed arrays such as `Float64Array`. `int64[]` uses `BigInt64Array` |
| `bool[]` | `Uint8Array` |
| Complex arrays | `Float64Array` or `Float32Array` with interleaved real and imaginary values |
| Multidimensional arrays (`double[*]`) | {@link robotraconteur!MultiDimArray | MultiDimArray}: `{ dims, array }` in column-major order |
| `struct`, `pod`, `namedarray` | Plain objects with the declared field names |
| Arrays of `pod` or `namedarray` | `Array` of plain objects |
| `{list}` | `Array` |
| `{int32}`, `{string}` | `Map` (plain objects are also accepted when sending `{string}`) |
| `enum` | `number` |
| `varvalue` | {@link robotraconteur!VarValue | VarValue}, for example `new VarValue(new Int32Array([1]), "int32[]")` |

## Sending numbers

Numeric data can be sent as the declared typed array, a plain array, or a typed array of another type. A scalar can also be given as a single element array.

Anything else is converted only when every value fits the declared type exactly. Fractional values for integer types, values out of range, `NaN` for integer types, non-numeric entries, and arrays where a scalar is expected are all rejected with a {@link robotraconteur!RobotRaconteurError | RobotRaconteurError} rather than rounded, wrapped, or truncated. Sending a typed array of exactly the declared type does not copy or scan it, except for `bool[]`, whose `Uint8Array` values must be 0 or 1.

Complex data can also be sent as an array of `{ real, imag }` objects, or a plain number, which becomes a value with no imaginary part.

## varvalue

Typed arrays and strings can be sent to a `varvalue` without a wrapper, because their type is known. A plain array or number sent to a `varvalue` must use {@link robotraconteur!VarValue | VarValue} to state its type. Numeric values in a received `varvalue` are always arrays, since the message format does not distinguish scalars.

## Structures

Structures are plain objects. {@link robotraconteur!newStructure | newStructure} creates one with every field set to its default, which is convenient for structures with many fields:

```js
const state = newStructure(robot, "com.robotraconteur.robotics.robot.RobotStateSensorData");
```
