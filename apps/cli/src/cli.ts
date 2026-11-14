#!/usr/bin/env node
import { defineCommand, runCommand, showUsage } from "citty";
import { context, login, logout, whoami } from "./commands/auth.ts";
import { audit, cert, registry, sshKey, sync, token } from "./commands/access.ts";
import { app, logs, ps, restart, start, stats, stop } from "./commands/apps.ts";
import { config, domain, git, secret, variable, volume } from "./commands/configure.ts";
import { deploy, redeploy, rollback } from "./commands/deploy.ts";
import { deployment, project, release } from "./commands/deployments.ts";
import { exec, shell } from "./commands/exec.ts";
import { file } from "./commands/files.ts";
import { firewall, process_, server, settings } from "./commands/servers.ts";
import { storage } from "./commands/storage.ts";
import { completion } from "./commands/completion.ts";
import { updateCheck, upgrade } from "./commands/upgrade.ts";
import { version } from "./commands/version.ts";
import { validate } from "./lib/manifest-cmds.ts";
import { resolveConnection } from "./lib/config.ts";
import { CliError, EXIT } from "./lib/errors.ts";
import { notice, ownHash, readCache, refreshInBackground, wantsCheck } from "./lib/update.ts";

const main: ReturnType<typeof defineCommand> = defineCommand({
  meta: { name: "freighter", description: "Run your Freighter from a terminal" },
  subCommands: { login, logout, whoami, context, version, app, ps, start, stop, restart, logs, stats, release, deployment, project, deploy, redeploy, rollback, config, var: variable, secret, domain, volume, git, server, firewall, file, process: process_, settings, storage, token, "ssh-key": sshKey, registry, cert, audit, sync, exec, shell, validate, host: () => import("./commands/host.ts").then((m) => m.host), upgrade, "__update-check": updateCheck, completion: completion(() => main) },
});

/** citty reports a misused command with one of its own errors: that is exit code 2 here, with the command's usage. */
const isUsageError = (e: unknown): e is Error & { code: string } => e instanceof Error && e.name === "CLIError";

const rawArgs = process.argv.slice(2);

// An installed CLI that knows what its server serves says so, once, when there is something newer: the answer comes
// from a look made in the background (at most daily) on an earlier run, so a command is never slowed down by it.
if (wantsCheck(rawArgs)) {
  try {
    const url = resolveConnection({}).url;
    const own = ownHash();
    if (own) {
      const cache = readCache();
      refreshInBackground(url, cache);
      const message = notice(own, cache, url);
      if (message) process.on("exit", () => process.stderr.write(`\n${message}\n`));
    }
  } catch {
    /* not signed in, or no config: nothing to check against */
  }
}
try {
  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h" || rawArgs[0] === "help") {
    await showUsage(main);
  } else {
    await runCommand(main, { rawArgs });
  }
} catch (e) {
  if (isUsageError(e)) {
    process.stderr.write(`error: ${e.message}\n`);
    process.stderr.write(`try \`freighter ${rawArgs.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} --help\`\n`);
    process.exit(EXIT.usage);
  }
  if (e instanceof CliError) {
    process.stderr.write(`error: ${e.message}\n${e.hint ? `${e.hint}\n` : ""}`);
    process.exit(e.code);
  }
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(EXIT.failed);
}
