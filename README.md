<p align="center"><img src="docs/figures/logo-header.svg"></p>

# Robot Raconteur TypeScript

A small, dependency-free TypeScript client for [Robot Raconteur](https://github.com/robotraconteur/robotraconteur) that runs in the browser and communicates over WebSockets.

> [!WARNING]
> This package is new, and its API may change in any release before 1.0. Pin an exact version, such as `robotraconteur@0.1.0`, and read the [changelog](CHANGELOG.md) before upgrading.

The client covers properties, functions, generators, objects, events, callbacks, wires, pipes, object and monitor locks, and subscriptions. Memories are not supported.

```
npm install robotraconteur
```

## Quick start

You only need a web browser and Python. No Node.js or TypeScript is required.

1. Install and start [Reynard the Robot](https://github.com/robotraconteur/reynard-the-robot), a cartoon robot made for learning Robot Raconteur:

   ```
   python -m pip install reynard-the-robot
   python -m reynard_the_robot
   ```

2. Open `http://localhost:29201` in a browser to watch Reynard.
3. Download this repository and double click [examples/reynard.html](examples/reynard.html). Press **Connect**, then try the other buttons. Type a message in Reynard's chat box and it appears on your page through an event.

## Documentation

The [documentation](https://robotraconteur.github.io/robotraconteur_typescript/) has a guide and an API reference. The guide pages are also in this repository:

- [Getting started](docs/guide/getting-started.md): in a web page, with a bundler, and in Node.js
- [Using a service](docs/guide/using-services.md): properties, functions, generators, objects, events, callbacks, and locks
- [Wires and pipes](docs/guide/wires-and-pipes.md): streaming values and packets
- [Staying connected](docs/guide/subscriptions.md): subscriptions that reconnect
- [Value types](docs/guide/value-types.md): how Robot Raconteur types appear in JavaScript
- [Service definitions](docs/guide/service-definitions.md): parsing and checking `.robdef` files
- [Limits](docs/guide/limits.md): browser origins, flow control, bundle size, and what is not supported

For `rr+tcp`, TLS, discovery, and writing services in Node.js, see [robotraconteur-node](https://github.com/robotraconteur/robotraconteur_typescript_node).

## Example: a web page

Load `robotraconteur.min.js` with a script tag, from a CDN or from a copy of [examples/robotraconteur.min.js](examples/robotraconteur.min.js) next to your HTML file. Everything is then available under the name `RobotRaconteur`.

```html
<script src="https://cdn.jsdelivr.net/npm/robotraconteur@0.1.0/dist/robotraconteur.min.js"></script>
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

[examples/ur5e.mjs](examples/ur5e.mjs) moves a simulated UR5e from the [Robot Raconteur Training Simulator](https://github.com/robotraconteur-contrib/robotraconteur_training_sim) with a generator.

## Development

[GitHub Actions](.github/workflows/main.yml) builds the package and runs the complete test suite on every push and pull request.

Development and tests run in a container with Node.js, Chromium, and the Python Robot Raconteur package:

```sh
podman build -t rr-ts-dev .
./scripts/podman-run.sh npm test
./scripts/podman-run.sh sh -c "npm run build && npm run size"
./scripts/podman-run.sh npm run docs
```

`npm run docs` builds the documentation site into `docs-site`, from the guide in `docs/guide` and the doc comments in the source.

The tests use the standard service definitions from the Core repository (`test/robdef`) and the Core Python test server, using the configuration from Core's own pytest fixture. The client test suite runs in both Node.js and a real Chromium page.

| Area | Source | How it is checked |
| --- | --- | --- |
| `TestProperties`, `TestFunctions`, `TestEvents`, `TestObjRefs`, `TestPipes`, `TestCallbacks`, `TestWires`, `TestWirePeekPoke`, `TestEnums`, `TestPods`, `TestGenerators`, `TestNamedArrays`, `TestComplex`, `TestNoLock`, `TestBools`, `TestExceptionParams`, `TestObjectLock`, `TestMonitorLock` | Core `ServiceTestClient.py` and `ServiceTestClient2.py` | Ported under the same names in `test/common`, for the members this client implements |
| `TestProperties` and `TestFunctions` for TestService5 | Core `ServiceTestClient3.py` | Ported |
| The same operations as made by the Core Python client | Core test clients | Recorded and replayed against the same server, as an independent check |
| Authentication, attributes | Core and RobotRaconteurWeb client tests | Ported |
| Message serialization, fixed and LFSR random messages | Core and RobotRaconteurWeb `MessageSerialization` tests | Round trip, and Core must parse and re-serialize each message to identical bytes |
| Service path index encoding | Core `EncodeServicePathIndexTest` | Same vectors |
| Service definition parsing | Core and RobotRaconteurWeb `RobDef` tests | Compared with the Core parser's reading of each file |

Tests for members this client does not implement (memories) and for Message Version 4 are not ported. Core `MultiDimArray` tests are not applicable because this client has no multidimensional array class. Service definition string conversion and constant value evaluation from `RobDefTest` are not implemented.

`npm run fixtures` regenerates the following files:

* `test/common/ServiceTestClientGenerated.ts` is converted from the Core Python test clients by `scripts/port_core_client_tests.py`, so that the numeric test vectors are not retyped.

* `test/fixtures/robdef_oracle.json` is how the Core parser reads each test service definition.
* `test/fixtures/recorded_vectors.json` is the sequence of operations made by the Core Python test client.

## Releasing

1. Update the version in `package.json`, and in the CDN links of this README and `docs/guide/getting-started.md`, and add the changes to [CHANGELOG.md](CHANGELOG.md).
2. Publish a GitHub release in the robotraconteur organization, with a new tag named after the version, such as `v0.1.0`. The Publish workflow runs the tests, checks that the tag matches the version, and publishes to npm with provenance. It needs an npm token in the `NPM_TOKEN` secret of the repository.

Publish this package before a robotraconteur-node release that depends on its changes.

## License

Apache 2.0. See [LICENSE](LICENSE).
