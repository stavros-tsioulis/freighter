import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Manifest } from "@freighter/manifest";
import { envFile, refsEnvFile } from "@freighter/systemd";
import type { Deps } from "./deps.ts";
import { migrateShared } from "./shared.ts";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const envFilePath = (d: Deps, app: string, service: string) => envFile(d.layout, app, service);
export const refsEnvPath = (d: Deps, app: string, service: string) => refsEnvFile(d.layout, app, service);
/** Everything the app keeps in the env directory (a directory with a file or two per service). */
export const appEnvDir = (d: Deps, app: string) => `${d.layout.envDir}/${app}`;

async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

const envEntry = (key: string, value: string) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function writeEnvFile(d: Deps, app: string, path: string, lines: string[]): Promise<void> {
  await mkdir(appEnvDir(d, app), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, lines.join("\n") + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

/** Credentials that connections resolved to for a service, in a root-only file its unit loads next to the secrets. Empty removes it. */
export async function writeRefsEnv(d: Deps, app: string, service: string, values: Record<string, string>): Promise<void> {
  const path = refsEnvPath(d, app, service);
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    await rm(path, { force: true });
    return;
  }
  for (const [k, v] of entries) if (/[\r\n\0]/.test(v)) throw new Error(`illegal newline in ${k}`);
  await writeEnvFile(d, app, path, entries.map(([k, v]) => envEntry(k, v)));
}

const keyOf = (line: string) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];

/** Names only; values are never returned. */
export async function listEnvNames(d: Deps, app: string, service: string): Promise<string[]> {
  await migrateShared(d, app);
  return (await readLines(envFilePath(d, app, service))).map(keyOf).filter((k): k is string => k !== undefined).sort();
}

export async function setEnv(d: Deps, app: string, service: string, key: string, value: string): Promise<void> {
  if (!KEY_RE.test(key)) throw new Error(`invalid env key "${key}": expected UPPER_SNAKE_CASE`);
  if (/[\r\n\0]/.test(value)) throw new Error("env values cannot contain newlines");
  await migrateShared(d, app);
  const path = envFilePath(d, app, service);
  const lines = (await readLines(path)).filter((l) => keyOf(l) !== key);
  lines.push(envEntry(key, value));
  await writeEnvFile(d, app, path, lines);
}

/** Secrets a manifest declares that have no value on the server yet, as `service/KEY`. */
export async function missingSecrets(d: Deps, manifest: Manifest): Promise<string[]> {
  await migrateShared(d, manifest.name, manifest.services);
  const out: string[] = [];
  for (const [service, def] of Object.entries(manifest.services)) {
    const have = new Set(await listEnvNames(d, manifest.name, service));
    for (const key of def.secrets) if (!have.has(key)) out.push(`${service}/${key}`);
  }
  return out;
}
