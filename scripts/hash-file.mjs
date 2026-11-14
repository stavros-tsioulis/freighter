#!/usr/bin/env node
// Write the sha256 of a file next to it, as <file>.sha256. The dashboard publishes it for the CLI's update check.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: hash-file.mjs <file>");
  process.exit(2);
}
writeFileSync(`${file}.sha256`, createHash("sha256").update(readFileSync(file)).digest("hex") + "\n");
