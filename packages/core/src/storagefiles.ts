import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { parseManifest, storageApp } from "@freighter/manifest";
import { readFile } from "node:fs/promises";
import { readConfig } from "./appconfig.ts";
import type { Deps } from "./deps.ts";
import { appEnvDir } from "./env.ts";
import { FileError, type BulkResult } from "./files.ts";
import { RCLONE } from "./storage.ts";
import { sharedDirOf } from "./releases.ts";

const execFileP = promisify(execFile);

/**
 * Browse and change what a storage holds, as its S3 clients see it: the top-level folders are buckets, the rest is
 * keys. This goes through rclone with the storage's own backend settings (the same ones `rclone serve s3` runs with),
 * as the storage's user, so it works the same for a local folder, SFTP and SMB and needs no S3 credentials.
 * Paths are `/`, `/bucket`, `/bucket/some/key`.
 */
let bin = RCLONE;
/** For tests: run another program in place of rclone. */
export const useRcloneBinary = (path?: string) => void (bin = path ?? RCLONE);

interface Remote {
  target: string;
  env: Record<string, string>;
  /** Run rclone as this user (root only), so what it writes belongs to the storage. */
  user: string | null;
}

/** `KEY="value"` lines of an env file. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)="(.*)"$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

async function remoteOf(d: Deps, name: string): Promise<Remote> {
  const app = storageApp(name);
  const text = await readConfig(d, app);
  if (!text) throw new FileError("not_found", `storage "${name}" is not set up on this server`);
  const svc = parseManifest(text, { legacy: true }).services.s3;
  if (!svc) throw new FileError("not_found", `storage "${name}" is not set up on this server`);
  const secrets = parseEnvFile(await readFile(`${appEnvDir(d, app)}/s3.env`, "utf8").catch(() => ""));
  delete secrets.RCLONE_AUTH_KEY; // the S3 key pair is for S3 clients; rclone does not need it here
  const { FR_TARGET: target, ...env } = { ...svc.environment, ...secrets };
  if (!target) throw new FileError("not_found", `storage "${name}" has no backend recorded`);
  return { target, env: { ...env, HOME: env.HOME ?? sharedDirOf(d, app) }, user: process.getuid?.() === 0 && !d.dev ? app : null };
}

/** `/a/b` -> ["a", "b"]; nothing that climbs or is empty. */
function segments(path: string): string[] {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw new FileError("bad_request", `invalid path: ${path}`);
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) throw new FileError("bad_request", `invalid path: ${path}`);
  return parts;
}
const cleanPath = (parts: string[]) => `/${parts.join("/")}`;
const at = (r: Remote, parts: string[]) => (parts.length ? `${r.target.replace(/\/+$/, "")}/${parts.join("/")}` : r.target);

const COMMON = ["--contimeout", "15s", "--timeout", "60s", "--retries", "1", "--low-level-retries", "2"];

async function command(r: Remote): Promise<{ cmd: string; pre: string[] }> {
  if (!r.user) return { cmd: bin, pre: [] };
  const [uid, gid] = await Promise.all(["-u", "-g"].map(async (f) => (await execFileP("id", [f, r.user!])).stdout.trim()));
  return { cmd: "setpriv", pre: [`--reuid=${uid}`, `--regid=${gid}`, "--init-groups", bin] };
}

async function spawnRclone(r: Remote, args: string[], stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe"]) {
  const { cmd, pre } = await command(r);
  return spawn(cmd, [...pre, ...args, ...COMMON], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...r.env }, stdio });
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
function fail(path: string, stderr: string, code: number | null): never {
  const line = lastLine(stderr).replace(/^\S+\s+\S+\s+(ERROR|NOTICE|CRITICAL)\s*:\s*/, "");
  if (/not found|no such file|does not exist/i.test(stderr)) throw new FileError("not_found", `${path}: not found`);
  if (/permission denied/i.test(stderr)) throw new FileError("bad_request", `${path}: permission denied`);
  throw new FileError("bad_request", `${path}: ${line.slice(0, 300) || `rclone exited with code ${code}`}`);
}

async function exec(r: Remote, args: string[], path: string): Promise<string> {
  const child = await spawnRclone(r, args, ["ignore", "pipe", "pipe"]);
  let out = "";
  let err = "";
  child.stdout!.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr!.on("data", (c: Buffer) => { if (err.length < 8000) err += c.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }).catch((e: NodeJS.ErrnoException) => {
    throw new FileError("bad_request", e.code === "ENOENT" ? "rclone is not installed on this server" : e.message);
  });
  if (code !== 0) fail(path, err, code);
  return out;
}

export interface StorageEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtimeMs: number;
}
export interface StorageListing {
  path: string;
  parent: string | null;
  entries: StorageEntry[];
  truncated: boolean;
}

async function list(r: Remote, parts: string[]): Promise<StorageEntry[]> {
  const out = await exec(r, ["lsjson", "--no-mimetype", at(r, parts)], cleanPath(parts));
  const rows = JSON.parse(out || "[]") as { Name: string; Size: number; ModTime?: string; IsDir: boolean }[];
  return rows.map((x) => ({ name: x.Name, type: x.IsDir ? ("dir" as const) : ("file" as const), size: x.IsDir ? 0 : Math.max(0, x.Size), mtimeMs: x.ModTime ? Date.parse(x.ModTime) || 0 : 0 }));
}

/** What a path is: an entry of its parent, or null. */
async function entryAt(r: Remote, parts: string[]): Promise<StorageEntry | null> {
  if (parts.length === 0) return { name: "", type: "dir", size: 0, mtimeMs: 0 };
  const siblings = await list(r, parts.slice(0, -1)).catch((e) => (e instanceof FileError && e.code === "not_found" ? [] : Promise.reject(e)));
  return siblings.find((e) => e.name === parts.at(-1)) ?? null;
}

export async function listStorage(d: Deps, name: string, path: string, limit = 10_000): Promise<StorageListing> {
  const r = await remoteOf(d, name);
  const parts = segments(path);
  const all = await list(r, parts);
  return { path: cleanPath(parts), parent: parts.length ? cleanPath(parts.slice(0, -1)) : null, entries: all.slice(0, limit), truncated: all.length > limit };
}

export async function makeStorageDir(d: Deps, name: string, path: string): Promise<void> {
  const r = await remoteOf(d, name);
  const parts = segments(path);
  if (!parts.length) throw new FileError("bad_request", "name the folder");
  if (await entryAt(r, parts)) throw new FileError("conflict", `${cleanPath(parts)}: already exists`);
  await exec(r, ["mkdir", at(r, parts)], cleanPath(parts));
}

export async function deleteStoragePaths(d: Deps, name: string, paths: string[]): Promise<BulkResult> {
  const r = await remoteOf(d, name);
  const result: BulkResult = { done: [], failed: [] };
  for (const p of paths) {
    try {
      const parts = segments(p);
      if (!parts.length) throw new FileError("bad_request", "the root can't be deleted");
      const e = await entryAt(r, parts);
      if (!e) throw new FileError("not_found", `${cleanPath(parts)}: not found`);
      await exec(r, [e.type === "dir" ? "purge" : "deletefile", at(r, parts)], cleanPath(parts));
      result.done.push(cleanPath(parts));
    } catch (e) {
      result.failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

export async function renameStoragePath(d: Deps, name: string, path: string, newName: string): Promise<string> {
  const r = await remoteOf(d, name);
  const parts = segments(path);
  if (!parts.length) throw new FileError("bad_request", "the root can't be renamed");
  if (!newName || newName === "." || newName === ".." || newName.includes("/") || newName.includes("\0")) throw new FileError("bad_request", "invalid name");
  const to = [...parts.slice(0, -1), newName];
  if (!(await entryAt(r, parts))) throw new FileError("not_found", `${cleanPath(parts)}: not found`);
  if (await entryAt(r, to)) throw new FileError("conflict", `${cleanPath(to)}: already exists`);
  await exec(r, ["moveto", at(r, parts), at(r, to)], cleanPath(parts));
  return cleanPath(to);
}

export interface StorageUpload {
  dest: Writable;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

/** Receive a file into `/bucket/key`: its bytes are piped to rclone, which puts it in place when the last one is in. */
export async function createStorageUpload(d: Deps, name: string, path: string, overwrite: boolean): Promise<StorageUpload> {
  const r = await remoteOf(d, name);
  const parts = segments(path);
  if (parts.length < 2) throw new FileError("bad_request", "a file goes in a bucket: /bucket/name");
  const existing = await entryAt(r, parts);
  if (existing && !overwrite) throw new FileError("conflict", `${cleanPath(parts)}: already exists`);
  if (existing?.type === "dir") throw new FileError("bad_request", `${cleanPath(parts)}: is a folder`);
  const child = await spawnRclone(r, ["rcat", at(r, parts)], ["pipe", "ignore", "pipe"]);
  let err = "";
  child.stderr!.on("data", (c: Buffer) => { if (err.length < 8000) err += c.toString(); });
  child.stdin!.on("error", () => {}); // rclone stopping early is reported by its exit code
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  return {
    dest: child.stdin!,
    async commit() {
      const code = await exited;
      if (code !== 0) fail(cleanPath(parts), err, code);
    },
    async abort() {
      child.stdin!.destroy();
      child.kill();
      await exited;
      await exec(r, ["deletefile", at(r, parts)], cleanPath(parts)).catch(() => undefined); // a partial file, if one was made
    },
  };
}

/** Open `/bucket/key` for download: its size and time, and the bytes. Destroying the stream stops rclone. */
export async function openStorageDownload(d: Deps, name: string, path: string): Promise<{ size: number; mtimeMs: number; stream: Readable }> {
  const r = await remoteOf(d, name);
  const parts = segments(path);
  const e = await entryAt(r, parts);
  if (!e) throw new FileError("not_found", `${cleanPath(parts)}: not found`);
  if (e.type === "dir") throw new FileError("bad_request", `${cleanPath(parts)}: is a folder`);
  const child = await spawnRclone(r, ["cat", at(r, parts)], ["ignore", "pipe", "pipe"]);
  child.stderr!.resume();
  const stream = child.stdout!;
  stream.on("close", () => child.kill());
  return { size: e.size, mtimeMs: e.mtimeMs, stream };
}
