import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Manifest } from "@freighter/manifest";
import type { Deps } from "./deps.ts";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const refsEnvPath = (d: Deps, app: string) => `${d.layout.envDir}/${app}.refs.env`;
export const envFilePath = (d: Deps, app: string) => `${d.layout.envDir}/${app}.env`;

async function readLines(d: Deps, app: string): Promise<string[]> {
  try {
    return (await readFile(envFilePath(d, app), "utf8")).split("\n").filter((l) => l !== "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

const envEntry = (key: string, value: string) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Credentials that connections resolved to for this app, in a root-only file the units load next to the secrets. Empty removes it. */
export async function writeRefsEnv(d: Deps, app: string, values: Record<string, string>): Promise<void> {
  const path = refsEnvPath(d, app);
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    await rm(path, { force: true });
    return;
  }
  for (const [k, v] of entries) if (/[\r\n\0]/.test(v)) throw new Error(`illegal newline in ${k}`);
  await mkdir(d.layout.envDir, { recursive: true });
  await writeFile(`${path}.tmp`, entries.map(([k, v]) => envEntry(k, v)).join("\n") + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

const keyOf = (line: string) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];

/** Names only; values are never returned. */
export async function listEnvNames(d: Deps, app: string): Promise<string[]> {
  return (await readLines(d, app)).map(keyOf).filter((k): k is string => k !== undefined).sort();
}

export async function setEnv(d: Deps, app: string, key: string, value: string): Promise<void> {
  if (!KEY_RE.test(key)) throw new Error(`invalid env key "${key}": expected UPPER_SNAKE_CASE`);
  if (/[\r\n\0]/.test(value)) throw new Error("env values cannot contain newlines");
  const entry = envEntry(key, value);
  const lines = (await readLines(d, app)).filter((l) => keyOf(l) !== key);
  lines.push(entry);
  await mkdir(d.layout.envDir, { recursive: true });
  const path = envFilePath(d, app);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

export async function missingSecrets(d: Deps, manifest: Manifest): Promise<string[]> {
  const have = new Set(await listEnvNames(d, manifest.name));
  return manifest.secrets.filter((s) => !have.has(s));
}
