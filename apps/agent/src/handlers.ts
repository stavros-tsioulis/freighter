import { copyFile, rm, realpath, stat, statfs } from "node:fs/promises";
import { hostname, freemem, loadavg, totalmem, uptime } from "node:os";
import { sep } from "node:path";
import {
  DeployFailedError,
  SettingsError,
  applyHaproxyListeners,
  applySettings,
  readSettings,
  appInfo,
  BuildFailedError,
  buildLogChunk,
  certStatus,
  challengeToken,
  UpgradeError,
  checkForUpdates,
  checkoutCommit,
  confirmUpgrade,
  startUpgrade,
  upgradeStatus,
  checkRemote,
  generateSshKey,
  importSshKey,
  inspectRepo,
  listBranches,
  ensureDeployKey,
  gitDeploy,
  collectMetrics,
  controlApp,
  deploy,
  listApps,
  listEnvNames,
  readDomains,
  readHistory,
  renewCerts,
  resolveServiceUnit,
  rollback,
  setDomains,
  setEnv,
  type Deps,
} from "@freighter/core";
import { RAW_OPS, ops, type OpName, type OpResult, type Reply, type WireError, request } from "@freighter/protocol";
import type { z } from "zod";
import { ZodError } from "zod";

export type Handlers = { [N in Exclude<OpName, "artifact.put">]: (args: z.output<(typeof ops)[N]["args"]>) => Promise<OpResult<N>> };

/** Resolve an artifact path and make sure it is a regular file inside the spool directory. */
async function checkArtifact(d: Deps, artifact: string): Promise<string> {
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(artifact), realpath(d.config.agent.artifactsDir)]);
  } catch {
    throw new BadRequest("artifact not found");
  }
  if (!real.startsWith(root + sep)) throw new BadRequest("artifact must be inside the artifacts directory");
  if (!(await stat(real)).isFile()) throw new BadRequest("artifact must be a regular file");
  return real;
}

export class BadRequest extends Error {}

function toDeployResult(r: Awaited<ReturnType<typeof deploy>>): OpResult<"app.deploy"> {
  return {
    app: r.app,
    releaseId: r.releaseId,
    previous: r.previous,
    units: r.units,
    removed: r.removed,
    pruned: r.pruned,
    hostnames: r.hostnames,
    warnings: r.warnings,
    verified: r.verified,
    historyAt: r.historyAt!,
  };
}

const configPath = (d: Deps) => d.configPath ?? "/etc/freighter/config.yaml";

export function createHandlers(d: Deps): Handlers {
  // The checked-out commit changes only through an upgrade, which restarts this process: look it up once.
  let commit: Promise<string | null> | undefined;
  const currentCommit = () => (commit ??= checkoutCommit(d.installDir, d.exec));
  const iso = (x: Date | null) => (x ? x.toISOString() : null);
  return {
    async ping() {
      const commit = await currentCommit();
      const upgrade = (await upgradeStatus(d, commit)).upgrade;
      return {
        version: commit ?? "0.0.0",
        time: d.now().toISOString(),
        hostname: hostname(),
        capabilities: ["artifact.put", "host.status", "git", "config", "upgrade"],
        upgrade: upgrade?.state === "verifying" ? upgrade.state : undefined,
      };
    },
    async "upgrade.status"() {
      return upgradeStatus(d, await currentCommit());
    },
    async "upgrade.start"({ ref }) {
      await startUpgrade(d, ref ?? "main", await currentCommit());
      return { started: true as const };
    },
    async "upgrade.check"({ ref }) {
      return checkForUpdates(d, ref ?? "main");
    },
    async "upgrade.confirm"() {
      return { confirmed: await confirmUpgrade(d) };
    },
    async "host.status"() {
      let disk: { total: number | null; free: number | null } = { total: null, free: null };
      try {
        const fs = await statfs(d.layout.appsRoot).catch(() => statfs("/"));
        disk = { total: Number(fs.blocks) * Number(fs.bsize), free: Number(fs.bavail) * Number(fs.bsize) };
      } catch {
        /* leave unknown */
      }
      return { hostname: hostname(), uptimeSeconds: Math.round(uptime()), load1: loadavg()[0] ?? 0, memTotal: totalmem(), memFree: freemem(), diskTotalBytes: disk.total, diskFreeBytes: disk.free };
    },
    async "artifact.delete"({ id }) {
      await rm(`${d.config.agent.artifactsDir}/${id}.tar.gz`, { force: true });
      return {};
    },
    async "apps.list"() {
      return { apps: await listApps(d) };
    },
    async "app.info"({ app }) {
      return appInfo(d, app);
    },
    async "app.history"({ app, limit }) {
      return { entries: (await readHistory(d, app)).slice(-limit) };
    },
    async "app.deploy"({ artifact, manifestText, skipVerify, domains }) {
      const source = await checkArtifact(d, artifact);
      return toDeployResult(await deploy(d, { manifestText, source, skipVerify: skipVerify || d.dev, domains }));
    },
    async "challenge.get"() {
      return { token: await challengeToken(d) };
    },
    async "domains.get"({ app }) {
      return { domains: await readDomains(d, app) };
    },
    async "domains.set"({ app, domains }) {
      const r = await setDomains(d, app, domains, { skipVerify: d.dev });
      return { domains: r.domains, deploy: r.deploy ? toDeployResult(r.deploy) : null };
    },
    async "git.keygen"({ app, rotate }) {
      return ensureDeployKey(d, app, { rotate });
    },
    async "ssh.import"({ privateKey, passphrase }) {
      return importSshKey(d, privateKey, passphrase);
    },
    async "ssh.generate"({ comment }) {
      return generateSshKey(d, comment);
    },
    async "git.branches"({ repository, auth }) {
      return listBranches(d, "_branches", repository, auth);
    },
    async "git.inspect"({ repository, branch, subpath, auth }) {
      return inspectRepo(d, { repository, branch, subpath, auth });
    },
    async "git.check"({ app, repository, branch, auth }) {
      return { sha: await checkRemote(d, app, repository, branch, auth) };
    },
    async "git.deploy"({ app, buildId, repository, branch, subpath, skipIfUnchanged, fallbackManifest, auth }) {
      const r = await gitDeploy(d, { app, buildId, repository, branch, subpath, skipIfUnchanged, fallbackManifest, skipVerify: d.dev, auth });
      return r.skipped
        ? { skipped: true, commit: r.commit, buildSeconds: 0 }
        : { skipped: false, commit: r.commit, buildSeconds: r.buildSeconds, deploy: toDeployResult(r.deploy) };
    },
    async "build.log"({ id, from }) {
      return buildLogChunk(d, id, from);
    },
    async "app.rollback"({ app, release }) {
      return rollback(d, app, { target: release, skipVerify: d.dev });
    },
    async "app.control"({ app, verb, service }) {
      return { units: await controlApp(d, app, verb, service) };
    },
    async "app.logs"({ app, service, lines }) {
      const unit = await resolveServiceUnit(d, app, service);
      const r = await d.run("journalctl", d.systemd.logsArgs(unit, { lines }));
      return { text: r.stdout };
    },
    async "metrics.snapshot"() {
      return { samples: await collectMetrics(d) };
    },
    async "env.list"({ app }) {
      return { names: await listEnvNames(d, app) };
    },
    async "env.set"({ app, key, value }) {
      await setEnv(d, app, key, value);
      return {};
    },
    async "config.get"() {
      return { fields: await readSettings(configPath(d)) };
    },
    async "config.set"({ changes }) {
      const path = configPath(d);
      const r = await applySettings(path, changes);
      let haproxy: "applied" | "manual" | "none" = "none";
      if (r.haproxyChanged) {
        try {
          haproxy = await applyHaproxyListeners(d, r.config);
        } catch (e) {
          await copyFile(`${path}.bak`, path).catch(() => {}); // HAProxy said no: leave the file as it was
          throw e;
        }
      }
      return { changed: r.changed, restart: r.restart, haproxy };
    },
    async "service.restart"({ service }) {
      // After the reply is on the wire: restarting the agent ends this very process.
      setTimeout(() => void d.run("systemctl", ["restart", "--no-block", service === "api" ? "freighter-api" : "freighter-agent"]), 300).unref();
      return {};
    },
    async "certs.status"() {
      return { certs: (await certStatus(d)).map((c) => ({ hostname: c.hostname, expires: iso(c.expires) })) };
    },
    async "certs.renew"({ force }) {
      return { certs: (await renewCerts(d, { force })).map((c) => ({ ...c, expires: iso(c.expires) })) };
    },
  };
}

export function classify(e: unknown): WireError {
  if (e instanceof DeployFailedError) {
    return { code: "deploy_failed", message: e.message, rolledBackTo: e.rolledBackTo, releaseId: e.releaseId, historyAt: e.historyAt };
  }
  if (e instanceof BuildFailedError) return { code: "build_failed", message: e.message, logTail: e.logTail };
  if (e instanceof UpgradeError) return { code: /in progress/.test(e.message) ? "conflict" : "bad_request", message: e.message };
  if (e instanceof BadRequest || e instanceof SettingsError) return { code: "bad_request", message: e.message };
  if (e instanceof ZodError) {
    return { code: "bad_request", message: e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/branch ".*" does not exist/.test(message)) return { code: "not_found", message };
  if (/unsupported repository URL|invalid (branch|subpath|build id)|git (fetch|ls-remote|archive) failed|app\.yaml (not found|is for)|repository URL/.test(message)) return { code: "bad_request", message };
  if (/not deployed|unknown release|unknown service|no release to roll back|has no releases/.test(message)) return { code: "not_found", message };
  if (/in progress|already current/.test(message)) return { code: "conflict", message };
  if (/missing secrets|must run as root|invalid /.test(message)) return { code: "bad_request", message };
  return { code: "internal", message };
}

/** Handle one request line and produce the reply to write back. */
export async function dispatch(handlers: Handlers, line: string): Promise<Reply> {
  let id = "?";
  try {
    const req = request.parse(JSON.parse(line));
    id = req.id;
    if (!(req.op in ops)) throw new BadRequest(`unknown operation "${req.op}"`);
    if (RAW_OPS.has(req.op)) throw new BadRequest(`${req.op} must be sent as an upload`);
    const op = req.op as Exclude<OpName, "artifact.put">;
    const args = ops[op].args.parse(req.args ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (handlers[op] as (a: any) => Promise<unknown>)(args);
    return { id, ok: true, result };
  } catch (e) {
    if (e instanceof SyntaxError) return { id, ok: false, error: { code: "bad_request", message: "invalid JSON" } };
    return { id, ok: false, error: classify(e) };
  }
}
