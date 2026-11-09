// Controls Reynard the Robot from Node.js 22 or newer.
//
// 1. In the repository folder, run:   npm install
//                                     npm run build
// 2. Start Reynard:                   python -m reynard_the_robot
// 3. Run this example:                node examples/reynard.mjs

import { BrowserWebSocketTransport, RobotRaconteurNode } from "../dist/index.js";

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));

const reynard = await node.connectService("rr+ws://localhost:29200?service=reynard");

// Read the latest value of the "state" wire
const result = await reynard.peekWireInValue("state");
console.log("Robot position:", result.value.robot_position);

// Move the robot to a position
await reynard.callFunction("teleport", [0.1, -0.2]);

// Drive for one second: drive_robot(vel_x, vel_y, timeout, wait)
await reynard.callFunction("drive_robot", [0.5, -0.2, 1, true]);

// Move the arm. Joint angles are in radians
await reynard.callFunction("setf_arm_position", [1.0, -0.5, -1.0]);

// Set and read a property
await reynard.setProperty("color", [1, 0, 0]);
console.log("Color:", await reynard.getProperty("color"));
await reynard.setProperty("color", [0.929, 0.49, 0.192]);

await reynard.callFunction("say", ["Hello from Node.js!"]);

await node.disconnectService(reynard);
