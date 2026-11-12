# Changelog

The API may change in any release before 1.0.

## Unreleased

* Export `./package.json`, so that tools can read the package's version with `require("robotraconteur/package.json")`.

## 0.1.0

The first release: a small Robot Raconteur client in TypeScript for browsers and Node.js, with no dependencies.

* Service definition parser producing JSON with a published schema, and separate validators.
* Message Version 2 serialization, checked byte for byte against Core.
* Client access to properties, functions, generators (including `for await`), object references, wires, pipes, events, and callbacks, with structures, pods, named arrays, enums, and `varvalue`. `newStructure` and `getConstants` work as in Core.
* Object locks and monitor locks, with `requestObjectLock`, `releaseObjectLock`, `monitorEnter`, and `monitorExit`.
* Arrays of named arrays can be received as `NamedArrayView`, over the typed array that was received, for large data such as point clouds. Set with `DecodeOptions` on the node, a connection, or a subscription.
* `BrowserWebSocketTransport` using `WebSocket` or `WebSocketStream`, with flow control.
* Subscriptions that reconnect, with wire, pipe, and sub object subscriptions.
* With several URLs for one service, the preferred URL is tried first, as in Core.
* `robotraconteur.min.js` for use in a web page without a build step, also served by CDNs from the npm package.
* A user guide and API reference at https://robotraconteur.github.io/robotraconteur_typescript/

Not included: memories, Message Version 4, and the Local transport. Services, `rr+tcp`, TLS, and discovery are in [robotraconteur-node](https://github.com/robotraconteur/robotraconteur_typescript_node).
