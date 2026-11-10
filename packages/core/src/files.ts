import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { chown, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Writable } from "node:stream";
import { assertNoMounts } from "./volumes.ts";

const execFileP = promisify(execFile);

/**
 * The server's files, for the file explorer. The agent runs as root, so everything here is reachable: the callers
 * (the API) only let admins in and record what they change. Paths are absolute and normalized; nothing is resolved
 * through symbolic links except where the operating system does it for us.
 */
export class FileError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "FileError";
  }
}

export function cleanPath(p: unknown): string {
  if (typeof p !== "string" || p === "" || p.includes("\0")) throw new FileError("bad_request", "invalid path");
  if (!p.startsWith("/")) throw new FileError("bad_request", `the path must be absolute: ${p}`);
  const n = posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

function wrap(e: unknown, path: string): never {
  const code = (e as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT": throw new FileError("not_found", `${path}: no such file or directory`);
    case "ENOTDIR": throw new FileError("bad_request", `${path}: not a directory`);
    case "EISDIR": throw new FileError("bad_request", `${path}: is a directory`);
    case "EACCES":
    case "EPERM": throw new FileError("bad_request", `${path}: permission denied`);
    case "EEXIST":
    case "ENOTEMPTY": throw new FileError("conflict", `${path}: already exists`);
    case "ENOSPC": throw new FileError("bad_request", `${path}: no space left on the device`);
    case "EROFS": throw new FileError("bad_request", `${path}: the file system is read-only`);
    default: throw e instanceof FileError ? e : new FileError("bad_request", `${path}: ${(e as Error).message}`);
  }
}

/** Folders that must not be deleted or moved away, whatever the caller thinks. */
const PROTECTED = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var"]);

// ---- names for uids and gids ----
let names: { at: number; users: Map<number, string>; groups: Map<number, string> } | null = null;
async function nameTables() {
  if (names && Date.now() - names.at < 30_000) return names;
  const read = async (file: string) => {
    const map = new Map<number, string>();
    for (const line of (await readFile(file, "utf8").catch(() => "")).split("\n")) {
      const [name, , id] = line.split(":");
      if (name && id && /^\d+$/.test(id) && !map.has(Number(id))) map.set(Number(id), name);
    }
    return map;
  };
  names = { at: Date.now(), users: await read("/etc/passwd"), groups: await read("/etc/group") };
  return names;
}

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  mtimeMs: number;
  /** Permission bits (e.g. 0o644 as 420). */
  mode: number;
  uid: number;
  gid: number;
  owner: string | null;
  group: string | null;
  /** For a symbolic link: where it points, and what is there. */
  link?: { target: string; type: "dir" | "file" | "other" | "missing" };
}
export interface Listing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, xs.length) }, async () => {
      for (;;) {
        const n = i++;
        if (n >= xs.length) return;
        out[n] = await fn(xs[n]!);
      }
    }),
  );
  return out;
}

export async function listDir(raw: string, opts: { limit?: number } = {}): Promise<Listing> {
  const path = cleanPath(raw);
  const limit = opts.limit ?? 10_000;
  const all = await readdir(path).catch((e) => wrap(e, path));
  const truncated = all.length > limit;
  const { users, groups } = await nameTables();
  const found = await mapLimit(all.slice(0, limit), 64, async (name): Promise<FileEntry | null> => {
    const full = posix.join(path, name);
    const info = await lstat(full).catch(() => null);
    if (!info) return null; // gone since the listing
    const entry: FileEntry = {
      name,
      type: info.isDirectory() ? "dir" : info.isFile() ? "file" : info.isSymbolicLink() ? "link" : "other",
      size: info.isFile() ? info.size : 0,
      mtimeMs: info.mtimeMs,
      mode: info.mode & 0o7777,
      uid: info.uid,
      gid: info.gid,
      owner: users.get(info.uid) ?? null,
      group: groups.get(info.gid) ?? null,
    };
    if (info.isSymbolicLink()) {
      const target = await readlink(full).catch(() => "");
      const t = await stat(full).catch(() => null);
      entry.link = { target, type: !t ? "missing" : t.isDirectory() ? "dir" : t.isFile() ? "file" : "other" };
      if (t?.isFile()) entry.size = t.size;
    }
    return entry;
  });
  const entries = found.filter((e): e is FileEntry => e !== null).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path, parent: path === "/" ? null : posix.dirname(path), entries, truncated };
}

/** New things made as root belong to whoever owns the folder they are in, as if that user had made them. */
async function inherit(path: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const parent = await stat(posix.dirname(path)).catch(() => null);
  if (parent) await chown(path, parent.uid, parent.gid).catch(() => {});
}

export async function makeDir(raw: string): Promise<void> {
  const path = cleanPath(raw);
  await mkdir(path).catch((e) => wrap(e, path));
  await inherit(path);
}

const validName = (name: string) => name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0") && name.length <= 255;

export async function renamePath(raw: string, name: string): Promise<string> {
  const from = cleanPath(raw);
  if (!validName(name)) throw new FileError("bad_request", "invalid name");
  if (PROTECTED.has(from)) throw new FileError("bad_request", `${from} can't be renamed`);
  const to = posix.join(posix.dirname(from), name);
  if (to === from) return to;
  if (await lstat(to).then(() => true, () => false)) throw new FileError("conflict", `${to}: already exists`);
  await lstat(from).catch((e) => wrap(e, from));
  await rename(from, to).catch((e) => wrap(e, from));
  return to;
}

export interface BulkResult {
  /** Where each succeeded item ended up (copy and move), or the item itself (delete). */
  done: string[];
  failed: { path: string; error: string }[];
}
export type OnConflict = "fail" | "overwrite" | "rename";

/** `name.ext` -> `name copy.ext`, `name copy 2.ext`, ... the first that is free in `dir`. */
async function freeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${base} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!(await lstat(posix.join(dir, candidate)).then(() => true, () => false))) return candidate;
  }
}

async function checkNoMounts(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info?.isDirectory()) await assertNoMounts(path);
}

async function place(kind: "copy" | "move", raw: string, toDir: string, onConflict: OnConflict): Promise<string | null> {
  const from = cleanPath(raw);
  const info = await lstat(from).catch((e) => wrap(e, from));
  if (kind === "move" && PROTECTED.has(from)) throw new FileError("bad_request", `${from} can't be moved`);
  if (info.isDirectory() && (toDir === from || toDir.startsWith(`${from}/`))) throw new FileError("bad_request", `${from}: a folder can't go into itself`);
  const base = posix.basename(from);
  let dest = posix.join(toDir, base);
  const same = dest === from;
  if (same && kind === "move") return null; // already there
  if (await lstat(dest).then(() => true, () => false)) {
    if (onConflict === "rename" || same) dest = posix.join(toDir, await freeName(toDir, base));
    else if (onConflict === "fail") throw new FileError("conflict", `${dest}: already exists`);
    else {
      await checkNoMounts(dest);
      await rm(dest, { recursive: true, force: true });
    }
  }
  if (kind === "move") {
    await checkNoMounts(from);
    try {
      await rename(from, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") wrap(e, from);
      await execFileP("cp", ["-a", "--", from, dest]).catch((err) => wrap(err, from));
      await rm(from, { recursive: true, force: true });
    }
  } else {
    await execFileP("cp", ["-a", "--", from, dest]).catch((err: { stderr?: string }) => {
      throw new FileError("bad_request", `${from}: ${(err.stderr ?? "copy failed").trim().split("\n")[0]}`);
    });
  }
  return dest;
}

async function each(paths: string[], fn: (p: string) => Promise<string | null>): Promise<BulkResult> {
  const result: BulkResult = { done: [], failed: [] };
  for (const p of paths) {
    try {
      const done = await fn(p);
      if (done) result.done.push(done);
    } catch (e) {
      result.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

async function destination(raw: string): Promise<string> {
  const toDir = cleanPath(raw);
  const info = await stat(toDir).catch((e) => wrap(e, toDir));
  if (!info.isDirectory()) throw new FileError("bad_request", `${toDir}: not a folder`);
  return toDir;
}

export async function copyPaths(paths: string[], to: string, onConflict: OnConflict = "fail"): Promise<BulkResult> {
  const toDir = await destination(to);
  return each(paths, (p) => place("copy", p, toDir, onConflict));
}

export async function movePaths(paths: string[], to: string, onConflict: OnConflict = "fail"): Promise<BulkResult> {
  const toDir = await destination(to);
  return each(paths, (p) => place("move", p, toDir, onConflict));
}

export async function deletePaths(paths: string[]): Promise<BulkResult> {
  return each(paths, async (raw) => {
    const path = cleanPath(raw);
    if (PROTECTED.has(path)) throw new FileError("bad_request", `${path} can't be deleted`);
    await lstat(path).catch((e) => wrap(e, path));
    await checkNoMounts(path);
    await rm(path, { recursive: true }).catch((e) => wrap(e, path));
    return path;
  });
}

/** A regular file to download (a symbolic link is followed). */
export async function openForDownload(raw: string): Promise<{ size: number; mtimeMs: number; stream: ReadStream }> {
  const path = cleanPath(raw);
  const info = await stat(path).catch((e) => wrap(e, path));
  if (!info.isFile()) throw new FileError("bad_request", `${path}: not a file (download a folder as an archive)`);
  return { size: info.size, mtimeMs: info.mtimeMs, stream: createReadStream(path) };
}

export interface UploadSink {
  /** Bytes go here; the file appears at `path` only once `commit` succeeds. */
  dest: Writable;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

/** Prepare to receive a file: checks the folder and the name first, writes beside the target and renames when done. */
export async function createUpload(raw: string, overwrite: boolean): Promise<UploadSink> {
  const path = cleanPath(raw);
  const dir = posix.dirname(path);
  if (!validName(posix.basename(path))) throw new FileError("bad_request", "invalid file name");
  const parent = await stat(dir).catch((e) => wrap(e, dir));
  if (!parent.isDirectory()) throw new FileError("bad_request", `${dir}: not a folder`);
  const existing = await lstat(path).catch(() => null);
  if (existing && !overwrite) throw new FileError("conflict", `${path}: already exists`);
  if (existing?.isDirectory()) throw new FileError("bad_request", `${path}: is a folder`);
  const tmp = posix.join(dir, `.${posix.basename(path)}.freighter-upload-${process.pid}-${Date.now().toString(36)}`);
  const dest = createWriteStream(tmp, { mode: existing ? existing.mode & 0o777 : 0o644 });
  return {
    dest,
    async commit() {
      await rename(tmp, path).catch((e) => wrap(e, path));
      if (!existing) await inherit(path);
    },
    async abort() {
      dest.destroy();
      await rm(tmp, { force: true });
    },
  };
}
