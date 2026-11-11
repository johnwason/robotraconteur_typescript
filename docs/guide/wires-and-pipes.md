---
title: Wires and pipes
---

# Wires and pipes

Wires and pipes stream data between client and service without a request for each value.

## Wires

A wire always holds the most recent value, and older values are discarded. Use one for things like joint positions or commands, where only the latest value matters.

```js
const wire = await robot.connectWire("robot_state");

// Called on every new value
robot.addWireValueChangedListener(wire, (handle, value, timestamp) => {
    console.log(value.joint_position);
});

// Or read the latest value whenever you need it
if (await robot.waitWireInValueValid(wire, 1000)) {
    console.log(robot.getWireInValue(wire).value);
}

// Send a value to the service, if the wire allows it
robot.setWireOutValue(wire, value);

await robot.closeWire(wire);
```

Each value has a {@link robotraconteur!TimeSpec | TimeSpec} timestamp from the sender's clock, and older values that arrive after newer ones are dropped. A value can be given a lifespan with `setWireInValueLifespan` and `setWireOutValueLifespan`, after which it no longer counts as valid.

A wire marked `readonly` in the service definition only sends values to the client, and one marked `writeonly` only receives them. `getWireDirection` reports which.

For a single value, `peekWireInValue`, `peekWireOutValue`, and `pokeWireOutValue` read and write the wire without connecting it.

Other wire functions of {@link robotraconteur!ServiceStub | ServiceStub} are `tryGetWireInValue`, `getWireOutValue`, `tryGetWireOutValue`, `isWireInValueValid`, `isWireOutValueValid`, `waitWireOutValueValid`, `setWireIgnoreInValue`, `removeWireValueChangedListener`, and `setWireCloseCallback`.

## Pipes

A pipe delivers every packet in order. Use one when no packet may be lost.

```js
const pipe = await robot.connectPipe("name");

// Await each send so that you do not outrun the connection
await robot.sendPipePacket(pipe, value);

// Wait up to one second for the next packet
const packet = await robot.receivePipePacketWait(pipe, 1000);

await robot.closePipe(pipe);
```

Packets wait in a queue until you read them, up to 65536 packets by default (`setPipeMaxReceiveQueue`). If the queue overflows, the pipe closes rather than silently losing data. Packets are acknowledged when your code takes them, so services that use acknowledgements slow down to the rate you read.

A pipe can have several endpoints, selected by the index passed to `connectPipe`. The default of -1 lets the service choose one. A pipe marked `unreliable` may lose packets or deliver them out of order, in exchange for lower latency.

Other pipe functions are `receivePipePacket`, `peekPipePacket`, `peekPipePacketWait`, `tryReceivePipePacketWait`, `getPipePacketsAvailable`, `setPipeRequestPacketAck`, `setPipeIgnoreInValue`, `addPipePacketReceivedListener`, `addPipePacketAckListener`, `setPipeCloseCallback`, `getPipeDirection`, and `isPipeUnreliable`.

## When the connection ends

Wires and pipes close when the client disconnects or the connection is lost, and their close callbacks are called. A [subscription](subscriptions.md) reconnects them automatically.
