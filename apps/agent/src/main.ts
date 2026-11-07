#!/usr/bin/env node
import { resolve } from "node:path";
import { HOST_CONFIG_PATH, defaultDeps, loadConfig } from "@freighter/core";
import { enroll } from "./enroll.ts";
import { startAgent } from "./server.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const prefix = arg("--prefix");

if (process.argv[2] === "enroll") {
  const control = arg("--control");
  const token = arg("--token");
  const caFingerprint = arg("--ca-fingerprint");
  if (!control || !token || !caFingerprint) {
    console.error("usage: freighter-agent enroll --control https://HOST --token TOKEN --ca-fingerprint SHA256:… [--port 7443] [--prefix DIR]");
    process.exit(2);
  }
  try {
    const config = await loadConfig(prefix);
    const root = prefix ? resolve(prefix) : "";
    const r = await enroll({
      control, token, caFingerprint,
      certDir: config.agent.remote.certDir,
      configPath: root + HOST_CONFIG_PATH,
      port: arg("--port") ? Number(arg("--port")) : undefined,
    });
    console.log(`enrolled as "${r.name}" (CA ${r.caFingerprint}).\nThe agent will listen on port ${r.port}; restart it: systemctl restart freighter-agent`);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
} else {
  const deps = await defaultDeps({ prefix });
  if (!deps.isRoot) {
    console.error("freighter-agent must run as root (or with --prefix for local development)");
    process.exit(1);
  }
  const agent = await startAgent(deps);
  console.log(`freighter-agent listening on ${agent.socketPath}${agent.remote ? ` and ${agent.remote.host}:${agent.remote.port} (mTLS)` : ""}`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void agent.close().then(() => process.exit(0)));
  }
}
