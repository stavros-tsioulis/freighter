import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.ts";

/**
 * The control server publishes the sha256 of the CLI it serves (`/cli/freighter.mjs.sha256`). An installed CLI is that
 * same file, so it knows whether it is current by hashing itself: no version numbers to keep in step.
 */
export const SHA_RE = /^[0-9a-f]{64}$/;

/** The installed copy of this CLI, or null when it runs some other way (from a checkout, say). */
export function installedPath(argv1: string | undefined = process.argv[1]): string | null {
  if (!argv1) return null;
  const path = argv1.startsWith("file:") ? fileURLToPath(argv1) : argv1;
  return path.endsWith(".mjs") ? path : null;
}

export function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function ownHash(path = installedPath()): string | null {
  return path && existsSync(path) ? hashOf(readFileSync(path)) : null;
}

/** The hash of the CLI a Freighter serves, or null when it doesn't serve one (or cannot be reached in time). */
export async function latestHash(url: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/cli/freighter.mjs.sha256`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return SHA_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

interface Cache {
  checkedAt: number;
  url: string;
  latest: string | null;
}

const cachePath = (env: NodeJS.ProcessEnv = process.env) => join(dirname(configPath(env)), "update.json");

export function readCache(env: NodeJS.ProcessEnv = process.env): Cache | null {
  try {
    return JSON.parse(readFileSync(cachePath(env), "utf8")) as Cache;
  } catch {
    return null;
  }
}

export function writeCache(c: Cache, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = cachePath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(c));
  } catch {
    /* an update check never gets in the way */
  }
}

export const clearCache = (env: NodeJS.ProcessEnv = process.env) => writeCache({ checkedAt: Date.now(), url: "", latest: null }, env);

const DAY = 24 * 3_600_000;

/** Whether to look for (and tell about) an update this time: only for a person at a terminal, never in CI or for scripts. */
export function wantsCheck(argv: string[], env: NodeJS.ProcessEnv = process.env, stderrIsTTY = !!process.stderr.isTTY): boolean {
  if (env.FREIGHTER_NO_UPDATE_CHECK) return false;
  if (argv.some((a) => a === "--json" || a === "-q" || a === "--quiet")) return false;
  if (["upgrade", "completion", "__update-check"].includes(argv.find((a) => !a.startsWith("-")) ?? "")) return false;
  if (env.FREIGHTER_UPDATE_CHECK === "1") return true; // asked for, even without a terminal
  return !env.CI && stderrIsTTY;
}

/** What to tell the person, from what an earlier look found: nothing when they are current or it isn't known. */
export function notice(own: string | null, cache: Cache | null, url: string): string | null {
  if (!own || !cache?.latest || cache.url !== url || cache.latest === own) return null;
  return `A newer freighter is available (${own.slice(0, 7)} -> ${cache.latest.slice(0, 7)}). Run: freighter upgrade`;
}

/** Look again in the background, at most once a day: a detached copy of this CLI that writes the answer for next time. */
export function refreshInBackground(url: string, cache: Cache | null, env: NodeJS.ProcessEnv = process.env): void {
  const script = process.argv[1];
  if (!script || (cache && cache.url === url && Date.now() - cache.checkedAt < DAY)) return;
  try {
    spawn(process.execPath, [script, "__update-check", url], { detached: true, stdio: "ignore", env }).unref();
  } catch {
    /* never in the way */
  }
}
