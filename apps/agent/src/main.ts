#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { defineCommand, parseArgs, runCommand, runMain } from "citty";
import { completion, type Tree } from "./commands/completion.ts";
import { enroll } from "./commands/enroll.ts";
import { runAgent, serve } from "./commands/serve.ts";
import { version } from "./commands/version.ts";
import { CLI_VERSION, EXIT, fail, isUsageError } from "./lib/cli.ts";

const completionTree: Tree = { serve: {}, enroll: {}, version: {}, completion: {} };
const rootArguments = {
  prefix: { type: "string", description: "Dev mode: relocate all paths under this dir and skip systemctl/useradd" },
} as const;
const subCommands = {
  serve,
  enroll,
  version,
  completion: completion(completionTree),
};

export const main = defineCommand({
  meta: {
    name: "freighter-agent",
    version: CLI_VERSION,
    description: "Freighter's privileged helper: serve this server's host API and enroll it with a control plane",
  },
  args: rootArguments,
  subCommands,
});

async function cli(rawArgs: string[]): Promise<void> {
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs[0] === "help") {
      const helpArgs = rawArgs[0] === "help" ? [...rawArgs.slice(1), "--help"] : rawArgs;
      await runMain(main, { rawArgs: helpArgs });
      return;
    }
    if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
      console.log(CLI_VERSION);
      return;
    }
    const root = parseArgs<typeof rootArguments>(rawArgs, rootArguments);
    if (root._.length === 0) {
      await runAgent(root.prefix);
      return;
    }
    await runCommand(main, { rawArgs });
  } catch (error) {
    if (isUsageError(error)) {
      process.stderr.write(`error: ${error.message}\n`);
      const words = rawArgs.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ");
      process.stderr.write(`try \`freighter-agent ${words} --help\`\n`);
      process.exit(EXIT.usage);
    }
    fail(error);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await cli(process.argv.slice(2));
