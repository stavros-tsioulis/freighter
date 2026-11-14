import { defineCommand } from "citty";
import { resolve } from "node:path";
import { HOST_CONFIG_PATH, loadConfig } from "@freighter/core";
import { enroll as enrollServer } from "../enroll.ts";
import { commonArgs, usage } from "../lib/cli.ts";

const MIN_PORT = 1;
const MAX_PORT = 65535;

export function parseEnrollmentPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw usage(`--port is a port number from ${MIN_PORT} to ${MAX_PORT}`);
  }
  return port;
}

export const enroll = defineCommand({
  meta: { name: "enroll", description: "Connect this server to a control plane over mutual TLS" },
  args: {
    control: {
      type: "string",
      required: true,
      description: "Base URL of the control plane, e.g. https://freighter.example.com",
    },
    token: {
      type: "string",
      required: true,
      description: "The one-time enrollment token",
    },
    "ca-fingerprint": {
      type: "string",
      required: true,
      description: "CA fingerprint shown when the server was added (SHA256:…)",
    },
    port: {
      type: "string",
      description: "Overrides the port suggested by the control plane",
    },
    ...commonArgs,
  },
  run: async ({ args }) => {
    const config = await loadConfig(args.prefix);
    const root = args.prefix ? resolve(args.prefix) : "";
    const result = await enrollServer({
      control: args.control,
      token: args.token,
      caFingerprint: args["ca-fingerprint"],
      certDir: config.agent.remote.certDir,
      configPath: root + HOST_CONFIG_PATH,
      port: parseEnrollmentPort(args.port),
    });
    console.log(
      `enrolled as "${result.name}" (CA ${result.caFingerprint}).\nThe agent will listen on port ${result.port}; restart it: systemctl restart freighter-agent`,
    );
  },
});
