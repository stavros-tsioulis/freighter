import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { validateBranch, validateRepoUrl, validateSubpath } from "@freighter/manifest";
import type { Deps } from "./deps.ts";

export const appKeyDir = (d: Deps, app: string) => `${d.config.git.keyDir}/${app}`;
const mirrorPath = (d: Deps, app: string) => `${appKeyDir(d, app)}/mirror.git`;

export interface DeployKey {
  publicKey: string;
  fingerprint: string;
}

const tail = (s: string | undefined) => (s ?? "").trim().split("\n").slice(-3).join(" ");

/** An imported SSH private key (unencrypted PEM/OpenSSH text) to use instead of the app's own deploy key. */
export interface GitAuth {
  sshKey: string;
}

/**
 * Environment for git/ssh: only one identity, no prompts, no user/system config, restricted transports.
 * `keyFile` is the identity to present (the app's deploy key, or a temporary file holding an imported key).
 */
export function gitEnv(d: Deps, scope: string, keyFile = `${appKeyDir(d, scope)}/id_ed25519`): Record<string, string> {
  const dir = appKeyDir(d, scope);
  return {
    GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=${d.config.git.knownHosts} -o UserKnownHostsFile=${dir}/known_hosts`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: d.config.git.allowLocal ? "ssh:https:file" : "ssh:https",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: dir,
  };
}

const withNewline = (k: string) => (k.endsWith("\n") ? k : `${k}\n`);

/**
 * Run `fn` with a git environment for `scope`. With an imported key it is written to a 0600 file in a 0700 directory
 * for the duration of the call and always deleted afterwards; otherwise the scope's own deploy key is created/used.
 */
export async function withGitEnv<T>(d: Deps, scope: string, auth: GitAuth | undefined, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  if (!auth) {
    await ensureDeployKey(d, scope);
    return fn(gitEnv(d, scope));
  }
  const dir = appKeyDir(d, scope);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(`${dir}/k-`);
  try {
    const file = `${tmp}/key`;
    await writeFile(file, withNewline(auth.sshKey), { mode: 0o600 });
    await chmod(file, 0o600);
    return await fn(gitEnv(d, scope, file));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface ImportedKey {
  /** Normalised, unencrypted private key. */
  privateKey: string;
  publicKey: string;
  fingerprint: string;
  keyType: string;
  comment: string;
}

/** Generate a fresh ed25519 key pair (no passphrase); the caller stores the private half and shows the public half. */
export async function generateSshKey(d: Deps, comment: string): Promise<ImportedKey> {
  await mkdir(d.config.git.keyDir, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(`${d.config.git.keyDir}/import-`);
  try {
    const file = `${tmp}/key`;
    const r = await d.exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment.replace(/[^A-Za-z0-9 ._@:-]/g, "").slice(0, 64), "-f", file]);
    if (r.code !== 0) throw new Error(`ssh-keygen failed: ${tail(r.stderr)}`);
    const pub = (await readFile(`${file}.pub`, "utf8")).trim();
    const fp = await d.exec("ssh-keygen", ["-lf", file]);
    return {
      privateKey: withNewline((await readFile(file, "utf8")).trim()),
      publicKey: pub,
      fingerprint: /(SHA256:\S+)/.exec(fp.stdout)?.[1] ?? "",
      keyType: "ed25519",
      comment: pub.split(" ").slice(2).join(" "),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Validate a pasted private key (optionally passphrase-protected) and return it unencrypted with its public half. */
export async function importSshKey(d: Deps, privateKey: string, passphrase?: string): Promise<ImportedKey> {
  await mkdir(d.config.git.keyDir, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(`${d.config.git.keyDir}/import-`);
  try {
    const file = `${tmp}/key`;
    await writeFile(file, withNewline(privateKey.replace(/\r\n/g, "\n").trim()), { mode: 0o600 });
    await chmod(file, 0o600);
    if (passphrase) {
      const r = await d.exec("ssh-keygen", ["-q", "-p", "-P", passphrase, "-N", "", "-f", file]);
      if (r.code !== 0) throw new Error(`could not decrypt the key (wrong passphrase?): ${tail(r.stderr)}`);
    }
    // an empty passphrase makes ssh-keygen fail instead of prompting when the key is still encrypted
    const pub = await d.exec("ssh-keygen", ["-y", "-P", "", "-f", file]);
    if (pub.code !== 0) {
      const enc = /passphrase|incorrect|decrypt/i.test(pub.stderr ?? "");
      throw new Error(enc ? "the key is passphrase-protected: provide its passphrase" : `not a valid SSH private key: ${tail(pub.stderr)}`);
    }
    const publicKey = pub.stdout.trim();
    const fp = await d.exec("ssh-keygen", ["-lf", file]);
    const m = /^\d+\s+(SHA256:\S+)\s+(.*?)\s+\(([A-Z0-9-]+)\)\s*$/m.exec(fp.stdout);
    const keyType = (m?.[3] ?? publicKey.split(" ")[0] ?? "").toLowerCase().replace(/^ssh-/, "");
    return {
      privateKey: withNewline((await readFile(file, "utf8")).trim()),
      publicKey,
      fingerprint: m?.[1] ?? "",
      keyType,
      comment: publicKey.split(" ").slice(2).join(" "),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Create (or return) the per-app read-only deploy key. The private half never leaves this host. */
export async function ensureDeployKey(d: Deps, app: string, opts: { rotate?: boolean } = {}): Promise<DeployKey> {
  const dir = appKeyDir(d, app);
  const key = `${dir}/id_ed25519`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (opts.rotate) await Promise.all([rm(key, { force: true }), rm(`${key}.pub`, { force: true }), rm(`${dir}/known_hosts`, { force: true })]);
  if (!existsSync(key)) {
    const r = await d.exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `freighter:${app}`, "-f", key]);
    if (r.code !== 0) throw new Error(`ssh-keygen failed: ${tail(r.stderr)}`);
  }
  await chmod(key, 0o600);
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim();
  const fp = await d.exec("ssh-keygen", ["-lf", `${key}.pub`]);
  return { publicKey, fingerprint: /(SHA256:\S+)/.exec(fp.stdout)?.[1] ?? "" };
}

function explain(stderr: string | undefined, what: string): Error {
  const msg = tail(stderr);
  const hint = /permission denied|publickey|could not read from remote|authentication failed/i.test(msg)
    ? " (does the SSH key have read access to this repository?)"
    : /host key verification failed/i.test(msg)
      ? " (the git host's key does not match known_hosts)"
      : "";
  return new Error(`${what} failed: ${msg}${hint}`);
}

/** Check that the remote is reachable with the key and that the branch exists; returns its head SHA. */
export async function checkRemote(d: Deps, app: string, repository: string, branch: string, auth?: GitAuth): Promise<string> {
  const url = validateRepoUrl(repository, { allowLocal: d.config.git.allowLocal });
  validateBranch(branch);
  return withGitEnv(d, app, auth, async (env) => {
    const r = await d.exec("git", ["ls-remote", "--exit-code", "--", url, `refs/heads/${branch}`], { env });
    if (r.code === 2) throw new Error(`branch "${branch}" does not exist in ${repository}`);
    if (r.code !== 0) throw explain(r.stderr, "git ls-remote");
    const sha = /^([0-9a-f]{40,64})\s/.exec(r.stdout)?.[1];
    if (!sha) throw new Error(`could not read the head of branch "${branch}"`);
    return sha;
  });
}

export interface BranchList {
  branches: { name: string; default: boolean }[];
  defaultBranch: string | null;
}

/** List the branches of a repository (and its default) without cloning it. */
export async function listBranches(d: Deps, scope: string, repository: string, auth?: GitAuth): Promise<BranchList> {
  const url = validateRepoUrl(repository, { allowLocal: d.config.git.allowLocal });
  return withGitEnv(d, scope, auth, async (env) => {
    const r = await d.exec("git", ["ls-remote", "--symref", "--", url, "HEAD", "refs/heads/*"], { env });
    if (r.code !== 0) throw explain(r.stderr, "git ls-remote");
    const defaultBranch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout)?.[1] ?? null;
    const names = [...r.stdout.matchAll(/^[0-9a-f]{40,64}\s+refs\/heads\/(\S+)$/gm)].map((m) => m[1]!);
    const branches = names
      .filter((n) => { try { validateBranch(n); return true; } catch { return false; } })
      .sort((a, b) => Number(b === defaultBranch) - Number(a === defaultBranch) || a.localeCompare(b))
      .map((name) => ({ name, default: name === defaultBranch }));
    return { branches, defaultBranch };
  });
}

/** Fetch the branch into the scope's private bare mirror and return the commit it points at. */
export async function fetchMirror(d: Deps, app: string, repository: string, branch: string, auth?: GitAuth, signal?: AbortSignal): Promise<string> {
  const url = validateRepoUrl(repository, { allowLocal: d.config.git.allowLocal });
  validateBranch(branch);
  return withGitEnv(d, app, auth, async (env) => {
    const mirror = mirrorPath(d, app);
    if (!existsSync(`${mirror}/HEAD`)) {
      const init = await d.exec("git", ["init", "--bare", "--quiet", mirror], { env });
      if (init.code !== 0) throw explain(init.stderr, "git init");
    }
    const fetch = await d.exec(
      "git",
      ["-C", mirror, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--force", "--", url, `refs/heads/${branch}:refs/freighter/head`],
      { env, signal },
    );
    if (fetch.code !== 0) throw explain(fetch.stderr, "git fetch");
    const rev = await d.exec("git", ["-C", mirror, "rev-parse", "--verify", "refs/freighter/head"], { env });
    const sha = rev.stdout.trim();
    if (rev.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("could not resolve the fetched commit");
    return sha;
  });
}

/** Read one file from a commit of the scope's mirror (null when it does not exist). */
export async function readFileAt(d: Deps, scope: string, sha: string, path: string): Promise<string | null> {
  const r = await d.exec("git", ["-C", mirrorPath(d, scope), "show", `${sha}:${path}`], { env: gitEnv(d, scope) });
  return r.code === 0 ? r.stdout : null;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
}

export async function commitInfo(d: Deps, app: string, sha: string): Promise<CommitInfo> {
  const r = await d.exec("git", ["-C", mirrorPath(d, app), "log", "-1", "--format=%an%x1f%s", sha], { env: gitEnv(d, app) });
  const [author = "", subject = ""] = r.stdout.trim().split("\x1f");
  return { sha, subject: subject.slice(0, 200), author: author.slice(0, 100) };
}

/**
 * Write the files of `sha` (or of a subdirectory of it) into `dest`. `git archive` exports plain file content: no hooks,
 * no smudge/clean filters, no submodules, and nothing from the repository is ever executed.
 */
export async function exportTree(d: Deps, app: string, sha: string, subpath: string, dest: string): Promise<void> {
  const sub = validateSubpath(subpath);
  const tarball = `${dest}.tar`;
  await mkdir(dest, { recursive: true });
  const archive = await d.exec("git", ["-C", mirrorPath(d, app), "archive", "--format=tar", `--output=${tarball}`, sub ? `${sha}:${sub}` : sha], { env: gitEnv(d, app) });
  if (archive.code !== 0) throw new Error(`git archive failed: ${tail(archive.stderr)}${sub ? ` (does "${sub}" exist in the repository?)` : ""}`);
  const untar = await d.exec("tar", ["-xf", tarball, "-C", dest, "--no-same-owner"]);
  await rm(tarball, { force: true });
  if (untar.code !== 0) throw new Error(`could not unpack the checkout: ${tail(untar.stderr)}`);
}
