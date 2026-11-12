import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { chown, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
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

// ---- extracting archives ----

type Packer = "tar" | "zip" | "7z" | "gzip" | "bzip2" | "xz";
const ARCHIVES: { re: RegExp; packer: Packer; tarFlag?: string }[] = [
  { re: /\.(tar\.gz|tgz)$/i, packer: "tar", tarFlag: "-z" },
  { re: /\.(tar\.bz2|tbz2|tbz)$/i, packer: "tar", tarFlag: "-j" },
  { re: /\.(tar\.xz|txz)$/i, packer: "tar", tarFlag: "-J" },
  { re: /\.(tar\.zst|tzst)$/i, packer: "tar", tarFlag: "--zstd" },
  { re: /\.tar$/i, packer: "tar" },
  { re: /\.zip$/i, packer: "zip" },
  { re: /\.(7z|rar)$/i, packer: "7z" },
  { re: /\.gz$/i, packer: "gzip" },
  { re: /\.bz2$/i, packer: "bzip2" },
  { re: /\.xz$/i, packer: "xz" },
];
const archiveOf = (name: string) => ARCHIVES.find((a) => a.re.test(name));
/** Whether the file explorer can extract a file of this name. */
export const isArchive = (name: string) => archiveOf(name) !== undefined;
/** `backup.tar.gz` -> `backup`. */
const stemOf = (name: string) => name.replace(archiveOf(name)?.re ?? /$^/, "") || name;

const SEVEN = ["7zz", "7z", "7za"];
async function run(cmd: string, args: string[]): Promise<{ ok: true } | { ok: false; missing: boolean; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
    child.on("error", (e) => resolve({ ok: false, missing: (e as NodeJS.ErrnoException).code === "ENOENT", error: e.message }));
    child.on("close", (code) => resolve(code === 0 || (code === 1 && cmd === "unzip") ? { ok: true } : { ok: false, missing: false, error: err.trim().split("\n").filter(Boolean).slice(-1)[0] ?? `exited with code ${code}` }));
  });
}
/** Whether a tool is installed. */
async function has(cmd: string): Promise<boolean> {
  return (await new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["--help"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  }));
}
async function sevenZip(): Promise<string | null> {
  for (const c of SEVEN) if (await has(c)) return c;
  return null;
}
export const NO_7Z_MESSAGE = "7z is not installed on this server: add archive support from the Servers page";

/** Unpack one archive into the empty (or merged-into) folder `dest`. */
async function unpack(packer: Packer, tarFlag: string | undefined, from: string, dest: string, name: string): Promise<void> {
  const fail = (r: { error: string; missing: boolean }, tool: string): never => {
    throw new FileError("bad_request", `${from}: ${r.missing ? `${tool} is not installed on this server` : r.error}`);
  };
  switch (packer) {
    case "tar": {
      const r = await run("tar", ["-x", ...(tarFlag ? [tarFlag] : []), "--no-same-owner", "-f", from, "-C", dest]);
      if (!r.ok) fail(r, "tar");
      return;
    }
    case "zip": {
      const r = await run("unzip", ["-q", "-o", from, "-d", dest]);
      if (r.ok) return;
      if (!r.missing) fail(r, "unzip");
      const seven = await sevenZip();
      if (!seven) throw new FileError("bad_request", `${from}: neither unzip nor 7z is installed on this server: add archive support from the Servers page`);
      const z = await run(seven, ["x", "-y", `-o${dest}`, "--", from]);
      if (!z.ok) fail(z, seven);
      return;
    }
    case "7z": {
      const seven = await sevenZip();
      if (!seven) throw new FileError("bad_request", `${from}: ${NO_7Z_MESSAGE}`);
      const r = await run(seven, ["x", "-y", `-o${dest}`, "--", from]);
      if (!r.ok) fail(r, seven);
      return;
    }
    default: {
      // gzip, bzip2 and xz hold one file: the result is that file without the extension.
      const out = createWriteStream(posix.join(dest, name), { flags: "wx" });
      const child = spawn(packer, ["-dc", "--", from], { stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
      const exit = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      await Promise.all([pipeline(child.stdout, out), exit.then((code) => { if (code !== 0) throw new Error(err.trim().split("\n").filter(Boolean).slice(-1)[0] ?? `exited with code ${code}`); })]).catch((e) => {
        throw new FileError("bad_request", `${from}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? `${packer} is not installed on this server` : (e as Error).message}`);
      });
    }
  }
}

/**
 * Extract archives, each into a folder named after it (`site.tar.gz` -> `site/`) inside `to`, or beside the archive.
 * What the folder holds belongs to whoever owns the folder it was made in. A folder that already exists is dealt with
 * as for a copy: `rename` makes `site copy/`, `overwrite` extracts into it, `fail` refuses.
 */
export async function extractPaths(paths: string[], to: string | undefined, onConflict: OnConflict = "rename"): Promise<BulkResult> {
  const toDir = to === undefined ? undefined : await destination(to);
  return each(paths, async (raw) => {
    const from = cleanPath(raw);
    const info = await stat(from).catch((e) => wrap(e, from));
    if (!info.isFile()) throw new FileError("bad_request", `${from}: not a file`);
    const name = posix.basename(from);
    const kind = archiveOf(name);
    if (!kind) throw new FileError("bad_request", `${from}: not an archive Freighter can extract (zip, tar, tar.gz, tar.bz2, tar.xz, tar.zst, 7z, rar, gz, bz2, xz)`);
    const dir = toDir ?? posix.dirname(from);
    let stem = stemOf(name);
    let dest = posix.join(dir, stem);
    let created = true;
    if (await lstat(dest).then(() => true, () => false)) {
      if (onConflict === "fail") throw new FileError("conflict", `${dest}: already exists`);
      if (onConflict === "rename") {
        stem = await freeName(dir, stem);
        dest = posix.join(dir, stem);
      } else {
        if (!(await stat(dest)).isDirectory()) throw new FileError("conflict", `${dest}: exists and is not a folder`);
        created = false;
      }
    }
    if (created) await mkdir(dest).catch((e) => wrap(e, dest));
    try {
      await unpack(kind.packer, kind.tarFlag, from, dest, stem);
    } catch (e) {
      if (created) await rm(dest, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    if (process.getuid?.() === 0) {
      const parent = await stat(dir).catch(() => null);
      if (parent) await execFileP("chown", ["-R", "-h", `${parent.uid}:${parent.gid}`, "--", dest]).catch(() => {});
    }
    return dest;
  });
}

/** Which archive tools this server has: tar always, unzip and 7z where installed. */
export async function archiveSupport(): Promise<{ unzip: boolean; sevenZip: boolean }> {
  return { unzip: await has("unzip"), sevenZip: (await sevenZip()) !== null };
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
