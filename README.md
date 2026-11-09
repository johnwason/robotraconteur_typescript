# Robot Raconteur TypeScript

A small, dependency-free TypeScript client for [Robot Raconteur](https://github.com/robotraconteur/robotraconteur) that runs in the browser and communicates over WebSockets.

**Status:** experimental. This is a minimal client. It does not yet cover the full Robot Raconteur feature set.

## Installation

Build from this repository with `npm install` and `npm run build`. The package is written as ESM and has no runtime dependencies.

## Usage

The examples below use two services designed for learning Robot Raconteur. Examples are written as ES modules with top level `await`.

Service definitions are pulled from the service when connecting, and all values are converted using them. Pass a user name and credentials as the second and third arguments of `connectService` if the service requires them, with credentials as a map of `VarValue`, for example `new Map([["password", new VarValue("secret", "string")]])`.

### Reynard the Robot

[Reynard the Robot](https://github.com/robotraconteur/reynard-the-robot) is a cartoon robot with a planar base and a three joint arm. Install and start it with `python -m pip install reynard-the-robot` and `python -m reynard_the_robot`, then open `http://localhost:29201` to watch it move.

```ts
import { BrowserWebSocketTransport, RobotRaconteurNode } from "robotraconteur";

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));

const reynard = await node.connectService("rr+ws://localhost:29200?service=reynard");

// Read the current state using a wire peek
const { value: state, timestamp } = await reynard.peekWireInValue("state");
console.log(state, timestamp);

// Parameters are given in declaration order
await reynard.callFunction("teleport", [0.1, -0.2]);

// Drive for one second, then stop
await reynard.callFunction("drive_robot", [0.5, -0.2, -1, false]);
await new Promise((resolve) => setTimeout(resolve, 1000));
await reynard.callFunction("drive_robot", [0, 0, -1, false]);

// Parameters can also be given by name
const deg = (d: number) => (d * Math.PI) / 180;
await reynard.callFunction("drive_arm", { q1: deg(10), q2: deg(-30), q3: deg(-15), timeout: 1.5, wait: true });

// Properties
await reynard.setProperty("color", [1, 0, 0]);
console.log(await reynard.getProperty("color"));
await reynard.setProperty("color", [0.929, 0.49, 0.192]);

await reynard.callFunction("say", ["Hello, World From Robot Raconteur!"]);

await node.disconnectService(reynard);
```

### UR5e robot in the training simulator

The [Robot Raconteur Training Simulator](https://github.com/robotraconteur-contrib/robotraconteur_training_sim) provides simulated robots that use the standard `com.robotraconteur.robotics.robot.Robot` type. See its documentation to install and start the UR5e scene. The first UR5e is at port 52511. In the Multi Robot scene the same port is a UR5e, and ports 52512 and 52513 are the ABB and Sawyer robots.

This example moves one joint using `jog_freespace`, then runs a trajectory using a generator. Enum values are read from the pulled service definition.

```ts
import { BrowserWebSocketTransport, RobotRaconteurNode } from "robotraconteur";

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const robot = await node.connectService("rr+ws://localhost:52511?service=robot");

const robot_def = robot.context.types.defs.get("com.robotraconteur.robotics.robot")!;
const modes = robot_def.enums.find((e) => e.name === "RobotCommandMode")!.values;
const mode = (name: string) => modes.find((v) => v.name === name)!.value;

// Get the joint names and current joint positions
const robot_info: any = await robot.getProperty("robot_info");
const joint_names = robot_info.joint_info.map((j: any) => j.joint_identifier.name);
const state: any = (await robot.peekWireInValue("robot_state")).value;
const start: Float64Array = state.joint_position;

// The robot must pass through halt to change command modes
await robot.setProperty("command_mode", mode("halt"));
await sleep(100);
await robot.setProperty("command_mode", mode("jog"));

// Jog the first joint in a sine wave for five seconds
for (let i = 0; i < 50; i++) {
    const target = start.map((q, j) => (j === 0 ? q + 0.2 * Math.sin(i / 10) : q));
    await robot.callFunction("jog_freespace", [target, new Float64Array(start.length).fill(1), true]);
    await sleep(100);
}

// Build a trajectory that returns to the starting position
await robot.setProperty("command_mode", mode("halt"));
await sleep(100);
await robot.setProperty("command_mode", mode("trajectory"));

const current: any = (await robot.peekWireInValue("robot_state")).value;
const waypoints = [
    { time_from_start: 0, joint_position: current.joint_position },
    { time_from_start: 5, joint_position: start }
].map((w) => ({
    ...w,
    joint_velocity: [],
    position_tolerance: [],
    velocity_tolerance: [],
    interpolation_mode: 0,
    waypoint_type: 0
}));
const trajectory = { joint_names, joint_units: null, waypoints, extended: null };

// Generator functions return a handle. The end is reported as an error with isStopIteration set
const gen: any = await robot.callFunction("execute_trajectory", [trajectory]);
try {
    for (;;) {
        const status: any = await robot.callFunctionGenNext(gen);
        console.log(status.action_status, status.trajectory_time);
    }
} catch (e: any) {
    if (!e.isStopIteration) throw e;
}

await node.disconnectService(robot);
```

`callFunctionGenClose(handle)` finishes a generator early and `callFunctionGenAbort(handle)` aborts its operation. Object references are accessed with `getObjRef(name, index)`, which returns a client for the referenced object with the same functions.

Clients in a browser page must be allowed by the service. See [Limitations](#limitations).

### Value types

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
| Multidimensional arrays (`double[*]`) | `{ dims, array }` in column-major order |
| `struct`, `pod`, `namedarray` | Plain objects with the declared field names |
| Arrays of `pod` or `namedarray` | `Array` of plain objects |
| `{list}` | `Array` |
| `{int32}`, `{string}` | `Map` (plain objects are also accepted when sending `{string}`) |
| `enum` | `number` |
| `varvalue` | `VarValue(value, type)`, for example `new VarValue(new Int32Array([1]), "int32[]")` |

Numeric data can be sent as the declared typed array, a plain array, or a typed array of another type. A scalar can also be given as a single element array. Anything else is converted only when every value fits the declared type exactly: fractional values for integer types, values out of range, `NaN` for integer types, non-numeric entries, and arrays where a scalar is expected are all rejected with a `RobotRaconteurError` rather than rounded, wrapped, or truncated. Sending a typed array of exactly the declared type does not copy or scan it, except for `bool[]`, whose `Uint8Array` values must be 0 or 1. Complex data can also be sent as an array of `{ real, imag }` objects or a plain number, which becomes a value with no imaginary part.

Typed arrays and strings can be sent to a `varvalue` without a wrapper because their type is known. A plain array or number sent to a `varvalue` must use `VarValue` to state its type. Numeric values in a received `varvalue` are always arrays, since the message format does not distinguish scalars.

### Errors

Failures reject with a `RobotRaconteurError`, which has `errorName`, `errorCode`, `message`, and, when provided by the service, `errorSubName` and `errorParam`.

### Service definition parser

```ts
import { parseServiceDefinition } from "robotraconteur";
import { verifyServiceDefinition } from "robotraconteur/validators";

const def = parseServiceDefinition(text);
verifyServiceDefinition(def);
```

The result is plain JSON described by [service-definition.schema.json](service-definition.schema.json). Semantic verification is a separate entry point so that it is only bundled when used.

## Bundle size

| Bundle | Minified | Gzipped |
| --- | --- | --- |
| Client | 44.6 KB | 13.8 KB |
| Parser only | 7.2 KB | 2.7 KB |
| Validators | 8.6 KB | 3.1 KB |

Run `npm run size` to regenerate these numbers.

## Limitations

* Client only, using Message Format Version 2. Message Version 4 is not offered during connection.
* Only `rr+ws` and `rr+wss` connections through the WebSocket class. `tcp` and `rr+tcp` URLs are converted to WebSocket connections, matching RobotRaconteurWeb.
* Pipes, events, callbacks, memories, wire connections, object locks, discovery, and `rrs+` end-to-end encryption are not implemented. Incoming callback requests are answered with a not-implemented error.
* Browsers send the origin of the page, and services must allow it. Pages loaded from `file://` and `robotraconteur.com` are allowed by default. Other origins, including `http://localhost`, must be added on the service with `AddWebSocketAllowedOrigin` or a command line option, for example `python -m reynard_the_robot --robotraconteur-tcp-ws-add-origins=http://localhost:8000`. Node.js clients do not send an origin.
* Assumes a little-endian host, which covers browser platforms.

## Development

[GitHub Actions](.github/workflows/main.yml) builds the package and runs the complete test suite on every push and pull request.

Development and tests run in a container with Node.js, Chromium, and the Python Robot Raconteur package:

```sh
podman build -t rr-ts-dev .
./scripts/podman-run.sh npm test
./scripts/podman-run.sh sh -c "npm run build && npm run size"
```

The tests use the standard service definitions from the Core repository (`test/robdef`) and the Core Python test server, using the configuration from Core's own pytest fixture. The client test suite runs in both Node.js and a real Chromium page.

| Area | Source | How it is checked |
| --- | --- | --- |
| `TestProperties`, `TestFunctions`, `TestObjRefs`, `TestWirePeekPoke`, `TestEnums`, `TestPods`, `TestGenerators`, `TestNamedArrays`, `TestComplex`, `TestNoLock`, `TestBools`, `TestExceptionParams` | Core `ServiceTestClient.py` and `ServiceTestClient2.py` | Ported under the same names in `test/common`, for the members this client implements |
| `TestProperties` and `TestFunctions` for TestService5 | Core `ServiceTestClient3.py` | Ported |
| The same operations as made by the Core Python client | Core test clients | Recorded and replayed against the same server, as an independent check |
| Authentication, attributes | Core and RobotRaconteurWeb client tests | Ported |
| Message serialization, fixed and LFSR random messages | Core and RobotRaconteurWeb `MessageSerialization` tests | Round trip, and Core must parse and re-serialize each message to identical bytes |
| Service path index encoding | Core `EncodeServicePathIndexTest` | Same vectors |
| Service definition parsing | Core and RobotRaconteurWeb `RobDef` tests | Compared with the Core parser's reading of each file |

Tests for members this client does not implement (events, pipes, callbacks, wire connections, memories, object and monitor locks) and for Message Version 4 are not ported. Core `MultiDimArray` tests are not applicable because this client has no multidimensional array class. Service definition string conversion and constant value evaluation from `RobDefTest` are not implemented.

`npm run fixtures` regenerates the following files:

* `test/common/ServiceTestClientGenerated.ts` is converted from the Core Python test clients by `scripts/port_core_client_tests.py`, so that the numeric test vectors are not retyped.

* `test/fixtures/robdef_oracle.json` is how the Core parser reads each test service definition.
* `test/fixtures/recorded_vectors.json` is the sequence of operations made by the Core Python test client.

## License

Apache 2.0. See [LICENSE](LICENSE).
