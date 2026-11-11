// Bundle the browser test page so that it can run from a file:// page
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist-test/browser", { recursive: true });
await build({
    entryPoints: ["dist-test/test/browser/smoke.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: "dist-test/browser/smoke.bundle.js",
    // TestVectors.ts uses import.meta only under Node.js. The page gets the blob from vectors.js.
    logOverride: { "empty-import-meta": "silent" }
});
// A file:// page cannot read the test vector blob, so it is embedded in the page as base64
writeFileSync("dist-test/browser/vectors.js", "globalThis.rr_vectors = " + readFileSync("test/fixtures/recorded_vectors.json", "utf8") + ";\n"
    + "globalThis.rr_test_vectors_base64 = " + JSON.stringify(readFileSync("test/data/test_vectors.bin").toString("base64")) + ";\n");
writeFileSync("dist-test/browser/index.html", '<!doctype html><meta charset="utf-8"><title>Robot Raconteur client tests</title><script src="vectors.js"></script><script src="smoke.bundle.js"></script>\n');
