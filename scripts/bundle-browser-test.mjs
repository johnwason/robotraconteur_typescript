// Bundle the browser test page so that it can run from a file:// page
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist-test/browser", { recursive: true });
await build({
    entryPoints: ["dist-test/test/browser/smoke.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: "dist-test/browser/smoke.bundle.js"
});
writeFileSync("dist-test/browser/vectors.js", "globalThis.rr_vectors = " + readFileSync("test/fixtures/recorded_vectors.json", "utf8") + ";\n");
writeFileSync("dist-test/browser/index.html", '<!doctype html><meta charset="utf-8"><title>Robot Raconteur client tests</title><script src="vectors.js"></script><script src="smoke.bundle.js"></script>\n');
