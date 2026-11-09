# Robot Raconteur TypeScript

A small, dependency-free TypeScript client for [Robot Raconteur](https://github.com/robotraconteur/robotraconteur) that runs in the browser and communicates over WebSockets.

**Status:** experimental. This is a minimal client. It does not yet cover the full Robot Raconteur feature set.

## Quick start

You only need a web browser and Python. No Node.js or TypeScript is required.

1. Install and start [Reynard the Robot](https://github.com/robotraconteur/reynard-the-robot), a cartoon robot made for learning Robot Raconteur:

   ```
   python -m pip install reynard-the-robot
   python -m reynard_the_robot
   ```

2. Open `http://localhost:29201` in a browser to watch Reynard.
3. Download this repository and double click [examples/reynard.html](examples/reynard.html). Press **Connect**, then try the other buttons. Type a message in Reynard's chat box and it appears on your page through an event.

## Using the library in a web page

Copy [examples/robotraconteur.min.js](examples/robotraconteur.min.js) next to your HTML file and load it with a script tag. Everything is then available under the name `RobotRaconteur`.

```html
<script src="robotraconteur.min.js"></script>
<script>
    async function main() {
        const node = new RobotRaconteur.RobotRaconteurNode();
        node.registerTransport(new RobotRaconteur.BrowserWebSocketTransport(node));

        const reynard = await node.connectService("rr+ws://localhost:29200?service=reynard");

        await reynard.callFunction("say", ["Hello!"]);
        console.log(await reynard.getProperty("color"));

        await node.disconnectService(reynard);
    }

    main();
</script>
```

Open the page by double clicking the file. If you put the page on a web server instead, see [Limitations](#limitations).

The word `await` means "wait for the robot to answer", and it can only be used inside a function marked `async`.

### What you can do with a connected robot

| To do this | Write this |
| --- | --- |
| Read a property | `await robot.getProperty("name")` |
| Set a property | `await robot.setProperty("name", value)` |
| Call a function | `await robot.callFunction("name", [first, second])` |
| Get a sub-object | `await robot.getObjRef("name")`, or `await robot.getObjRef("name", index)` |
| Read a wire's latest value | `(await robot.peekWireInValue("name")).value` |
| Read a wire's output value | `(await robot.peekWireOutValue("name")).value` |
| Set a wire's output value | `await robot.pokeWireOutValue("name", value)` |
| Read from a generator | `await robot.callFunctionGenNext(handle)` |
| Finish or abort a generator | `await robot.callFunctionGenClose(handle)` or `await robot.callFunctionGenAbort(handle)` |
| Listen for an event | `robot.addEventListener("name", (first, second) => { ... })` |
| Stop listening | `robot.removeEventListener("name", handler)` |
| Let the service call your code | `robot.setCallback("name", (first, second) => result)` |

The names come from the service definition of the robot. Plain arrays of numbers such as `[1, 0, 0]` can be used anywhere an array is expected.

If a service requires a login, pass the user name and password when connecting:

```js
const credentials = new Map([["password", new RobotRaconteur.VarValue("secret", "string")]]);
const robot = await node.connectService(url, "username", credentials);
```

## Using the library from Node.js

Node.js 22 or newer is required. From this repository folder, run:

```
npm install
npm run build
node examples/reynard.mjs
```

See [examples/reynard.mjs](examples/reynard.mjs). The code is the same as in a web page, except that the library is loaded with `import`.

## Example: UR5e robot in the training simulator

The [Robot Raconteur Training Simulator](https://github.com/robotraconteur-contrib/robotraconteur_training_sim) provides simulated articulated robots using the standard `com.robotraconteur.robotics.robot.Robot` type. See its documentation to install and start the UR5e scene. The first UR5e is at port 52511. In the Multi Robot scene that port is also a UR5e, and ports 52512 and 52513 are the ABB and Sawyer robots.

This moves the first joint of the robot. The complete example, which also runs a trajectory using a generator, is [examples/ur5e.mjs](examples/ur5e.mjs).

```js
const robot = await node.connectService("rr+ws://localhost:52511?service=robot");

// Change to jog mode. The robot must go through halt (0) to reach jog (1)
await robot.setProperty("command_mode", 0);
await new Promise((resolve) => setTimeout(resolve, 100));
await robot.setProperty("command_mode", 1);

// Read the current joint positions, then jog the first joint by 0.1 radians
const state = (await robot.peekWireInValue("robot_state")).value;
const target = Array.from(state.joint_position);
target[0] = target[0] + 0.1;
await robot.callFunction("jog_freespace", [target, [1, 1, 1, 1, 1, 1], true]);
```

## Reference

TypeScript type definitions are included for those who want them. Parameters can also be passed by name, as in `robot.callFunction("add", { a: 1, b: 2 })`.

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
| Client | 48.6 KB | 15.1 KB |
| Parser only | 7.2 KB | 2.7 KB |
| Validators | 8.6 KB | 3.1 KB |

Run `npm run size` to regenerate these numbers.

## Flow control

Sending never builds up an unbounded backlog of stale data: one message is sent at a time, and a newer wire packet replaces one still waiting, as in the other Robot Raconteur implementations. Where the browser provides `WebSocketStream`, currently Chromium based browsers, it is used to apply backpressure in both directions. Elsewhere, including Node.js, the library falls back to `WebSocket` and polls how much data is waiting to be sent. `WebSocket` cannot slow down incoming data, so with the fallback a page that cannot keep up will buffer received messages in the browser. Set `useWebSocketStream` to `false` on the transport to always use `WebSocket`.

## Limitations

* Client only, using Message Format Version 2. Message Version 4 is not offered during connection.
* Only `rr+ws` and `rr+wss` connections through the WebSocket class. `tcp` and `rr+tcp` URLs are converted to WebSocket connections, matching RobotRaconteurWeb.
* Pipes, memories, wire connections, object locks, discovery, and `rrs+` end-to-end encryption are not implemented.
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
| `TestProperties`, `TestFunctions`, `TestEvents`, `TestObjRefs`, `TestCallbacks`, `TestWirePeekPoke`, `TestEnums`, `TestPods`, `TestGenerators`, `TestNamedArrays`, `TestComplex`, `TestNoLock`, `TestBools`, `TestExceptionParams` | Core `ServiceTestClient.py` and `ServiceTestClient2.py` | Ported under the same names in `test/common`, for the members this client implements |
| `TestProperties` and `TestFunctions` for TestService5 | Core `ServiceTestClient3.py` | Ported |
| The same operations as made by the Core Python client | Core test clients | Recorded and replayed against the same server, as an independent check |
| Authentication, attributes | Core and RobotRaconteurWeb client tests | Ported |
| Message serialization, fixed and LFSR random messages | Core and RobotRaconteurWeb `MessageSerialization` tests | Round trip, and Core must parse and re-serialize each message to identical bytes |
| Service path index encoding | Core `EncodeServicePathIndexTest` | Same vectors |
| Service definition parsing | Core and RobotRaconteurWeb `RobDef` tests | Compared with the Core parser's reading of each file |

Tests for members this client does not implement (pipes, wire connections, memories, object and monitor locks) and for Message Version 4 are not ported. Core `MultiDimArray` tests are not applicable because this client has no multidimensional array class. Service definition string conversion and constant value evaluation from `RobDefTest` are not implemented.

`npm run fixtures` regenerates the following files:

* `test/common/ServiceTestClientGenerated.ts` is converted from the Core Python test clients by `scripts/port_core_client_tests.py`, so that the numeric test vectors are not retyped.

* `test/fixtures/robdef_oracle.json` is how the Core parser reads each test service definition.
* `test/fixtures/recorded_vectors.json` is the sequence of operations made by the Core Python test client.

## License

Apache 2.0. See [LICENSE](LICENSE).
