import { copyFile, rm, realpath, stat, statfs } from "node:fs/promises";
import { arch, cpus, hostname, freemem, loadavg, release, totalmem, type, uptime } from "node:os";
import { join, sep } from "node:path";
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
  ConsoleError,
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
  type DeployLog,
} from "@freighter/core";
import { RAW_OPS, ops, type OpName, type OpResult, type Reply, type WireError, request } from "@freighter/protocol";
import type { z } from "zod";
import { ZodError } from "zod";
import { describeError, formatIssues } from "./errors.ts";

/** Operations followed (or answered) by raw bytes are served by the connection itself. */
export type RawOp = "artifact.put" | "fs.write" | "fs.read" | "fs.archive" | "console.open";
export type Handlers = { [N in Exclude<OpName, RawOp>]: (args: z.output<(typeof ops)[N]["args"]>) => Promise<OpResult<N>> };

export class BadRequest extends Error {}

const DEFAULT_CONFIG_PATH = "/etc/freighter/config.yaml";
const UNKNOWN_VERSION = "0.0.0";
const DEFAULT_REF = "main";
const BRANCHES_SCOPE = "_branches";
const SERVICE_RESTART_DELAY_MS = 300;
const API_SERVICE = "freighter-api";
const AGENT_SERVICE = "freighter-agent";

const BASE_CAPABILITIES = [
  "artifact.put",
  "host.status",
  "git",
  "config",
  "upgrade",
  "images",
  "containers.install",
  "storage.install",
  "mounts.install",
  "archives.install",
  "firewall.install",
  "volumes",
  "connections",
  "variables",
  "reapply",
  "app.config",
] as const;

interface FeatureAccess {
  enabled: boolean;
  readOnly: boolean;
}

interface FeatureGate {
  access: FeatureAccess;
  configKey: string;
  name: string;
  readOnlyName?: string;
  changes: boolean;
  makeError: (message: string) => Error;
}

type OperationSignal = AbortSignal | undefined;

interface DiskUsage {
  total: number | null;
  free: number | null;
}

/** Resolve an artifact path and make sure it is a regular file inside the spool directory. */
async function checkArtifact(deps: Deps, artifact: string): Promise<string> {
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(artifact), realpath(deps.config.agent.artifactsDir)]);
  } catch {
    throw new BadRequest("artifact not found");
  }
  if (!real.startsWith(root + sep)) throw new BadRequest("artifact must be inside the artifacts directory");
  if (!(await stat(real)).isFile()) throw new BadRequest("artifact must be a regular file");
  return real;
}

function assertFeatureAccess(gate: FeatureGate): void {
  if (!gate.access.enabled) {
    throw gate.makeError(`the ${gate.name} is turned off on this server (${gate.configKey}.enabled in its config.yaml)`);
  }
  if (gate.changes && gate.access.readOnly) {
    const name = gate.readOnlyName ?? gate.name;
    throw gate.makeError(`the ${name} is read-only on this server (${gate.configKey}.readOnly in its config.yaml)`);
  }
}

/** The firewall tab can be turned off, or limited to looking, per server. */
export function firewallGate(deps: Deps, changes = false): void {
  assertFeatureAccess({
    access: deps.config.agent.firewall,
    configKey: "agent.firewall",
    name: "firewall tab",
    readOnlyName: "firewall",
    changes,
    makeError: (message) => new BadRequest(message),
  });
}

/** The process list can be turned off, or limited to looking, per server. */
export function processes(deps: Deps, changes = false): void {
  assertFeatureAccess({
    access: deps.config.agent.processes,
    configKey: "agent.processes",
    name: "process list",
    changes,
    makeError: (message) => new BadRequest(message),
  });
}

/** The file explorer can be turned off for a server, or limited to looking and downloading. */
export function explorer(deps: Deps, changes = false): void {
  assertFeatureAccess({
    access: deps.config.agent.files,
    configKey: "agent.files",
    name: "file explorer",
    changes,
    makeError: (message) => new FileError("bad_request", message),
  });
}

function toDeployResult(result: Awaited<ReturnType<typeof deploy>>): OpResult<"app.deploy"> {
  return {
    app: result.app,
    releaseId: result.releaseId,
    previous: result.previous,
    units: result.units,
    removed: result.removed,
    pruned: result.pruned,
    hostnames: result.hostnames,
    warnings: result.warnings,
    verified: result.verified,
    historyAt: result.historyAt!,
  };
}

function deployResultOrNull(result: Awaited<ReturnType<typeof deploy>> | null | undefined): OpResult<"app.deploy"> | null {
  return result ? toDeployResult(result) : null;
}

function resolveConfigPath(deps: Deps): string {
  return deps.configPath ?? DEFAULT_CONFIG_PATH;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function collectCapabilities(deps: Deps): Promise<string[]> {
  return [
    ...BASE_CAPABILITIES,
    ...(deps.config.agent.console.enabled ? ["console"] : []),
    ...(deps.config.agent.files.enabled ? ["files"] : []),
    ...((await storageAvailable(deps)).available ? ["storage"] : []),
  ];
}

async function readDiskUsage(deps: Deps): Promise<DiskUsage> {
  try {
    const stats = await statfs(deps.layout.appsRoot).catch(() => statfs("/"));
    return { total: Number(stats.blocks) * Number(stats.bsize), free: Number(stats.bavail) * Number(stats.bsize) };
  } catch {
    return { total: null, free: null };
  }
}

async function withOperation<T>(logId: string | undefined, run: (signal: OperationSignal) => Promise<T>): Promise<T> {
  const operation = beginOperation(logId);
  try {
    return await run(operation.signal);
  } catch (error) {
    throw operation.settle(error);
  } finally {
    operation.end();
  }
}

async function withLoggedOperation<T>(
  deps: Deps,
  logId: string | undefined,
  run: (signal: OperationSignal, log: DeployLog | undefined) => Promise<T>,
): Promise<T> {
  const log = logId ? await openDeployLog(deps, logId) : undefined;
  try {
    return await withOperation(logId, (signal) => run(signal, log));
  } catch (error) {
    await log?.(`==> ${error instanceof CanceledError ? "canceled" : `failed: ${describeError(error)}`}`);
    throw error;
  }
}

async function withDeployLog<T>(deps: Deps, logId: string | undefined, run: (log: DeployLog | undefined) => Promise<T>): Promise<T> {
  const log = logId ? await openDeployLog(deps, logId) : undefined;
  try {
    return await run(log);
  } catch (error) {
    await log?.(`==> failed: ${describeError(error)}`);
    throw error;
  }
}

export function createHandlers(deps: Deps): Handlers {
  // The checked-out commit changes only through an upgrade, which restarts this process: look it up once.
  let commit: Promise<string | null> | undefined;
  const currentCommit = () => (commit ??= checkoutCommit(deps.installDir, deps.exec));
  return {
    async ping() {
      const commit = await currentCommit();
      const upgrade = (await upgradeStatus(deps, commit)).upgrade;
      return {
        version: commit ?? UNKNOWN_VERSION,
        time: deps.now().toISOString(),
        hostname: hostname(),
        capabilities: await collectCapabilities(deps),
        upgrade: upgrade?.state === "verifying" ? upgrade.state : undefined,
      };
    },
    async "upgrade.status"() {
      return upgradeStatus(deps, await currentCommit());
    },
    async "upgrade.start"({ ref, withContainers, withStorage, withMounts, withArchives, withFirewall }) {
      await startUpgrade(deps, ref ?? DEFAULT_REF, await currentCommit(), { withContainers, withStorage, withMounts, withArchives, withFirewall });
      return { started: true as const };
    },
    async "upgrade.check"({ ref }) {
      return checkForUpdates(deps, ref ?? DEFAULT_REF);
    },
    async "upgrade.confirm"() {
      return { confirmed: await confirmUpgrade(deps) };
    },
    async "host.status"() {
      const disk = await readDiskUsage(deps);
      return {
        hostname: hostname(),
        uptimeSeconds: Math.round(uptime()),
        load1: loadavg()[0] ?? 0,
        memTotal: totalmem(),
        memFree: freemem(),
        diskTotalBytes: disk.total,
        diskFreeBytes: disk.free,
        containers: await containersAvailable(deps),
        storage: await storageAvailable(deps),
        mounts: await mountSupport(deps),
        archives: await archiveSupport(),
        cpus: cpus().length,
        os: `${type()} ${release()} ${arch()}`,
        files: deps.config.agent.files,
        processes: deps.config.agent.processes,
        firewall: { installed: await firewallInstalled(deps), ...deps.config.agent.firewall },
        console: { enabled: deps.config.agent.console.enabled },
      };
    },
    async "artifact.delete"({ id }) {
      await rm(join(deps.config.agent.artifactsDir, `${id}.tar.gz`), { force: true });
      return {};
    },
    async "apps.list"() {
      return { apps: await listApps(deps) };
    },
    async "app.info"({ app }) {
      return appInfo(deps, app);
    },
    async "app.history"({ app, limit }) {
      return { entries: (await readHistory(deps, app)).slice(-limit) };
    },
    async "app.deploy"({ artifact, manifestText, skipVerify, domains, registryAuth, logId, replaceConfig }) {
      const source = artifact === undefined ? undefined : await checkArtifact(deps, artifact);
      return withLoggedOperation(deps, logId, async (signal, log) => {
        const result = await deploy(deps, {
          manifestText,
          source,
          skipVerify: skipVerify || deps.dev,
          domains,
          registryAuth,
          log,
          config: replaceConfig ? "replace" : "keep",
          signal,
        });
        return toDeployResult(result);
      });
    },
    async "deploy.cancel"({ id }) {
      return { canceled: cancelOperation(id) };
    },
    async "fs.list"({ path }) {
      explorer(deps);
      return listDir(path);
    },
    async "fs.mkdir"({ path }) {
      explorer(deps, true);
      await makeDir(path);
      return {};
    },
    async "fs.rename"({ path, name }) {
      explorer(deps, true);
      return { path: await renamePath(path, name) };
    },
    async "fs.copy"({ paths, to, onConflict }) {
      explorer(deps, true);
      return copyPaths(paths, to, onConflict);
    },
    async "fs.move"({ paths, to, onConflict }) {
      explorer(deps, true);
      return movePaths(paths, to, onConflict);
    },
    async "fs.extract"({ paths, to, onConflict }) {
      explorer(deps, true);
      return extractPaths(paths, to, onConflict);
    },
    async "storage.ls"({ name, path }) {
      explorer(deps);
      return listStorage(deps, name, path);
    },
    async "storage.mkdir"({ name, path }) {
      explorer(deps, true);
      await makeStorageDir(deps, name, path);
      return {};
    },
    async "storage.rename"({ name, path, newName }) {
      explorer(deps, true);
      return { path: await renameStoragePath(deps, name, path, newName) };
    },
    async "storage.rm"({ name, paths }) {
      explorer(deps, true);
      return deleteStoragePaths(deps, name, paths);
    },
    async "firewall.status"() {
      firewallGate(deps);
      return firewallStatus(deps);
    },
    async "firewall.add"({ acknowledged, position, ...rule }) {
      firewallGate(deps, true);
      return addRule(deps, rule, { position, acknowledged });
    },
    async "firewall.delete"({ number, signature, twin, acknowledged }) {
      firewallGate(deps, true);
      return deleteRule(deps, number, signature, { acknowledged, twin });
    },
    async "firewall.enable"({ open }) {
      firewallGate(deps, true);
      return enableFirewall(deps, open);
    },
    async "firewall.disable"() {
      firewallGate(deps, true);
      return disableFirewall(deps);
    },
    async "firewall.default"({ direction, policy, acknowledged }) {
      firewallGate(deps, true);
      return setDefaultPolicy(deps, direction, policy, { acknowledged });
    },
    async "processes.list"() {
      processes(deps);
      return listProcesses({ appUsers: new Set(await listApps(deps)) });
    },
    async "processes.signal"({ pid, starttime, signal }) {
      processes(deps, true);
      await signalProcess(pid, starttime, signal);
      return {};
    },
    async "fs.identities"() {
      explorer(deps);
      return identities();
    },
    async "fs.chown"({ paths, owner, group, recursive }) {
      explorer(deps, true);
      return chownPaths(paths, owner, group, recursive);
    },
    async "fs.delete"({ paths }) {
      explorer(deps, true);
      return deletePaths(paths);
    },
    async "volumes.status"({ app }) {
      const text = await getConfig(deps, app);
      if (!text) return { volumes: {} };
      return { volumes: await volumeStatus(deps, app, parseManifest(text, { legacy: true })) };
    },
    async "volumes.password.set"({ app, name, password }) {
      const text = await getConfig(deps, app);
      const volume = text ? parseManifest(text, { legacy: true }).volumes[name] : undefined;
      if (volume?.type !== "smb") throw new Error(`${app} has no SMB volume "${name}"`);
      await setVolumePassword(deps, app, name, password);
      return {};
    },
    async "app.config.get"({ app }) {
      return { manifestText: await getConfig(deps, app) };
    },
    async "app.config.set"({ app, manifestText, registryAuth, logId }) {
      return withLoggedOperation(deps, logId, async (signal, log) => {
        const result = await setConfig(deps, app, manifestText, { skipVerify: deps.dev, log, signal, registryAuth });
        return { deploy: deployResultOrNull(result.deploy) };
      });
    },
    async "connections.set"({ app, server, peers, storages }) {
      await writeConnections(deps, app, { server, peers, storages });
      return {};
    },
    async "variables.get"({ app }) {
      return { variables: await readVariables(deps, app) };
    },
    async "variables.set"({ app, service, set, remove, logId }) {
      return withDeployLog(deps, logId, async (log) => {
        const result = await setVariables(deps, app, service, { set, remove }, { skipVerify: deps.dev, log });
        return { variables: result.variables, deploy: deployResultOrNull(result.deploy) };
      });
    },
    async "app.reapply"({ app, registryAuth, logId }) {
      return withLoggedOperation(deps, logId, async (signal, log) => {
        const result = await reapply(deps, app, { skipVerify: deps.dev, log, signal, registryAuth });
        return { changed: result.changed, deploy: deployResultOrNull(result.deploy) };
      });
    },
    async "storage.apply"({ name, backend, accessKey, secretKey, secrets, logId, public: isPublic }) {
      return withDeployLog(deps, logId, async (log) => {
        const result = await applyStorage(
          deps,
          { name, backend, accessKey, secretKey, public: isPublic },
          { secrets, skipVerify: deps.dev, log },
        );
        return { deploy: toDeployResult(result.deploy), port: result.port };
      });
    },
    async "storage.test"({ backend, secrets }) {
      return testStorage(deps, backend, secrets);
    },
    async "challenge.get"() {
      return { token: await challengeToken(deps) };
    },
    async "app.delete"({ app }) {
      return deleteApp(deps, app);
    },
    async "domains.get"({ app }) {
      return { domains: await readDomains(deps, app) };
    },
    async "domains.set"({ app, domains, registryAuth, logId }) {
      return withDeployLog(deps, logId, async (log) => {
        const result = await setDomains(deps, app, domains, { skipVerify: deps.dev, log, registryAuth });
        return { domains: result.domains, deploy: deployResultOrNull(result.deploy), mode: result.mode };
      });
    },
    async "git.keygen"({ app, rotate }) {
      return ensureDeployKey(deps, app, { rotate });
    },
    async "ssh.import"({ privateKey, passphrase }) {
      return importSshKey(deps, privateKey, passphrase);
    },
    async "ssh.generate"({ comment }) {
      return generateSshKey(deps, comment);
    },
    async "git.branches"({ repository, auth }) {
      return listBranches(deps, BRANCHES_SCOPE, repository, auth);
    },
    async "git.inspect"({ repository, branch, subpath, auth }) {
      return inspectRepo(deps, { repository, branch, subpath, auth });
    },
    async "git.check"({ app, repository, branch, auth }) {
      return { sha: await checkRemote(deps, app, repository, branch, auth) };
    },
    async "git.deploy"({ app, buildId, repository, branch, subpath, skipIfUnchanged, fallbackManifest, configText, registryAuth, auth }) {
      return withOperation(buildId, async (signal) => {
        const result = await gitDeploy(deps, {
          app,
          buildId,
          repository,
          branch,
          subpath,
          skipIfUnchanged,
          fallbackManifest,
          configText,
          registryAuth,
          skipVerify: deps.dev,
          auth,
          signal,
        });
        return result.skipped
          ? { skipped: true, commit: result.commit, buildSeconds: 0 }
          : { skipped: false, commit: result.commit, buildSeconds: result.buildSeconds, deploy: toDeployResult(result.deploy) };
      });
    },
    async "build.log"({ id, from }) {
      return buildLogChunk(deps, id, from);
    },
    async "app.rollback"({ app, release }) {
      return rollback(deps, app, { target: release, skipVerify: deps.dev });
    },
    async "app.control"({ app, verb, service }) {
      return { units: await controlApp(deps, app, verb, service) };
    },
    async "app.logs"({ app, service, lines }) {
      const unit = await resolveServiceUnit(deps, app, service);
      const r = await deps.run("journalctl", deps.systemd.logsArgs(unit, { lines }));
      return { text: r.stdout };
    },
    async "metrics.snapshot"() {
      return { samples: await collectMetrics(deps) };
    },
    async "env.list"({ app, service }) {
      return { names: await listEnvNames(deps, app, service) };
    },
    async "env.set"({ app, service, key, value }) {
      await setEnv(deps, app, service, key, value);
      return {};
    },
    async "config.get"() {
      return { fields: await readSettings(resolveConfigPath(deps)) };
    },
    async "config.set"({ changes }) {
      const path = resolveConfigPath(deps);
      const r = await applySettings(path, changes);
      let haproxy: "applied" | "manual" | "none" = "none";
      if (r.haproxyChanged) {
        try {
          haproxy = await applyHaproxyListeners(deps, r.config);
        } catch (e) {
          await copyFile(`${path}.bak`, path).catch(() => {}); // HAProxy said no: leave the file as it was
          throw e;
        }
      }
      return { changed: r.changed, restart: r.restart, haproxy };
    },
    async "service.restart"({ service }) {
      // After the reply is on the wire: restarting the agent ends this very process.
      const serviceName = service === "api" ? API_SERVICE : AGENT_SERVICE;
      setTimeout(() => void deps.run("systemctl", ["restart", "--no-block", serviceName]), SERVICE_RESTART_DELAY_MS).unref();
      return {};
    },
    async "certs.status"() {
      return { certs: (await certStatus(deps)).map((c) => ({ hostname: c.hostname, expires: toIso(c.expires) })) };
    },
    async "certs.renew"({ force }) {
      return { certs: (await renewCerts(deps, { force })).map((c) => ({ ...c, expires: toIso(c.expires) })) };
    },
  };
}

export function classify(error: unknown): WireError {
  if (error instanceof DeployFailedError) {
    return { code: "deploy_failed", message: error.message, rolledBackTo: error.rolledBackTo, releaseId: error.releaseId, historyAt: error.historyAt };
  }
  if (error instanceof BuildFailedError) return { code: "build_failed", message: error.message, logTail: error.logTail };
  if (error instanceof FileError) return { code: error.code, message: error.message };
  if (error instanceof ConsoleError) return { code: error.code, message: error.message };
  if (error instanceof FirewallError) return { code: error.code === "unavailable" ? "bad_request" : error.code, message: error.message };
  if (error instanceof ProcessError) return { code: error.code, message: error.message };
  if (error instanceof CanceledError) return { code: "conflict", message: error.message };
  if (error instanceof UpgradeError) return { code: /in progress/.test(error.message) ? "conflict" : "bad_request", message: error.message };
  if (error instanceof BadRequest || error instanceof SettingsError) return { code: "bad_request", message: error.message };
  if (error instanceof ZodError) {
    return { code: "bad_request", message: formatIssues(error.issues, "(root)") };
  }
  const message = describeError(error);
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
    const handler = handlers[op] as unknown as (handlerArgs: unknown) => Promise<unknown>;
    const result = await handler(args);
    return { id, ok: true, result };
  } catch (e) {
    if (e instanceof SyntaxError) return { id, ok: false, error: { code: "bad_request", message: "invalid JSON" } };
    return { id, ok: false, error: classify(e) };
  }
}
