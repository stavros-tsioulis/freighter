import { copyFile, rm, realpath, stat, statfs } from "node:fs/promises";
import { arch, cpus, hostname, freemem, loadavg, release, totalmem, type, uptime } from "node:os";
import { sep } from "node:path";
import { parseManifest } from "@freighter/manifest";
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
  containersAvailable,
  importSshKey,
  inspectRepo,
  listBranches,
  ensureDeployKey,
  gitDeploy,
  collectMetrics,
  deleteApp,
  openDeployLog,
  controlApp,
  deploy,
  writeConnections,
  reapply,
  applyStorage,
  testStorage,
  storageAvailable,
  readVariables,
  getConfig,
  FileError,
  listDir,
  makeDir,
  renamePath,
  addRule,
  archiveSupport,
  deleteRule,
  disableFirewall,
  enableFirewall,
  FirewallError,
  firewallInstalled,
  firewallStatus,
  setDefaultPolicy,
  listProcesses,
  ProcessError,
  signalProcess,
  beginOperation,
  cancelOperation,
  CanceledError,
  chownPaths,
  deleteStoragePaths,
  listStorage,
  makeStorageDir,
  renameStoragePath,
  identities,
  copyPaths,
  extractPaths,
  movePaths,
  deletePaths,
  mountSupport,
  setVolumePassword,
  volumeStatus,
  setConfig,
  setVariables,
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

/** Operations followed (or answered) by raw bytes are served by the connection itself. */
export type RawOp = "artifact.put" | "fs.write" | "fs.read" | "fs.archive";
export type Handlers = { [N in Exclude<OpName, RawOp>]: (args: z.output<(typeof ops)[N]["args"]>) => Promise<OpResult<N>> };

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

/** The file explorer can be turned off for a server, or limited to looking and downloading. */
/** The firewall tab can be turned off, or limited to looking, per server. */
export function firewallGate(d: Deps, changes = false): void {
  if (!d.config.agent.firewall.enabled) throw new BadRequest("the firewall tab is turned off on this server (agent.firewall.enabled in its config.yaml)");
  if (changes && d.config.agent.firewall.readOnly) throw new BadRequest("the firewall is read-only on this server (agent.firewall.readOnly in its config.yaml)");
}

/** The process list can be turned off, or limited to looking, per server. */
export function processes(d: Deps, changes = false): void {
  if (!d.config.agent.processes.enabled) throw new BadRequest("the process list is turned off on this server (agent.processes.enabled in its config.yaml)");
  if (changes && d.config.agent.processes.readOnly) throw new BadRequest("the process list is read-only on this server (agent.processes.readOnly in its config.yaml)");
}

export function explorer(d: Deps, changes = false): void {
  if (!d.config.agent.files.enabled) throw new FileError("bad_request", "the file explorer is turned off on this server (agent.files.enabled in its config.yaml)");
  if (changes && d.config.agent.files.readOnly) throw new FileError("bad_request", "the file explorer is read-only on this server (agent.files.readOnly in its config.yaml)");
}

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
        capabilities: ["artifact.put", "host.status", "git", "config", "upgrade", "images", "containers.install", "storage.install", "mounts.install", "archives.install", "firewall.install", "volumes", "connections", "variables", "reapply", "app.config", ...(d.config.agent.files.enabled ? ["files"] : []), ...((await storageAvailable(d)).available ? ["storage"] : [])],
        upgrade: upgrade?.state === "verifying" ? upgrade.state : undefined,
      };
    },
    async "upgrade.status"() {
      return upgradeStatus(d, await currentCommit());
    },
    async "upgrade.start"({ ref, withContainers, withStorage, withMounts, withArchives, withFirewall }) {
      await startUpgrade(d, ref ?? "main", await currentCommit(), { withContainers, withStorage, withMounts, withArchives, withFirewall });
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
      return { hostname: hostname(), uptimeSeconds: Math.round(uptime()), load1: loadavg()[0] ?? 0, memTotal: totalmem(), memFree: freemem(), diskTotalBytes: disk.total, diskFreeBytes: disk.free, containers: await containersAvailable(d), storage: await storageAvailable(d), mounts: await mountSupport(d), archives: await archiveSupport(), cpus: cpus().length, os: `${type()} ${release()} ${arch()}`, files: d.config.agent.files, processes: d.config.agent.processes, firewall: { installed: await firewallInstalled(d), ...d.config.agent.firewall } };
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
    async "app.deploy"({ artifact, manifestText, skipVerify, domains, registryAuth, logId, replaceConfig }) {
      const source = artifact === undefined ? undefined : await checkArtifact(d, artifact);
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const op = beginOperation(logId);
      try {
        return toDeployResult(
          await deploy(d, { manifestText, source, skipVerify: skipVerify || d.dev, domains, registryAuth, log, config: replaceConfig ? "replace" : "keep", signal: op.signal }).catch(async (e: unknown) => {
            const err = op.settle(e);
            await log?.(`==> ${err instanceof CanceledError ? "canceled" : `failed: ${err instanceof Error ? err.message : String(err)}`}`);
            throw err;
          }),
        );
      } finally {
        op.end();
      }
    },
    async "deploy.cancel"({ id }) {
      return { canceled: cancelOperation(id) };
    },
    async "fs.list"({ path }) {
      explorer(d);
      return listDir(path);
    },
    async "fs.mkdir"({ path }) {
      explorer(d, true);
      await makeDir(path);
      return {};
    },
    async "fs.rename"({ path, name }) {
      explorer(d, true);
      return { path: await renamePath(path, name) };
    },
    async "fs.copy"({ paths, to, onConflict }) {
      explorer(d, true);
      return copyPaths(paths, to, onConflict);
    },
    async "fs.move"({ paths, to, onConflict }) {
      explorer(d, true);
      return movePaths(paths, to, onConflict);
    },
    async "fs.extract"({ paths, to, onConflict }) {
      explorer(d, true);
      return extractPaths(paths, to, onConflict);
    },
    async "storage.ls"({ name, path }) {
      explorer(d);
      return listStorage(d, name, path);
    },
    async "storage.mkdir"({ name, path }) {
      explorer(d, true);
      await makeStorageDir(d, name, path);
      return {};
    },
    async "storage.rename"({ name, path, newName }) {
      explorer(d, true);
      return { path: await renameStoragePath(d, name, path, newName) };
    },
    async "storage.rm"({ name, paths }) {
      explorer(d, true);
      return deleteStoragePaths(d, name, paths);
    },
    async "firewall.status"() {
      firewallGate(d);
      return firewallStatus(d);
    },
    async "firewall.add"({ acknowledged, position, ...rule }) {
      firewallGate(d, true);
      return addRule(d, rule, { position, acknowledged });
    },
    async "firewall.delete"({ number, signature, twin, acknowledged }) {
      firewallGate(d, true);
      return deleteRule(d, number, signature, { acknowledged, twin });
    },
    async "firewall.enable"({ open }) {
      firewallGate(d, true);
      return enableFirewall(d, open);
    },
    async "firewall.disable"() {
      firewallGate(d, true);
      return disableFirewall(d);
    },
    async "firewall.default"({ direction, policy, acknowledged }) {
      firewallGate(d, true);
      return setDefaultPolicy(d, direction, policy, { acknowledged });
    },
    async "processes.list"() {
      processes(d);
      return listProcesses({ appUsers: new Set(await listApps(d)) });
    },
    async "processes.signal"({ pid, starttime, signal }) {
      processes(d, true);
      await signalProcess(pid, starttime, signal);
      return {};
    },
    async "fs.identities"() {
      explorer(d);
      return identities();
    },
    async "fs.chown"({ paths, owner, group, recursive }) {
      explorer(d, true);
      return chownPaths(paths, owner, group, recursive);
    },
    async "fs.delete"({ paths }) {
      explorer(d, true);
      return deletePaths(paths);
    },
    async "volumes.status"({ app }) {
      const text = await getConfig(d, app);
      if (!text) return { volumes: {} };
      return { volumes: await volumeStatus(d, app, parseManifest(text, { legacy: true })) };
    },
    async "volumes.password.set"({ app, name, password }) {
      const text = await getConfig(d, app);
      const volume = text ? parseManifest(text, { legacy: true }).volumes[name] : undefined;
      if (volume?.type !== "smb") throw new Error(`${app} has no SMB volume "${name}"`);
      await setVolumePassword(d, app, name, password);
      return {};
    },
    async "app.config.get"({ app }) {
      return { manifestText: await getConfig(d, app) };
    },
    async "app.config.set"({ app, manifestText, registryAuth, logId }) {
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const op = beginOperation(logId);
      const r = await setConfig(d, app, manifestText, { skipVerify: d.dev, log, signal: op.signal, registryAuth }).catch(async (e: unknown) => {
        const err = op.settle(e);
        await log?.(`==> ${err instanceof CanceledError ? "canceled" : `failed: ${err instanceof Error ? err.message : String(err)}`}`);
        throw err;
      }).finally(op.end);
      return { deploy: r.deploy ? toDeployResult(r.deploy) : null };
    },
    async "connections.set"({ app, server, peers, storages }) {
      await writeConnections(d, app, { server, peers, storages });
      return {};
    },
    async "variables.get"({ app }) {
      return { variables: await readVariables(d, app) };
    },
    async "variables.set"({ app, service, set, remove, logId }) {
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const r = await setVariables(d, app, service, { set, remove }, { skipVerify: d.dev, log }).catch(async (e: unknown) => {
        await log?.(`==> failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      return { variables: r.variables, deploy: r.deploy ? toDeployResult(r.deploy) : null };
    },
    async "app.reapply"({ app, registryAuth, logId }) {
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const op = beginOperation(logId);
      const r = await reapply(d, app, { skipVerify: d.dev, log, signal: op.signal, registryAuth }).catch(async (e: unknown) => {
        const err = op.settle(e);
        await log?.(`==> ${err instanceof CanceledError ? "canceled" : `failed: ${err instanceof Error ? err.message : String(err)}`}`);
        throw err;
      }).finally(op.end);
      return { changed: r.changed, deploy: r.deploy ? toDeployResult(r.deploy) : null };
    },
    async "storage.apply"({ name, backend, accessKey, secretKey, secrets, logId, public: isPublic }) {
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const r = await applyStorage(d, { name, backend, accessKey, secretKey, public: isPublic }, { secrets, skipVerify: d.dev, log }).catch(async (e: unknown) => {
        await log?.(`==> failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      return { deploy: toDeployResult(r.deploy), port: r.port };
    },
    async "storage.test"({ backend, secrets }) {
      return testStorage(d, backend, secrets);
    },
    async "challenge.get"() {
      return { token: await challengeToken(d) };
    },
    async "app.delete"({ app }) {
      return deleteApp(d, app);
    },
    async "domains.get"({ app }) {
      return { domains: await readDomains(d, app) };
    },
    async "domains.set"({ app, domains, registryAuth, logId }) {
      const log = logId ? await openDeployLog(d, logId) : undefined;
      const r = await setDomains(d, app, domains, { skipVerify: d.dev, log, registryAuth }).catch(async (e: unknown) => {
        await log?.(`==> failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      return { domains: r.domains, deploy: r.deploy ? toDeployResult(r.deploy) : null, mode: r.mode };
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
    async "git.deploy"({ app, buildId, repository, branch, subpath, skipIfUnchanged, fallbackManifest, configText, registryAuth, auth }) {
      const op = beginOperation(buildId);
      const r = await gitDeploy(d, { app, buildId, repository, branch, subpath, skipIfUnchanged, fallbackManifest, configText, registryAuth, skipVerify: d.dev, auth, signal: op.signal }).catch((e: unknown) => {
        throw op.settle(e);
      }).finally(op.end);
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
    async "env.list"({ app, service }) {
      return { names: await listEnvNames(d, app, service) };
    },
    async "env.set"({ app, service, key, value }) {
      await setEnv(d, app, service, key, value);
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
  if (e instanceof FileError) return { code: e.code, message: e.message };
  if (e instanceof FirewallError) return { code: e.code === "unavailable" ? "bad_request" : e.code, message: e.message };
  if (e instanceof ProcessError) return { code: e.code, message: e.message };
  if (e instanceof CanceledError) return { code: "conflict", message: e.message };
  if (e instanceof UpgradeError) return { code: /in progress/.test(e.message) ? "conflict" : "bad_request", message: e.message };
  if (e instanceof BadRequest || e instanceof SettingsError) return { code: "bad_request", message: e.message };
  if (e instanceof ZodError) {
    return { code: "bad_request", message: e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/branch ".*" does not exist/.test(message)) return { code: "not_found", message };
  if (/unsupported repository URL|invalid (branch|subpath|build id)|git (fetch|ls-remote|archive) failed|app\.yaml (not found|is for)|repository URL/.test(message)) return { code: "bad_request", message };
  if (/not deployed|unknown app|unknown release|unknown service|no release to roll back|has no releases/.test(message)) return { code: "not_found", message };
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
    const op = req.op as Exclude<OpName, RawOp>;
    const args = ops[op].args.parse(req.args ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (handlers[op] as (a: any) => Promise<unknown>)(args);
    return { id, ok: true, result };
  } catch (e) {
    if (e instanceof SyntaxError) return { id, ok: false, error: { code: "bad_request", message: "invalid JSON" } };
    return { id, ok: false, error: classify(e) };
  }
}
