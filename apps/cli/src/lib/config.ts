import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT } from "./errors.ts";

/** One Freighter to talk to: where it is, the token that signs in, and who that token is (as last checked). */
export interface Context {
  url: string;
  token: string;
  user?: string;
  role?: string;
}

export interface ConfigFile {
  current?: string;
  contexts: Record<string, Context>;
}

/** `$FREIGHTER_CONFIG`, else `$XDG_CONFIG_HOME/freighter/config.json`, else `~/.config/freighter/config.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FREIGHTER_CONFIG) return env.FREIGHTER_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "freighter", "config.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigFile {
  const path = configPath(env);
  if (!existsSync(path)) return { contexts: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigFile>;
    return { current: raw.current, contexts: raw.contexts ?? {} };
  } catch {
    throw new CliError(`cannot read ${path}: it is not valid JSON`, EXIT.failed, "fix or delete it, then sign in again with `freighter login`");
  }
}

/** Written readable by the owner only: it holds tokens. */
export function writeConfig(config: ConfigFile, env: NodeJS.ProcessEnv = process.env): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface ConnectionArgs {
  context?: string;
  url?: string;
  token?: string;
}

export interface Connection {
  url: string;
  token: string;
  /** The context it came from; none when the URL and token were given directly. */
  context?: string;
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Where to connect, in order: `--url` and `--token`, then `$FREIGHTER_URL` and `$FREIGHTER_TOKEN`, then the context named by
 * `--context` or `$FREIGHTER_CONTEXT`, then the current one. A URL without a token uses the token saved for that same URL, and is
 * refused otherwise, so a saved token never goes to another Freighter.
 */
export function resolveConnection(args: ConnectionArgs, env: NodeJS.ProcessEnv = process.env): Connection {
  const url = args.url ?? env.FREIGHTER_URL;
  const token = args.token ?? env.FREIGHTER_TOKEN;
  if (url && token) return { url: clean(url), token };
  const config = readConfig(env);
  const name = args.context ?? env.FREIGHTER_CONTEXT ?? config.current;
  const context = name ? config.contexts[name] : undefined;
  if (name && !context) throw new CliError(`no context named "${name}"`, EXIT.notFound, `see \`freighter context list\`${Object.keys(config.contexts).length ? "" : ", or sign in with `freighter login <url>`"}`);
  if (url && !token) {
    // a saved token is only ever sent to the Freighter it was saved for
    const known = Object.entries(config.contexts).find(([, c]) => clean(c.url) === clean(url));
    if (known) return { url: clean(url), token: known[1].token, context: known[0] };
    throw new CliError(`--url needs a token for ${clean(url)}`, EXIT.auth, "pass --token or set FREIGHTER_TOKEN, or sign in with `freighter login`");
  }
  if (!context) throw new CliError("not signed in", EXIT.auth, "run `freighter login <url>`, or set FREIGHTER_URL and FREIGHTER_TOKEN");
  return { url: clean(context.url), token: token ?? context.token, context: name };
}
