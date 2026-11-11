---
title: Using a service
---

# Using a service

A {@link robotraconteur!RobotRaconteurNode | RobotRaconteurNode} holds the transports and connections of a program. Register a transport, then connect with a URL. The result is a {@link robotraconteur!ServiceStub | ServiceStub} for the root object of the service, and members are used by the names in the service definition.

```js
const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));
const robot = await node.connectService("rr+ws://localhost:29200?service=reynard");
```

## Connecting

A URL names the scheme, host, port, and service, such as `rr+ws://localhost:29200?service=reynard`. Add `nodeid=` or `nodename=` to require a particular node. `rr+wss` uses TLS through the browser, as for a web site.

Several URLs for one service can be passed as an array. As in Core, the preferred URL is tried first and each of the others 15 ms later, and the first to connect is used. {@link robotraconteur!RobotRaconteurNode.selectRemoteNodeURL | RobotRaconteurNode.selectRemoteNodeURL} gives the order.

If a service requires a login, pass the user name and credentials:

```js
const credentials = new Map([["password", new RobotRaconteur.VarValue("secret", "string")]]);
const robot = await node.connectService(url, "username", credentials);
```

To use the root object as a type it implements, rather than its own type, pass the type as the last argument.

When finished, `await node.disconnectService(robot)`, or `await node.shutdown()` to close everything.

## What you can do with a connected object

| To do this | Write this |
| --- | --- |
| Read a property | `await robot.getProperty("name")` |
| Set a property | `await robot.setProperty("name", value)` |
| Call a function | `await robot.callFunction("name", [first, second])` |
| Call with named parameters | `await robot.callFunction("name", { a: 1, b: 2 })` |
| Get a sub-object | `await robot.getObjRef("name")`, or `await robot.getObjRef("name", index)` |
| Read a wire's latest value | `(await robot.peekWireInValue("name")).value` |
| Read a wire's output value | `(await robot.peekWireOutValue("name")).value` |
| Set a wire's output value | `await robot.pokeWireOutValue("name", value)` |
| Start a generator | `const gen = await robot.callGenerator("name", [first])` |
| Read every value of a generator | `for await (const value of gen) { ... }` |
| Step a generator | `await robot.callFunctionGenNext(gen, param)` |
| Finish or abort a generator | `await robot.callFunctionGenClose(gen)` or `await robot.callFunctionGenAbort(gen)` |
| Stream a wire | `const wire = await robot.connectWire("name")` |
| Connect a pipe | `const pipe = await robot.connectPipe("name")` |
| Listen for an event | `robot.addEventListener("name", (first, second) => { ... })` |
| Stop listening | `robot.removeEventListener("name", handler)` |
| Let the service call your code | `robot.setCallback("name", (first, second) => result)` |
| Create a structure with default values | `newStructure(robot, "type.name")` |
| Get constants and enums | `getConstants(robot, "service.definition.name")` |

The names come from the service definition, which the client receives when it connects. Plain arrays of numbers such as `[1, 0, 0]` can be used anywhere an array is expected. See [Value types](value-types.md).

## Generators

A generator function returns a {@link robotraconteur!GeneratorHandle | GeneratorHandle}, which produces values one at a time. Most generators can be read with `for await`, and leaving the loop early closes the generator:

```js
for await (const value of await robot.callGenerator("trajectory", [points])) {
    console.log(value);
}
```

A generator that takes a value at each step is stepped with `callFunctionGenNext(gen, param)`. At the end, the service reports `StopIteration`, which {@link robotraconteur!RobotRaconteurError.isStopIteration | RobotRaconteurError.isStopIteration} identifies.

## Events and callbacks

Event handlers receive the event's parameters. Callbacks are functions the service calls on the client. A callback may return a value or a promise, and an error it throws is returned to the service.

```js
robot.addEventListener("new_message", (message) => console.log(message));
robot.setCallback("confirm", async (question) => window.confirm(question));
```

Handlers run as messages arrive, so long running work should be moved out of them. An error in one handler does not affect the others or the connection.

## Errors

Failures reject with a {@link robotraconteur!RobotRaconteurError | RobotRaconteurError}. Its `errorName` identifies the error, such as `RobotRaconteur.InvalidArgument` or an exception from the service definition, and the service may add `errorSubName` and `errorParam`. Requests time out after {@link robotraconteur!RobotRaconteurNode.requestTimeout | RobotRaconteurNode.requestTimeout} milliseconds, 15 seconds by default.

## Constants, enums, and structures

{@link robotraconteur!getConstants | getConstants} returns the constants and enums of a service definition, so that code does not repeat their values. {@link robotraconteur!newStructure | newStructure} returns a structure with every field set to its default, ready to fill in and send.

```js
const c = getConstants(robot, "com.robotraconteur.robotics.robot");
await robot.setProperty("command_mode", c.RobotCommandMode.jog);
```
