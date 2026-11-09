// Report the minified and gzipped size of the library bundles
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

async function report(label, contents)
{
    const r = await build({
        stdin: { contents, resolveDir: "dist", sourcefile: "entry.js" },
        bundle: true,
        minify: true,
        format: "esm",
        target: "es2020",
        write: false
    });
    const b = r.outputFiles[0].contents;
    console.log(`${label.padEnd(28)} ${String(b.length).padStart(7)} bytes   ${String(gzipSync(b).length).padStart(6)} gzipped`);
}

await report("client (full index)", 'export * from "./index.js";');
await report("parser only", 'export { parseServiceDefinition } from "./ServiceDefinition.js";');
await report("validators", 'export * from "./ServiceDefinitionValidators.js";');
