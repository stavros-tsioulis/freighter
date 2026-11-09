import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, storageApp, storageOfApp, type StorageBackend, type StorageSecrets } from "@freighter/manifest";
import { ensureApp } from "./app.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { setEnv } from "./env.ts";
import { allocatePort } from "./ports.ts";
import { sharedDirOf } from "./releases.ts";

/** Where the installer puts the upstream rclone (the distribution's is too old to have `serve s3`). */
export const RCLONE = "/usr/local/bin/rclone";
/** `rclone serve s3` arrived in 1.65. */
export const RCLONE_MIN = [1, 65] as const;

/** For tests: forget what was found about rclone. */
export const resetStorageCheck = () => { cached = undefined; };

let cached: { at: number; value: { available: boolean; version?: string } } | undefined;
/** Whether this host can serve storages (a new enough rclone is installed). Always true under --prefix. */
export async function storageAvailable(d: Deps): Promise<{ available: boolean; version?: string }> {
  if (d.dev) return { available: true, version: "dev" };
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value: { available: boolean; version?: string } = { available: false };
  try {
    const r = await d.run(RCLONE, ["version"], { timeoutMs: 10_000 });
    const m = /rclone v(\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
    if (r.code === 0 && m) {
      const [maj, min] = [Number(m[1]), Number(m[2])];
      value = { available: maj > RCLONE_MIN[0] || (maj === RCLONE_MIN[0] && min >= RCLONE_MIN[1]), version: `${m[1]}.${m[2]}.${m[3]}` };
    }
  } catch {
    // not installed
  }
  cached = { at: Date.now(), value };
  return value;
}

export const NO_STORAGE_MESSAGE = `this server cannot serve storages: rclone ${RCLONE_MIN.join(".")} or newer is not installed (re-run the installer with FREIGHTER_WITH_STORAGE=1)`;

export interface StorageSpec {
  name: string;
  backend: StorageBackend;
  accessKey: string;
  secretKey: string;
}

const sshDir = (d: Deps, app: string) => `${sharedDirOf(d, app)}/ssh`;

/** What rclone needs to reach a backend: the thing to serve, and its settings as environment (secrets apart). */
export function rcloneRemote(d: Deps, app: string, b: StorageBackend): { target: string; env: Record<string, string>; passwordKey?: string } {
  const shared = sharedDirOf(d, app);
  switch (b.kind) {
    case "local":
      return { target: `:local:${shared}/data`, env: {} };
    case "sftp":
      return {
        target: `remote:${b.path}`,
        passwordKey: b.auth === "password" ? "RCLONE_CONFIG_REMOTE_PASS" : undefined,
        env: {
          RCLONE_CONFIG_REMOTE_TYPE: "sftp",
          RCLONE_CONFIG_REMOTE_HOST: b.host,
          ...(b.port ? { RCLONE_CONFIG_REMOTE_PORT: String(b.port) } : {}),
          RCLONE_CONFIG_REMOTE_USER: b.user,
          ...(b.auth === "key" ? { RCLONE_CONFIG_REMOTE_KEY_FILE: `${sshDir(d, app)}/id` } : {}),
          RCLONE_CONFIG_REMOTE_KNOWN_HOSTS_FILE: `${sshDir(d, app)}/known_hosts`,
        },
      };
    case "smb":
      return {
        target: `remote:${b.share}${b.path ? `/${b.path.replace(/^\/+/, "")}` : ""}`,
        passwordKey: "RCLONE_CONFIG_REMOTE_PASS",
        env: {
          RCLONE_CONFIG_REMOTE_TYPE: "smb",
          RCLONE_CONFIG_REMOTE_HOST: b.host,
          ...(b.port ? { RCLONE_CONFIG_REMOTE_PORT: String(b.port) } : {}),
          RCLONE_CONFIG_REMOTE_USER: b.user,
          ...(b.domain ? { RCLONE_CONFIG_REMOTE_DOMAIN: b.domain } : {}),
        },
      };
  }
}

/** app.yaml (as JSON, which is YAML) for the app that serves a storage. */
export function storageManifest(d: Deps, spec: StorageSpec, port: number): string {
  const app = storageApp(spec.name);
  const shared = sharedDirOf(d, app);
  const remote = rcloneRemote(d, app, spec.backend);
  return JSON.stringify({
    name: app,
    services: {
      s3: {
        command: `sh -c 'exec ${RCLONE} serve s3 "$FR_TARGET" --addr "127.0.0.1:$PORT" --cache-dir "${shared}/cache"'`,
        port,
        restart: "always",
        // big transfers and slow remote backends: don't let HAProxy give up after its default 30 s
        proxy: { timeout: "30m" },
      },
    },
    environment: { HOME: shared, FR_TARGET: remote.target, ...remote.env },
    secrets: ["RCLONE_AUTH_KEY", ...(remote.passwordKey ? [remote.passwordKey] : [])],
  });
}

/** rclone keeps passwords in config in an "obscured" form; its own `obscure` makes it. The password goes in the environment, not on a command line. */
async function obscure(d: Deps, password: string): Promise<string> {
  const r = await d.run("sh", ["-c", `printf %s "$FR_PW" | exec ${RCLONE} obscure -`], { env: { FR_PW: password }, timeoutMs: 10_000 });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error("rclone could not prepare the password");
  return r.stdout.trim();
}

/** Write the SSH material a backend needs (private key, pinned host key) where only the storage's user can read it. */
async function writeSsh(d: Deps, app: string, b: StorageBackend, secrets: StorageSecrets): Promise<void> {
  if (b.kind !== "sftp") return;
  const dir = sshDir(d, app);
  await mkdir(dir, { recursive: true });
  if (!b.hostKey) throw new Error("the server's SSH host key is not pinned yet: test the connection and confirm its fingerprint first");
  await writeFile(`${dir}/known_hosts`, `${b.hostKey}\n`, { mode: 0o644 });
  if (b.auth === "key") {
    if (!secrets.privateKey) throw new Error("a private key is required for key authentication");
    await writeFile(`${dir}/id`, secrets.privateKey.endsWith("\n") ? secrets.privateKey : `${secrets.privateKey}\n`, { mode: 0o600 });
  }
  await d.run("chown", ["-R", `${app}:${app}`, dir]);
  await chmod(`${dir}/id`, 0o600).catch(() => undefined);
}

/** Ports the S3 endpoints of this server's storages use (read from their current releases). */
async function storagePorts(d: Deps): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let apps: string[] = [];
  try {
    apps = await readdir(d.layout.appsRoot);
  } catch {
    return out;
  }
  for (const app of apps.filter((a) => storageOfApp(a) !== null)) {
    try {
      const port = parseManifest(await readFile(`${d.layout.appsRoot}/${app}/current/app.yaml`, "utf8"), { legacy: true }).services.s3?.port;
      if (port !== undefined) out.set(app, port);
    } catch {
      // not deployed yet
    }
  }
  return out;
}

/** The port a storage's endpoint listens on while it has no domain: the one it already has, else a free one from the usual range. */
async function portFor(d: Deps, app: string): Promise<number> {
  const used = await storagePorts(d);
  return used.get(app) ?? allocatePort(d, new Set(used.values()));
}

export interface ApplyStorageOptions {
  secrets?: StorageSecrets;
  skipVerify?: boolean;
  log?: DeployLog;
}

/**
 * Create or update the app that serves a storage: its directories and user, its credentials (root-only, like any secret),
 * and a deploy of the generated app.yaml. Domains set on the app are kept, so changing the backend never loses them.
 */
export async function applyStorage(d: Deps, spec: StorageSpec, opts: ApplyStorageOptions = {}): Promise<{ deploy: DeployResult; port: number }> {
  if (!d.isRoot) throw new Error("storage must be applied as root");
  const log = opts.log ?? noLog;
  if (!(await storageAvailable(d)).available) throw new Error(NO_STORAGE_MESSAGE);
  const app = storageApp(spec.name);
  const secrets = opts.secrets ?? {};

  await ensureApp(d, app);
  const shared = sharedDirOf(d, app);
  for (const sub of ["data", "cache"]) await mkdir(`${shared}/${sub}`, { recursive: true });
  await d.run("chown", ["-R", `${app}:${app}`, `${shared}/data`, `${shared}/cache`]);
  await writeSsh(d, app, spec.backend, secrets);

  await setEnv(d, app, "RCLONE_AUTH_KEY", `${spec.accessKey},${spec.secretKey}`);
  const remote = rcloneRemote(d, app, spec.backend);
  if (remote.passwordKey) {
    if (!secrets.password) throw new Error("a password is required");
    await setEnv(d, app, remote.passwordKey, d.dev ? secrets.password : await obscure(d, secrets.password));
  }

  await log(`==> deploying the S3 endpoint for storage ${spec.name} (${spec.backend.kind})`);
  const port = await portFor(d, app);
  const scratch = await mkdtemp(join(tmpdir(), "freighter-storage-"));
  try {
    return { deploy: await deploy(d, { manifestText: storageManifest(d, spec, port), source: scratch, skipVerify: opts.skipVerify, log }), port };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface TestStorageResult {
  ok: boolean;
  error?: string;
  /** SFTP without a pinned host key: what the server presents, to confirm before connecting. */
  hostKey?: { line: string; fingerprint: string; type: string };
}

/** `SHA256:` fingerprint of a `known_hosts`/`ssh-keyscan` key line (host, type, base64 key). */
export function hostKeyFingerprint(base64Key: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Try a backend without creating anything: SFTP without a pinned key first reads the server's host key for the user to
 * confirm; otherwise rclone lists the root of the remote with the given credentials.
 */
export async function testStorage(d: Deps, backend: StorageBackend, secrets: StorageSecrets = {}): Promise<TestStorageResult> {
  if (!(await storageAvailable(d)).available) return { ok: false, error: NO_STORAGE_MESSAGE };
  if (backend.kind === "local") return { ok: true };

  if (backend.kind === "sftp" && !backend.hostKey) {
    const r = await d.run("ssh-keyscan", ["-T", "10", "-p", String(backend.port ?? 22), backend.host], { timeoutMs: 20_000 }).catch(() => undefined);
    const line = r?.stdout.split("\n").find((l) => l && !l.startsWith("#") && /\s(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa)\s/.test(l));
    const m = line && /^(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) return { ok: false, error: `could not read the SSH host key of ${backend.host}` };
    return { ok: true, hostKey: { line: line!.trim(), type: m[2]!, fingerprint: hostKeyFingerprint(m[3]!) } };
  }

  const scratch = await mkdtemp(join(tmpdir(), "freighter-storage-test-"));
  try {
    const app = `test-${scratch.split("-").pop()}`;
    const env: Record<string, string> = { HOME: scratch };
    const remote = rcloneRemote(d, app, backend);
    Object.assign(env, remote.env);
    if (backend.kind === "sftp") {
      await writeFile(`${scratch}/known_hosts`, `${backend.hostKey}\n`);
      env.RCLONE_CONFIG_REMOTE_KNOWN_HOSTS_FILE = `${scratch}/known_hosts`;
      if (backend.auth === "key") {
        if (!secrets.privateKey) return { ok: false, error: "a private key is required" };
        await writeFile(`${scratch}/id`, secrets.privateKey.endsWith("\n") ? secrets.privateKey : `${secrets.privateKey}\n`, { mode: 0o600 });
        env.RCLONE_CONFIG_REMOTE_KEY_FILE = `${scratch}/id`;
      }
    }
    if (remote.passwordKey) {
      if (!secrets.password) return { ok: false, error: "a password is required" };
      env[remote.passwordKey] = d.dev ? secrets.password : await obscure(d, secrets.password);
    }
    const r = await d.run(RCLONE, ["lsd", remote.target, "--contimeout", "10s", "--timeout", "15s", "--retries", "1", "--low-level-retries", "1"], { env, timeoutMs: 40_000 });
    if (r.code === 0) return { ok: true };
    const reason = (r.stderr ?? "").split("\n").reverse().find((l) => /error|failed|denied|refused|timeout/i.test(l)) ?? (r.stderr ?? "").trim().split("\n").at(-1) ?? "";
    return { ok: false, error: reason.replace(/^\S+\s+\S+\s+(ERROR|NOTICE)\s*:\s*/, "").slice(0, 300) || `rclone exited with code ${r.code}` };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
