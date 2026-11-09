# Robot Raconteur TypeScript

A small, dependency-free TypeScript client for [Robot Raconteur](https://github.com/robotraconteur/robotraconteur) that runs in the browser and communicates over WebSockets.

**Status:** experimental. This is a minimal client. It does not yet cover the full Robot Raconteur feature set.

## Installation

Build from this repository with `npm install` and `npm run build`. The package is written as ESM and has no runtime dependencies.

## Usage

```ts
import { BrowserWebSocketTransport, RobotRaconteurNode, VarValue } from "robotraconteur";

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));

const robot = await node.connectService("rr+ws://localhost:22222?service=my_robot");

await robot.setProperty("speed", 1.5);
const speed = await robot.getProperty("speed");

const result = await robot.callFunction("add", [1.0, 2.0]);
const same = await robot.callFunction("add", { a: 1.0, b: 2.0 });

const arm = await robot.getObjRef("arms", 0);

const { value, timestamp } = await robot.peekWireInValue("position");
await robot.pokeWireOutValue("command", new Float64Array([0, 0, 1]));

await node.disconnectService(robot);
```

The service definitions are pulled from the service when connecting, and all values are converted using them.

Pass a user name and credentials as the second and third arguments of `connectService`. Credentials are a map of `VarValue`, for example `new Map([["password", new VarValue("secret", "string")]])`.

### Generators

`callFunction` returns a `GeneratorHandle` for generator functions. The end of a generator is reported as an error with `isStopIteration` set, as in the other Robot Raconteur implementations.

```ts
const gen = await robot.callFunction("read_samples");
try {
    for (;;) {
        console.log(await robot.callFunctionGenNext(gen));
    }
} catch (e) {
    if (!e.isStopIteration) throw e;
}
```

`callFunctionGenClose(handle)` finishes a generator early and `callFunctionGenAbort(handle)` aborts its operation.

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

Sending accepts plain numeric arrays in place of typed arrays. Typed arrays and strings can be sent to a `varvalue` without a wrapper because their type is known. Numeric values in a received `varvalue` are always arrays, since the message format does not distinguish scalars.

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
| Client | 43.3 KB | 13.4 KB |
| Parser only | 7.2 KB | 2.7 KB |
| Validators | 8.6 KB | 3.1 KB |

Run `npm run size` to regenerate these numbers.

## Limitations

* Client only, using Message Format Version 2. Message Version 4 is not offered during connection.
* Only `rr+ws` and `rr+wss` connections through the WebSocket class. `tcp` and `rr+tcp` URLs are converted to WebSocket connections, matching RobotRaconteurWeb.
* Pipes, events, callbacks, memories, wire connections, object locks, discovery, and `rrs+` end-to-end encryption are not implemented. Incoming callback requests are answered with a not-implemented error.
* Services must allow the origin of the page. Pages loaded from `file://` and `robotraconteur.com` are allowed by default. Use `--robotraconteur-tcp-ws-add-origins` or `AddWebSocketAllowedOrigin` on the service for other origins.
* Assumes a little-endian host, which covers browser platforms.

## Development

Development and tests run in a container with Node.js, Chromium, and the Python Robot Raconteur package:

```sh
podman build -t rr-ts-dev .
./scripts/podman-run.sh npm test
./scripts/podman-run.sh sh -c "npm run build && npm run size"
```

The tests use the standard service definitions from the Core repository (`test/robdef`) and run Core's Python test server unmodified. Two fixtures are generated by `npm run fixtures`:

* `test/fixtures/robdef_oracle.json` is how the Core parser reads each test service definition.
* `test/fixtures/recorded_vectors.json` is the sequence of operations made by the Core Python test client, which the TypeScript client replays against the same server.

## License

Apache 2.0. See [LICENSE](LICENSE).
