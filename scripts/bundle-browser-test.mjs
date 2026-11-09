// Bundle the browser smoke test so that it can run from a file:// page
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist-test/browser", { recursive: true });
await build({
    entryPoints: ["dist-test/test/browser/smoke.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: "dist-test/browser/smoke.bundle.js"
});
writeFileSync("dist-test/browser/index.html", '<!doctype html><meta charset="utf-8"><title>Robot Raconteur smoke test</title><script src="smoke.bundle.js"></script>\n');
