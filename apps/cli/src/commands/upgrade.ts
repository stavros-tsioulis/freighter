import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { CliError } from "../lib/errors.ts";
import { globalArgs, run } from "../lib/run.ts";
import { clearCache, hashOf, installedPath, latestHash, ownHash, writeCache } from "../lib/update.ts";

const short = (h: string | null) => (h ? h.slice(0, 7) : "unknown");

export const upgrade = defineCommand({
  meta: { name: "upgrade", description: "Replace this CLI with the one the control server serves" },
  args: { check: { type: "boolean", description: "Only say whether a newer one is served; install nothing" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, connection }) => {
      const url = connection().url;
      const path = installedPath();
      if (!path) throw new CliError("this copy of freighter wasn't installed by the installer, so it can't replace itself", 1, `install it again: curl -fsSL ${url}/install-cli | sh`);
      const latest = await latestHash(url, 8000);
      if (!latest) throw new CliError(`${url} doesn't serve a CLI`, 1, "it may be older than this CLI, or not a Freighter dashboard");
      const current = ownHash(path);

      if (current === latest) {
        clearCache();
        return out.data({ upToDate: true, current }, () => out.line(`freighter is up to date (${short(current)}).`));
      }
      writeCache({ checkedAt: Date.now(), url, latest });
      if (args.check) {
        return out.data({ upToDate: false, updateAvailable: true, current, latest }, () => out.line(`A newer freighter is available (${short(current)} -> ${short(latest)}). Run: freighter upgrade`));
      }

      const res = await fetch(`${url}/cli/freighter.mjs`).catch((e) => {
        throw new CliError(`cannot reach ${url}: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!res.ok) throw new CliError(`${url} doesn't serve a CLI (${res.status})`);
      const next = Buffer.from(await res.arrayBuffer());
      // what arrived has to be what the server says it serves, and has to start: only then does it take the old one's place
      if (hashOf(next) !== latest) throw new CliError("what the server sent doesn't match the checksum it publishes; nothing was changed");
      const tmp = path.replace(/\.mjs$/, ".new.mjs"); // still .mjs, or Node would not read it as a module
      try {
        writeFileSync(tmp, next, { mode: statSync(path).mode });
        chmodSync(tmp, 0o755);
        const smoke = spawnSync(process.execPath, [tmp, "--help"], { encoding: "utf8", timeout: 15_000 });
        if (smoke.status !== 0) throw new CliError("the new freighter did not start; nothing was changed", 1, smoke.stderr?.split("\n")[0]);
        try {
          copyFileSync(path, `${path}.prev`); // one step back, if it is ever needed
        } catch {
          /* best effort */
        }
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
      clearCache();
      out.data({ upToDate: true, from: current, to: latest, path }, () => out.line(`Upgraded freighter (${short(current)} -> ${short(latest)}). The previous one is kept as ${path}.prev.`));
    }),
});

/** Run in the background by an ordinary command, at most daily: finds out what the server serves and writes it down for next time. */
export const updateCheck = defineCommand({
  meta: { name: "__update-check", description: "(internal) look for a newer CLI" },
  args: { url: { type: "positional", required: true } },
  run: async ({ args }) => {
    writeCache({ checkedAt: Date.now(), url: args.url, latest: await latestHash(args.url, 5000) });
  },
});
