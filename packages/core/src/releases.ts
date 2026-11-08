import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Deps } from "./deps.ts";
import { readHistory } from "./history.ts";

const execFileP = promisify(execFile);

export const appDir = (d: Deps, app: string) => `${d.layout.appsRoot}/${app}`;
export const releasesDir = (d: Deps, app: string) => `${appDir(d, app)}/releases`;
export const releaseDir = (d: Deps, app: string, id: string) => `${releasesDir(d, app)}/${id}`;
export const currentLink = (d: Deps, app: string) => `${appDir(d, app)}/current`;

/** `r20261106-134500` (UTC). The `r` prefix keeps it a valid identifier for use as a unit instance. */
export function newReleaseId(now: Date): string {
  const iso = now.toISOString(); // 2026-11-06T13:45:00.000Z
  return `r${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** Copy a directory, or extract a .tar.gz/.tgz, into a fresh release directory. */
export async function stageRelease(d: Deps, app: string, source: string, id: string, opts: { move?: boolean } = {}): Promise<string> {
  const dest = releaseDir(d, app, id);
  const info = await stat(source).catch(() => {
    throw new Error(`source not found: ${source}`);
  });
  await mkdir(releasesDir(d, app), { recursive: true });
  await mkdir(dest); // fails if the release already exists
  try {
    if (info.isDirectory()) {
      // A build directory can be moved into place (cheap on the same filesystem); otherwise fall back to copying.
      const moved = opts.move && (await rename(source, dest).then(() => true, () => false));
      if (!moved) await cp(source, dest, { recursive: true, verbatimSymlinks: true });
    } else if (info.isFile() && /\.(tar\.gz|tgz)$/.test(source)) {
      await execFileP("tar", ["-xzf", source, "-C", dest, "--no-same-owner"]);
    } else {
      throw new Error(`source must be a directory or a .tar.gz/.tgz file: ${source}`);
    }
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/** Atomically point `current` at the release (relative link, replaced via rename). */
export async function activate(d: Deps, app: string, id: string): Promise<void> {
  const link = currentLink(d, app);
  const tmp = `${appDir(d, app)}/.current.tmp`;
  await rm(tmp, { force: true });
  await symlink(`releases/${id}`, tmp);
  await rename(tmp, link);
}

export async function currentRelease(d: Deps, app: string): Promise<string | null> {
  try {
    return (await readlink(currentLink(d, app))).split("/").pop() ?? null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** A release id for "now" that does not collide with an existing release (adds -2, -3, ...). */
export async function allocateReleaseId(d: Deps, app: string): Promise<string> {
  const base = newReleaseId(d.now());
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const exists = await access(releaseDir(d, app, id)).then(() => true, () => false);
    if (!exists) return id;
  }
}

export interface ReleaseInfo {
  id: string;
  current: boolean;
  result?: "success" | "failed";
  at?: string;
}

/** Release ids sort chronologically, oldest first. */
export async function listReleaseIds(d: Deps, app: string): Promise<string[]> {
  try {
    return (await readdir(releasesDir(d, app))).filter((f) => f.startsWith("r")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function listReleases(d: Deps, app: string): Promise<ReleaseInfo[]> {
  const [ids, cur, history] = await Promise.all([listReleaseIds(d, app), currentRelease(d, app), readHistory(d, app)]);
  return ids.map((id) => {
    const last = history.filter((h) => h.release === id).at(-1);
    return { id, current: id === cur, result: last?.result, at: last?.at };
  });
}

/** Delete releases beyond the newest `keep`, never touching `protect`. Returns deleted ids. */
export async function pruneReleases(d: Deps, app: string, keep: number, protect: string[]): Promise<string[]> {
  const ids = await listReleaseIds(d, app);
  const keepSet = new Set([...ids.slice(-keep), ...protect]);
  const doomed = ids.filter((id) => !keepSet.has(id));
  for (const id of doomed) await rm(releaseDir(d, app, id), { recursive: true, force: true });
  return doomed;
}

/** A release directory with nothing staged in it (for apps made only of image services). */
export async function stageEmptyRelease(d: Deps, app: string, id: string): Promise<string> {
  const dest = releaseDir(d, app, id);
  await mkdir(releasesDir(d, app), { recursive: true });
  await mkdir(dest); // fails if the release already exists
  return dest;
}
