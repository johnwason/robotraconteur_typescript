---
title: Limits
---

# Limits

## What is not supported

* Client only. Services are written with [robotraconteur-node](https://github.com/robotraconteur/robotraconteur_typescript_node).
* Message Format Version 2. Message Version 4 is not offered during connection.
* Only `rr+ws` and `rr+wss` connections through the `WebSocket` class. `tcp` and `rr+tcp` URLs are converted to WebSocket connections, matching RobotRaconteurWeb. robotraconteur-node adds `rr+tcp` and `rrs+tcp`.
* Memories and `rrs+` end-to-end encryption are not implemented.
* Discovery is in robotraconteur-node, since browsers cannot use UDP.
* Assumes a little-endian host, which covers browser platforms.

## Browser origins

Browsers send the origin of the page with each WebSocket, and services must allow it. Pages loaded from `file://` and `robotraconteur.com` are allowed by default. Other origins, including `http://localhost`, must be added on the service with `AddWebSocketAllowedOrigin` or a command line option, for example:

```
python -m reynard_the_robot --robotraconteur-tcp-ws-add-origins=http://localhost:8000
```

Node.js clients do not send an origin.

## Flow control

Sending never builds up an unbounded backlog of stale data. One message is sent at a time, and a newer wire packet replaces one still waiting, as in the other Robot Raconteur implementations.

Where the browser provides `WebSocketStream`, currently Chromium based browsers, it is used to apply backpressure in both directions. Elsewhere, including Node.js, the library falls back to `WebSocket` and polls how much data is waiting to be sent. `WebSocket` cannot slow down incoming data, so with the fallback a page that cannot keep up will buffer received messages in the browser. Set `useWebSocketStream` to `false` on {@link robotraconteur!BrowserWebSocketTransport | BrowserWebSocketTransport} to always use `WebSocket`.

## Bundle size

| Bundle | Minified | Gzipped |
| --- | --- | --- |
| Client, as in `robotraconteur.min.js` | 79.3 KB | 22.8 KB |
| Client without subscriptions, when bundled and unused | 65.1 KB | 19.3 KB |
| Parser only | 7.2 KB | 2.7 KB |
| Validators | 11.2 KB | 4.1 KB |

Run `npm run size` to regenerate these numbers.
