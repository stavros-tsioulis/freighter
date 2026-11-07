#!/usr/bin/env node
// Bundle a Freighter entry point (TypeScript, with its workspace packages and npm dependencies) into one plain
// JavaScript file that runs with `node`. Usage: node scripts/bundle.mjs <entry.ts> <out.js>
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bundle.mjs <entry.ts> <out.js>");
  process.exit(2);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Run `node --enable-source-maps` to get stack traces in terms of the TypeScript source.
  sourcemap: "linked",
  legalComments: "none",
  // Some bundled CommonJS dependencies call require(); give them one in ESM.
  banner: { js: 'import { createRequire as __freighterRequire } from "node:module"; const require = __freighterRequire(import.meta.url);' },
  logLevel: "warning",
});
