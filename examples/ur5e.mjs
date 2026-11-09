// Moves a UR5e robot in the Robot Raconteur Training Simulator from Node.js 22 or newer.
// See https://github.com/robotraconteur-contrib/robotraconteur_training_sim
//
// 1. In the repository folder, run:   npm install
//                                     npm run build
// 2. Start the UR5e scene of the training simulator
// 3. Run this example:                node examples/ur5e.mjs

import { BrowserWebSocketTransport, RobotRaconteurNode } from "../dist/index.js";

// Values of RobotCommandMode from the com.robotraconteur.robotics.robot service definition
const HALT = 0;
const JOG = 1;
const TRAJECTORY = 2;

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The robot must go through halt to change command modes
async function setCommandMode(robot, mode) {
    await robot.setProperty("command_mode", HALT);
    await sleep(100);
    await robot.setProperty("command_mode", mode);
}

async function getJointPositions(robot) {
    const result = await robot.peekWireInValue("robot_state");
    return result.value.joint_position;
}

const node = new RobotRaconteurNode();
node.registerTransport(new BrowserWebSocketTransport(node));

const robot = await node.connectService("rr+ws://localhost:52511?service=robot");

const start = await getJointPositions(robot);
console.log("Starting joint positions:", start);

// Move the first joint in a sine wave for five seconds
await setCommandMode(robot, JOG);
const maxVelocity = [1, 1, 1, 1, 1, 1];
for (let i = 0; i < 50; i++) {
    const target = Array.from(start);
    target[0] = start[0] + 0.2 * Math.sin(i / 10);
    await robot.callFunction("jog_freespace", [target, maxVelocity, true]);
    await sleep(100);
}

// Return to the starting position using a trajectory
await setCommandMode(robot, TRAJECTORY);

function waypoint(time, jointPosition) {
    return {
        time_from_start: time,
        joint_position: jointPosition,
        joint_velocity: [],
        position_tolerance: [],
        velocity_tolerance: [],
        interpolation_mode: 0,
        waypoint_type: 0
    };
}

const robotInfo = await robot.getProperty("robot_info");
const jointNames = robotInfo.joint_info.map((joint) => joint.joint_identifier.name);
const current = await getJointPositions(robot);

// Interpolate to the starting position over five seconds. The simulator requires
// at least five waypoints, no more than 100 ms apart. The cosine blend starts and
// stops the motion smoothly.
const waypoints = [];
const steps = 100;
for (let i = 0; i <= steps; i++) {
    const blend = (1 - Math.cos((Math.PI * i) / steps)) / 2;
    const position = Array.from(current, (value, joint) => value + blend * (start[joint] - value));
    waypoints.push(waypoint((5 * i) / steps, position));
}

const trajectory = {
    joint_names: jointNames,
    joint_units: null,
    waypoints: waypoints,
    extended: null
};

// execute_trajectory is a generator: call Next repeatedly until it reports that it is finished
const generator = await robot.callFunction("execute_trajectory", [trajectory]);
try {
    while (true) {
        const status = await robot.callFunctionGenNext(generator);
        console.log("Trajectory time:", status.trajectory_time);
    }
} catch (error) {
    if (!error.isStopIteration) {
        throw error;
    }
}

console.log("Finished");
await node.disconnectService(robot);
