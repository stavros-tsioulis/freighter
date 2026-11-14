import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Connection {
  url: string;
  token: string;
  /** Where it came from, for messages. */
  source: string;
}

interface CliConfig {
  current?: string;
  contexts?: Record<string, { url: string; token: string }>;
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Which Freighter to talk to: `FREIGHTER_URL` and `FREIGHTER_TOKEN`, else the context the `freighter` CLI is signed in to
 * (`freighter login`), so a person who uses the CLI has nothing more to set up. Read each time it is needed, so signing in
 * again takes effect without restarting the server.
 */
export function resolveConnection(env: NodeJS.ProcessEnv = process.env): Connection {
  if (env.FREIGHTER_URL && env.FREIGHTER_TOKEN) return { url: clean(env.FREIGHTER_URL), token: env.FREIGHTER_TOKEN, source: "FREIGHTER_URL and FREIGHTER_TOKEN" };
  const path = env.FREIGHTER_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "freighter", "config.json");
  let config: CliConfig = {};
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    /* no CLI sign-in */
  }
  const name = env.FREIGHTER_CONTEXT ?? config.current;
  const context = name ? config.contexts?.[name] : undefined;
  if (context) return { url: clean(env.FREIGHTER_URL ?? context.url), token: env.FREIGHTER_TOKEN ?? context.token, source: `the freighter CLI's context "${name}"` };
  throw new Error("Not connected to a Freighter. Set FREIGHTER_URL and FREIGHTER_TOKEN in the MCP server's environment, or sign in with `freighter login <url>` so its context can be used.");
}
