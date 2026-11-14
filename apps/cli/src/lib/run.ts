import { Api } from "./api.ts";
import { resolveConnection, type Connection, type ConnectionArgs } from "./config.ts";
import { CliError, EXIT } from "./errors.ts";
import { Out, type OutArgs } from "./out.ts";

/** The options every command takes (docs/cli: "Options every command has"). Spread into a command's `args`. */
export const globalArgs = {
  context: { type: "string", alias: "c", description: "Use this context for this command ($FREIGHTER_CONTEXT)" },
  url: { type: "string", description: "Use this Freighter instead of a context ($FREIGHTER_URL)" },
  token: { type: "string", description: "Use this API token instead of a context ($FREIGHTER_TOKEN)" },
  json: { type: "boolean", description: "Print JSON, for scripts" },
  quiet: { type: "boolean", alias: "q", description: "Print only what a script needs" },
  yes: { type: "boolean", alias: "y", description: "Don't ask before something that can't be undone" },
  color: { type: "boolean", default: true, description: "Color the output (--no-color for plain text)" },
} as const;

export type GlobalArgs = ConnectionArgs & OutArgs;

export interface Ctx<A> {
  args: A;
  out: Out;
  /** The API of the Freighter this command talks to. Throws "not signed in" if there is none. */
  api(): Api;
  connection(): Connection;
}

/** What the exit code is called in `--json` errors. */
const NAMES: Record<number, string> = { [EXIT.failed]: "failed", [EXIT.usage]: "usage", [EXIT.auth]: "unauthorized", [EXIT.notFound]: "not_found", [EXIT.deployFailed]: "deploy_failed", [EXIT.interrupted]: "interrupted" };

/** Print a failure the way the options ask for, and end with its exit code. */
export function fail(e: unknown, out: Out): never {
  const err = e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e));
  if (out.json) process.stderr.write(JSON.stringify({ error: { code: NAMES[err.code] ?? "failed", message: err.message } }) + "\n");
  else {
    process.stderr.write(`${out.paint("red", "error:")} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${out.paint("dim", err.hint)}\n`);
  }
  process.exit(err.code);
}

/** Run a command's body with its output and API ready, and turn any failure into a one-line error and the right exit code. */
export async function run<A extends GlobalArgs>(args: A, body: (c: Ctx<A>) => Promise<void> | void): Promise<void> {
  const out = new Out(args);
  let conn: Connection | undefined;
  let api: Api | undefined;
  const connection = () => (conn ??= resolveConnection(args));
  try {
    await body({ args, out, connection, api: () => (api ??= new Api(connection().url, connection().token)) });
  } catch (e) {
    fail(e, out);
  }
}
