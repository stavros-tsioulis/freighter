import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Run } from "@freighter/systemd";

export interface HaproxyConfig {
  dir: string;
  mainConfig: string;
  bin: string;
  reloadCommand: string[];
}

export interface HaproxyFiles {
  hostnameMap: string;
  httpsMap: string;
  backends: string;
}

export interface Haproxy {
  /** Write the managed files, validate the whole config, then reload. Restores the old files if validation fails. */
  apply(files: HaproxyFiles): Promise<{ changed: boolean }>;
  reload(): Promise<void>;
}

const NAMES = { hostnameMap: "hostnames.map", httpsMap: "https.map", backends: "backends.cfg" } as const;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeAtomic(path: string, content: string) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export function createHaproxy({ run, config }: { run: Run; config: HaproxyConfig }): Haproxy {
  const path = (k: keyof HaproxyFiles) => `${config.dir}/${NAMES[k]}`;

  async function reload() {
    const [cmd, ...args] = config.reloadCommand;
    const r = await run(cmd!, args);
    if (r.code !== 0) throw new Error(`haproxy reload failed (exit ${r.code}): ${(r.stderr ?? r.stdout).trim()}`);
  }

  return {
    reload,
    async apply(files) {
      await mkdir(`${config.dir}/certs`, { recursive: true });
      const keys = Object.keys(NAMES) as (keyof HaproxyFiles)[];
      const old = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await readOrNull(path(k))] as const)));
      if (keys.every((k) => old[k] === files[k])) return { changed: false };

      for (const k of keys) await writeAtomic(path(k), files[k]);
      const check = await run(config.bin, ["-c", "-f", config.mainConfig, "-f", path("backends")]);
      if (check.code !== 0) {
        for (const k of keys) {
          if (old[k] === null) await rm(path(k), { force: true });
          else await writeAtomic(path(k), old[k]!);
        }
        throw new Error(`haproxy config check failed (exit ${check.code}): ${(check.stderr ?? check.stdout).trim()}`);
      }
      await reload();
      return { changed: true };
    },
  };
}
