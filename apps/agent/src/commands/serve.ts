import { defineCommand } from "citty";
import { defaultDeps } from "@freighter/core";
import { startAgent } from "../server.ts";
import { CliError, EXIT, commonArgs } from "../lib/cli.ts";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Start the agent: the unix socket and, when configured, the mutual-TLS listener. */
export async function runAgent(prefix?: string): Promise<void> {
  const deps = await defaultDeps({ prefix });
  if (!deps.isRoot) {
    throw new CliError("freighter-agent must run as root (or with --prefix for local development)");
  }

  const agent = await startAgent(deps);
  const remote = agent.remote ? ` and ${agent.remote.host}:${agent.remote.port} (mTLS)` : "";
  console.log(`freighter-agent listening on ${agent.socketPath}${remote}`);

  const shutdown = () => void agent.close().then(() => process.exit(EXIT.ok));
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, shutdown);
}

export const serve = defineCommand({
  meta: { name: "serve", description: "Run the agent: its unix socket and, when enabled, the mutual-TLS listener" },
  args: { ...commonArgs },
  run: ({ args }) => runAgent(args.prefix),
});
