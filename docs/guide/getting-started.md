---
title: Getting started
---

# Getting started

`robotraconteur` is a small TypeScript client for [Robot Raconteur](https://github.com/robotraconteur/robotraconteur). It runs in web browsers and in Node.js, connects to services over WebSockets, and has no dependencies. Services can be written in any Robot Raconteur language, such as Python, C++, C#, or [robotraconteur-node](https://github.com/johnwason/robotraconteur_typescript_node) for Node.js.

## Try it with Reynard the Robot

You only need a web browser and Python. No Node.js or TypeScript is required.

1. Install and start [Reynard the Robot](https://github.com/robotraconteur/reynard-the-robot), a cartoon robot made for learning Robot Raconteur:

   ```
   python -m pip install reynard-the-robot
   python -m reynard_the_robot
   ```

2. Open `http://localhost:29201` in a browser to watch Reynard.
3. Download the repository and double click `examples/reynard.html`. Press **Connect**, then try the other buttons. Type a message in Reynard's chat box and it appears on your page through an event.

## In a web page

Copy `examples/robotraconteur.min.js` next to your HTML file and load it with a script tag. Everything is then available under the name `RobotRaconteur`.

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

Open the page by double clicking the file. A page served from a web server must have its origin allowed by the service, as described in [Limits](limits.md).

The word `await` means "wait for the robot to answer", and it can only be used inside a function marked `async`.

## With a bundler or TypeScript

Install the package and import what you need. Bundlers such as Vite, webpack, and esbuild leave out the parts of the library that are not used, such as subscriptions.

```
npm install robotraconteur
```

The package is not on npm yet. Until it is, build it from the repository with `npm run build` and install the folder.

```ts
import { BrowserWebSocketTransport, RobotRaconteurNode } from "robotraconteur";

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));
const reynard = await node.connectService("rr+ws://localhost:29200?service=reynard");
```

Type definitions are included. Values from a service are typed `unknown`, since their types come from the service definition at run time.

## In Node.js

Node.js 22 or newer has the `WebSocket` class the transport uses, so the same code works there. For `rr+tcp`, TLS (`rrs+tcp`), discovery, and services, add the [robotraconteur-node](https://github.com/johnwason/robotraconteur_typescript_node) package. From the repository folder:

```
npm install
npm run build
node examples/reynard.mjs
```

## Next

- [Using a service](using-services.md): properties, functions, generators, objects, events, and callbacks
- [Wires and pipes](wires-and-pipes.md): streaming values and packets
- [Staying connected](subscriptions.md): subscriptions that reconnect
- [Value types](value-types.md): how Robot Raconteur types appear in JavaScript
- [Service definitions](service-definitions.md): parsing and checking `.robdef` files
- [Limits](limits.md): flow control, bundle size, and what is not supported
