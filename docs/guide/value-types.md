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
| Arrays of `pod` or `namedarray` | `Array` of plain objects. Arrays of `namedarray` can instead be received as a {@link robotraconteur!NamedArrayView | NamedArrayView}, see [Large arrays](#large-arrays) |
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

## Large arrays

Arrays of named arrays, such as the points of a `com.robotraconteur.pointcloud.PointCloudf`, are sent as one numeric array. By default each element is turned into an object, which is slow and uses a lot of memory for millions of elements. Decoding them as a {@link robotraconteur!NamedArrayView | NamedArrayView} instead keeps the typed array that was received, without any work per element:

```js
// Only these types, wherever they appear. Other named arrays are still objects
node.decodeOptions = { viewTypes: ["com.robotraconteur.pointcloud.PointCloudPointf"] };
// Or every array of named arrays
node.decodeOptions = { namedArrays: "view" };
```

The options can also be set for one connection with `client.context.decodeOptions`, or for the clients of a subscription with the `decodeOptions` subscription option or `subscription.decodeOptions`. Single named arrays, such as one `Pose`, are always objects.

Element `i` of a view starts at `view.array[i * view.stride]`, and `view.fieldOffset(name)` gives a field's position within an element. `view.get(i)` and `view.toObjects()` give objects when they are needed. The typed array belongs to the view, so it can be passed to WebGL, or transferred to a worker with `view.array.buffer`.

A view can be sent wherever an array of its named array type is expected, without copying, whatever the decode options are. {@link robotraconteur!newNamedArrayView | newNamedArrayView} creates one to fill:

```js
const points = newNamedArrayView(client, "com.robotraconteur.geometry.Vector3", 1000);
points.array[0] = 1.5; // x of point 0
```

Use named arrays or numeric arrays for large data. Arrays of `pod` are sent with a separate message element for every field of every element, so they are always slow to decode.
