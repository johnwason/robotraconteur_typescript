// Build the single file browser version of the library, which is usable with a plain script tag
// It is written to examples for pages in this repository, and to dist for the npm package, from
// which CDNs such as jsDelivr serve it
import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
    stdin: { contents: 'export * from "./index.js";', resolveDir: "dist", sourcefile: "entry.js" },
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "RobotRaconteur",
    target: "es2020",
    outfile: "examples/robotraconteur.min.js"
});
await copyFile("examples/robotraconteur.min.js", "dist/robotraconteur.min.js");
