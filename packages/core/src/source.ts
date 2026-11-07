import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { parseManifest, validateBranch, validateRepoUrl, validateSubpath } from "@freighter/manifest";
import { buildLogPath, ensureBuildUser, runBuild } from "./build.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { commitInfo, exportTree, fetchMirror, readFileAt, type CommitInfo, type GitAuth } from "./git.ts";
import type { SourceMeta } from "./history.ts";
import { currentLink } from "./releases.ts";

export class BuildFailedError extends Error {
  constructor(
    message: string,
    readonly logTail: string,
  ) {
    super(message);
    this.name = "BuildFailedError";
  }
}

export interface GitDeployOptions {
  app: string;
  /** Names the build dir and log; the API passes the deployment id so the log can be followed. */
  buildId: string;
  repository: string;
  branch: string;
  subpath?: string;
  /** Do nothing if the branch head is already what is deployed (webhook retries, repeated triggers). */
  skipIfUnchanged?: boolean;
  skipVerify?: boolean;
  /** Used only when the repository has no app.yaml; a file in the repository always wins. */
  fallbackManifest?: string;
  /** An imported SSH key to use instead of the app's own deploy key. */
  auth?: GitAuth;
}

export type GitDeployResult =
  | { skipped: true; commit: CommitInfo; releaseId: string | null }
  | { skipped: false; commit: CommitInfo; deploy: DeployResult; buildSeconds: number };

/** Builds currently running, so `build.log` can tell a follower when to stop polling. */
const active = new Set<string>();

export async function currentSource(d: Deps, app: string): Promise<SourceMeta | null> {
  try {
    return JSON.parse(await readFile(`${currentLink(d, app)}/.freighter-source.json`, "utf8")) as SourceMeta;
  } catch {
    return null;
  }
}

/** A slice of a build log from byte offset `from`; `done` once the build is no longer running. */
export async function buildLogChunk(d: Deps, buildId: string, from = 0): Promise<{ text: string; next: number; done: boolean }> {
  const path = buildLogPath(d, buildId);
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return { text: "", next: from, done: !active.has(buildId) };
  }
  const slice = buf.subarray(Math.min(from, buf.length));
  return { text: slice.toString("utf8"), next: buf.length, done: !active.has(buildId) };
}

async function pruneOldLogs(d: Deps) {
  const dir = d.config.git.buildDir;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith(".log")) continue;
    const info = await stat(`${dir}/${f}`).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 24 * 3_600_000) await rm(`${dir}/${f}`, { force: true });
  }
}

/** Fetch a branch, build it in a sandbox and deploy it through the normal health-gated engine. */
export async function gitDeploy(d: Deps, o: GitDeployOptions): Promise<GitDeployResult> {
  if (!d.isRoot) throw new Error("git deploys must run as root (or use --prefix for a local run)");
  const repository = validateRepoUrl(o.repository, { allowLocal: d.config.git.allowLocal });
  const branch = validateBranch(o.branch);
  const subpath = validateSubpath(o.subpath ?? "");
  if (!/^[0-9a-f-]{8,64}$/.test(o.buildId)) throw new Error("invalid build id");

  const buildRoot = `${d.config.git.buildDir}/${o.buildId}`;
  const src = `${buildRoot}/src`;
  const logFile = buildLogPath(d, o.buildId);
  await mkdir(d.config.git.buildDir, { recursive: true });
  await writeFile(logFile, "");
  const log = (line: string) => appendFile(logFile, `${line}\n`);
  active.add(o.buildId);
  try {
    await pruneOldLogs(d);
    await log(`==> fetching ${branch} from ${repository}`);
    const sha = await fetchMirror(d, o.app, repository, branch, o.auth);
    const commit = await commitInfo(d, o.app, sha);
    await log(`    ${sha.slice(0, 12)} ${commit.subject}${commit.author ? ` (${commit.author})` : ""}`);

    if (o.skipIfUnchanged) {
      const cur = await currentSource(d, o.app);
      if (cur?.sha === sha) {
        await log("==> already deployed; nothing to do");
        return { skipped: true, commit, releaseId: null };
      }
    }

    const user = await ensureBuildUser(d);
    await exportTree(d, o.app, sha, subpath, src);
    await d.run("chown", ["-R", `${user}:${user}`, buildRoot]);

    let manifestText: string;
    try {
      manifestText = await readFile(`${src}/app.yaml`, "utf8");
    } catch {
      if (!o.fallbackManifest) {
        throw new Error(`app.yaml not found at ${subpath ? `${subpath}/` : "the root of the repository"}, and no settings are configured in Freighter for this app`);
      }
      manifestText = o.fallbackManifest;
      await log("==> no app.yaml in the repository; using the settings configured in Freighter");
    }
    const manifest = parseManifest(manifestText);
    if (manifest.name !== o.app) throw new Error(`app.yaml is for "${manifest.name}" but this app is "${o.app}"`);

    let buildSeconds = 0;
    if (manifest.build && manifest.build.commands.length > 0) {
      await log(`==> building (${manifest.build.commands.length} command${manifest.build.commands.length === 1 ? "" : "s"}, limit ${manifest.build.timeout})`);
      const r = await runBuild(d, { app: o.app, buildId: o.buildId, dir: src, spec: manifest.build });
      buildSeconds = r.seconds;
      if (!r.ok) {
        const why = r.timedOut ? `build timed out after ${manifest.build.timeout}` : `build failed with exit code ${r.code}`;
        await log(`==> ${why}`);
        const tail = (await readFile(logFile, "utf8")).split("\n").slice(-30).join("\n");
        throw new BuildFailedError(why, tail);
      }
      await log(`==> build finished in ${r.seconds}s`);
    }

    await log("==> deploying");
    const meta: SourceMeta = { type: "git", sha, ref: `refs/heads/${branch}`, subject: commit.subject, author: commit.author };
    const result = await deploy(d, { manifestText, source: src, meta, moveSource: true, skipVerify: o.skipVerify });
    await log(`==> deployed ${result.releaseId}`);
    return { skipped: false, commit, deploy: result, buildSeconds };
  } catch (e) {
    await log(`==> ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`).catch(() => {});
    throw e;
  } finally {
    active.delete(o.buildId);
    await rm(buildRoot, { recursive: true, force: true });
  }
}

export interface InspectResult {
  sha: string;
  commit: CommitInfo;
  hasManifest: boolean;
  valid: boolean;
  appName: string | null;
  error: string | null;
  buildCommands: string[];
}

const INSPECT_PREFIX = "_inspect-";
const INSPECT_KEEP_MS = 24 * 3600_000;

/**
 * Look at a branch before deploying it: fetch it into a scratch mirror and read `app.yaml`, so the UI can show
 * "will deploy as <name>". Nothing from the repository is executed or checked out.
 */
export async function inspectRepo(d: Deps, o: { repository: string; branch: string; subpath?: string; auth?: GitAuth }): Promise<InspectResult> {
  const subpath = validateSubpath(o.subpath ?? "");
  const key = createHash("sha256").update(`${o.repository}\n${o.auth ? "key" : "deploy"}`).digest("hex").slice(0, 16);
  const scope = `${INSPECT_PREFIX}${key}`;
  await pruneInspectMirrors(d, scope);
  const sha = await fetchMirror(d, scope, o.repository, o.branch, o.auth);
  const commit = await commitInfo(d, scope, sha);
  const text = await readFileAt(d, scope, sha, subpath ? `${subpath}/app.yaml` : "app.yaml");
  if (text === null) return { sha, commit, hasManifest: false, valid: false, appName: null, error: "app.yaml not found", buildCommands: [] };
  try {
    const m = parseManifest(text);
    return { sha, commit, hasManifest: true, valid: true, appName: m.name, error: null, buildCommands: m.build?.commands ?? [] };
  } catch (e) {
    return { sha, commit, hasManifest: true, valid: false, appName: null, error: e instanceof Error ? e.message : String(e), buildCommands: [] };
  }
}

async function pruneInspectMirrors(d: Deps, keep: string): Promise<void> {
  try {
    for (const name of await readdir(d.config.git.keyDir)) {
      if (!name.startsWith(INSPECT_PREFIX) || name === keep) continue;
      const dir = `${d.config.git.keyDir}/${name}`;
      if (Date.now() - (await stat(dir)).mtimeMs > INSPECT_KEEP_MS) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    /* nothing to prune */
  }
}
