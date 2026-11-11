---
title: Staying connected
---

# Staying connected

Networks fail and robots restart. A {@link robotraconteur!ServiceSubscription | ServiceSubscription} connects to a service and reconnects whenever the connection is lost, including its wires and pipes. Use one for anything that should keep running.

```js
const subscription = subscribeService(node, "rr+ws://localhost:29200?service=reynard");

// A wire subscription always holds the most recent value from the service
const state = subscription.subscribeWire("state");
await state.waitInValueValid();
console.log(state.getInValue().value.robot_position);

subscription.addClientConnectListener(() => console.log("Connected"));
subscription.addClientDisconnectListener(() => console.log("Connection lost"));

// Ask for the client each time it is needed, because reconnecting replaces it
const reynard = await subscription.getDefaultClientWait(5000);
await reynard.callFunction("say", ["Hello!"]);

subscription.close();
```

With the script tag, the function is `RobotRaconteur.subscribeService`. Several URLs for one service can be passed as an array.

## What a subscription offers

| Object | Functions |
| --- | --- |
| {@link robotraconteur!ServiceSubscription | ServiceSubscription} | `getDefaultClient`, `tryGetDefaultClient`, `getDefaultClientWait(timeoutMs)`, `tryGetDefaultClientWait(timeoutMs)`, `getConnectedClients`, `subscribeWire(name, servicePath?)`, `subscribePipe(name, servicePath?, maxRecvPackets?, maxSendBacklog?)`, `subscribeSubObject(servicePath)`, `claimClient`, `releaseClient`, `getServiceURL`, `updateServiceURL`, `close`, `connectRetryDelay`, and add and remove functions for `ClientConnect`, `ClientDisconnect`, and `ClientConnectFailed` listeners |
| {@link robotraconteur!WireSubscription | WireSubscription} | `getInValue`, `tryGetInValue`, `inValueValid`, `waitInValueValid(timeoutMs)`, `setOutValueAll(value)`, `inValueLifespan`, `ignoreInValue`, `activeConnectionCount`, `addWireValueChangedListener`, `removeWireValueChangedListener`, `close` |
| {@link robotraconteur!PipeSubscription | PipeSubscription} | `receivePacket`, `tryReceivePacket`, `tryReceivePacketWait(timeoutMs, peek?)`, `available`, `sendPacketAll(value)`, `ignoreReceived`, `activeConnectionCount`, `addPipePacketReceivedListener`, `removePipePacketReceivedListener`, `close` |
| {@link robotraconteur!SubObjectSubscription | SubObjectSubscription} | `getDefaultClient`, `tryGetDefaultClient`, `getDefaultClientWait(timeoutMs)`, `tryGetDefaultClientWait(timeoutMs)` |

A `servicePath` such as `"*.arm"` names an object below the root object. A connection is retried every 2.5 seconds by default, and `connectRetryDelay` changes this.

Wire values are the latest available, so nothing is lost by reconnecting. Pipe packets sent while disconnected are lost, and a pipe subscription keeps every packet until read unless `maxRecvPackets` is set, in which case the oldest packets are dropped.

`claimClient` takes a client from the subscription, so that closing the subscription leaves it connected. `releaseClient` gives it back.

## Finding services by type

A subscription by URL needs no discovery. To subscribe to every service of a type on the network, use discovery from the [robotraconteur-node](https://github.com/robotraconteur/robotraconteur_typescript_node) package. Browsers cannot send the UDP packets discovery uses.
