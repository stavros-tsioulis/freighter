import { chmodSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { CliError } from "../lib/errors.ts";
import { globalArgs, run } from "../lib/run.ts";

export const upgrade = defineCommand({
  meta: { name: "upgrade", description: "Replace this CLI with the one the control server serves" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, connection }) => {
      const here = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : "";
      if (!here.endsWith(".mjs")) throw new CliError("this copy of freighter wasn't installed by the installer, so it can't replace itself", 1, "install it again: curl -fsSL <your Freighter>/install-cli | sh");
      const res = await fetch(`${connection().url}/cli/freighter.mjs`).catch((e) => {
        throw new CliError(`cannot reach ${connection().url}: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!res.ok) throw new CliError(`${connection().url} doesn't serve a CLI (${res.status})`);
      const next = Buffer.from(await res.arrayBuffer());
      if (next.length < 1000) throw new CliError("what the server sent isn't a CLI");
      const tmp = `${here}.tmp`;
      writeFileSync(tmp, next, { mode: statSync(here).mode });
      chmodSync(tmp, 0o755);
      renameSync(tmp, here);
      out.data({ path: here, bytes: next.length }, () => out.line(`Replaced ${here} with the CLI from ${connection().url}.`));
    }),
});
