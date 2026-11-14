import { defineCommand } from "citty";
import { usage } from "../lib/errors.ts";
import { globalArgs, run } from "../lib/run.ts";
import { runRemote } from "../lib/remote.ts";
import { serviceTarget } from "../lib/target.ts";

/** The words after `--`, which are the command (and its arguments) as they are. */
export function afterDashes(rawArgs: string[]): string[] {
  const i = rawArgs.indexOf("--");
  return i < 0 ? [] : rawArgs.slice(i + 1);
}

function variables(value: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value === undefined ? [] : Array.isArray(value) ? value : [value]) {
    const i = pair.indexOf("=");
    if (i < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.slice(0, i))) throw usage(`"${pair}" is not KEY=VALUE`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** The local terminal, for a session on one: raw mode in, its size and its changes. */
function terminal() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    raw: (on: boolean) => process.stdin.setRawMode(on),
    onResize: (cb: (cols: number, rows: number) => void) => {
      const h = () => cb(process.stdout.columns || 80, process.stdout.rows || 24);
      process.stdout.on("resize", h);
      return () => void process.stdout.off("resize", h);
    },
  };
}

async function open(args: Parameters<typeof run>[0] & { target?: string; stdin?: boolean; tty?: boolean; env?: string | string[] }, rawArgs: string[], forceShell: boolean): Promise<void> {
  return run(args, async ({ connection }) => {
    const t = serviceTarget(args.target);
    const command = forceShell ? undefined : afterDashes(rawArgs);
    if (!forceShell && (!command || command.length === 0)) throw usage("which command?", `freighter exec ${t.app}/${t.service} -- <command> [arguments]`);
    const tty = forceShell || !!args.tty;
    if (tty && !(process.stdin.isTTY && process.stdout.isTTY)) throw usage(forceShell ? "a shell needs a terminal" : "-t needs a terminal", forceShell ? "to run one command from a script, use `freighter exec <app/service> -- <command>`" : "leave -t out in a script");
    const c = connection();
    const code = await runRemote({ url: c.url, token: c.token, app: t.app, service: t.service, command, tty, stdin: forceShell || !!args.stdin, env: variables(args.env), terminal: tty ? terminal() : undefined });
    process.exit(code & 0xff || (code === 0 ? 0 : 1));
  });
}

export const exec = defineCommand({
  meta: { name: "exec", description: "Run a command in a service: freighter exec <app/service> [-it] -- <command> [arguments]" },
  args: {
    target: { type: "positional", required: true, description: "app/service" },
    stdin: { type: "boolean", alias: "i", description: "Pass this command's standard input to it" },
    tty: { type: "boolean", alias: "t", description: "Give it a terminal" },
    env: { type: "string", alias: "e", description: "KEY=VALUE for the command, over the service's own (repeatable)" },
    ...globalArgs,
  },
  run: ({ args, rawArgs }) => open(args as never, rawArgs, false),
});

export const shell = defineCommand({
  meta: { name: "shell", description: "An interactive shell in a service" },
  args: { target: { type: "positional", required: true, description: "app/service" }, env: { type: "string", alias: "e", description: "KEY=VALUE for the shell (repeatable)" }, ...globalArgs },
  run: ({ args, rawArgs }) => open(args as never, rawArgs, true),
});

