// Build the single file browser version of the library, which is usable with a plain script tag
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
