import { HOSTNAME_RE, IDENT_RE, connectionsSchema, storageBackendSchema, storageNameSchema, storageSecretsSchema } from "@freighter/manifest";
import { z } from "zod";

const app = z.string().regex(IDENT_RE);
const ident = z.string().regex(IDENT_RE);
const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const iso = z.string();
const domain = z.object({ hostname: z.string().regex(HOSTNAME_RE), service: ident, tls: z.enum(["auto", "off"]).default("auto") });

const serviceStatus = z.object({
  unit: z.string(),
  port: z.number().nullish(),
  hostnames: z.array(z.string()),
  activeState: z.string(),
  subState: z.string(),
  mainPid: z.number(),
  memoryCurrent: z.number().nullable(),
  restarts: z.number(),
  cpuNanos: z.number().nullable().optional(),
});
const releaseInfo = z.object({
  id: z.string(),
  current: z.boolean(),
  result: z.enum(["success", "failed"]).optional(),
  at: iso.optional(),
});
const historyEntry = z.object({
  at: iso,
  action: z.enum(["deploy", "rollback"]),
  release: z.string(),
  previous: z.string().nullable(),
  result: z.enum(["success", "failed"]),
  reason: z.string().optional(),
  source: z.object({ type: z.literal("git"), sha: z.string(), ref: z.string(), subject: z.string().optional(), author: z.string().optional() }).optional(),
});

const deployResult = z.object({
  app: z.string(),
  releaseId: z.string(),
  previous: z.string().nullable(),
  units: z.array(z.string()),
  removed: z.array(z.string()),
  pruned: z.array(z.string()),
  hostnames: z.array(z.string()),
  warnings: z.array(z.string()),
  verified: z.boolean(),
  historyAt: iso,
});
const configField = z.object({
  key: z.string(),
  section: z.string(),
  label: z.string(),
  help: z.string(),
  type: z.enum(["string", "number", "boolean", "list", "enum"]),
  scope: z.enum(["agent", "control"]),
  restart: z.enum(["none", "agent", "api"]),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  placeholder: z.string().optional(),
  haproxy: z.boolean().optional(),
  value: z.unknown(),
  default: z.unknown(),
  explicit: z.boolean(),
});
const configValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.array(z.string().max(300)).max(50), z.null()]);
const upgradeState = z.enum(["running", "verifying", "rolling-back", "done", "rolled-back", "failed"]);
const upgradeInfo = z.object({
  state: upgradeState,
  from: z.string().nullable(),
  to: z.string().nullable(),
  ref: z.string().nullable(),
  startedAt: iso.nullable(),
  updatedAt: iso.nullable(),
  message: z.string().nullable(),
});
const commit = z.object({ sha: z.string(), subject: z.string(), author: z.string() });
const repoArgs = { repository: z.string().min(1).max(300), branch: z.string().min(1).max(100), auth: z.object({ sshKey: z.string().min(40).max(20000) }).optional() };

/** The entire privileged surface of the agent: operation name -> argument and result schemas. */
const fsPath = z.string().min(1).max(4096);
const fsPaths = z.array(fsPath).min(1).max(1000);
const fsConflict = z.enum(["fail", "overwrite", "rename"]);
const fwPolicy = z.enum(["allow", "deny", "reject"]);
const fwStatus = z.object({
  installed: z.boolean(),
  active: z.boolean(),
  defaults: z.object({ incoming: fwPolicy, outgoing: fwPolicy, routed: z.union([fwPolicy, z.literal("disabled")]) }).nullable(),
  logging: z.string().nullable(),
  rules: z.array(z.object({ number: z.number(), to: z.string(), action: z.enum(["allow", "deny", "reject", "limit"]), direction: z.enum(["in", "out", "fwd"]), from: z.string(), comment: z.string(), v6: z.boolean() })),
  /** Ports the firewall must keep open for the server to stay manageable (SSH, the web ports, the agent). */
  essential: z.array(z.object({ port: z.number(), what: z.string() })),
});
/** Logins for the registries images come from: used for the pulls of this one call, and never stored by the agent. */
const registryAuth = z.array(z.object({ host: z.string().min(1).max(255), username: z.string().min(1).max(255), password: z.string().min(1).max(4096) })).max(16).optional();
/** A storage's name; with it a path is `/bucket/key` inside that storage instead of a path on the server. */
const storageRef = z.string().regex(/^[a-z][a-z0-9-]*$/).max(40);
const storageEntry = z.object({ name: z.string(), type: z.enum(["dir", "file"]), size: z.number(), mtimeMs: z.number() });
const fsBulk = z.object({ done: z.array(z.string()), failed: z.array(z.object({ path: z.string(), error: z.string() })) });
const fsEntry = z.object({
  name: z.string(),
  type: z.enum(["dir", "file", "link", "other"]),
  size: z.number(),
  mtimeMs: z.number(),
  mode: z.number(),
  uid: z.number(),
  gid: z.number(),
  owner: z.string().nullable(),
  group: z.string().nullable(),
  link: z.object({ target: z.string(), type: z.enum(["dir", "file", "other", "missing"]) }).optional(),
});
const fsListing = z.object({ path: z.string(), parent: z.string().nullable(), entries: z.array(fsEntry), truncated: z.boolean() });

export const ops = {
  ping: {
    args: z.object({}),
    result: z.object({
      /** The checked-out commit (12 hex characters), or "0.0.0" when not running from a checkout. */
      version: z.string(),
      time: iso,
      hostname: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      /** Set while an upgrade waits for the control plane to confirm the new agent (answer with `upgrade.confirm`). */
      upgrade: upgradeState.optional(),
    }),
  },
  "host.status": {
    args: z.object({}),
    result: z.object({
      hostname: z.string(),
      uptimeSeconds: z.number(),
      load1: z.number(),
      memTotal: z.number(),
      memFree: z.number(),
      diskTotalBytes: z.number().nullable(),
      diskFreeBytes: z.number().nullable(),
      /** Whether this host can run image services (Podman installed) and which version. Absent on agents without image support. */
      containers: z.object({ available: z.boolean(), version: z.string().optional() }).optional(),
      /** Whether this host can serve S3 storages (a new enough rclone is installed). Absent on agents that predate storage. */
      storage: z.object({ available: z.boolean(), version: z.string().optional() }).optional(),
      /** Whether this host can mount SMB and NFS volumes. Absent on agents that predate volumes. */
      mounts: z.object({ smb: z.boolean(), nfs: z.boolean() }).optional(),
      /** Which archive tools this host has (tar always): unzip for zip, 7z for 7z and rar. Absent on agents that predate extraction. */
      archives: z.object({ unzip: z.boolean(), sevenZip: z.boolean() }).optional(),
      /** Logical CPUs, and the operating system as `uname` would say. Absent on agents that predate the file explorer. */
      cpus: z.number().optional(),
      os: z.string().optional(),
      /** Whether the file explorer is on, and whether it may change anything. */
      files: z.object({ enabled: z.boolean(), readOnly: z.boolean() }).optional(),
      /** Whether ufw is installed, and what this server allows of the firewall tab (readOnly: looking only). */
      firewall: z.object({ installed: z.boolean(), enabled: z.boolean(), readOnly: z.boolean() }).optional(),
      /** Whether this agent offers a console (absent on agents that predate it). */
      console: z.object({ enabled: z.boolean() }).optional(),
      /** Likewise for the process list (readOnly: no signals). */
      processes: z.object({ enabled: z.boolean(), readOnly: z.boolean() }).optional(),
    }),
  },
  /** Header line only; `size` raw bytes follow on the same connection (see framing.ts). */
  "artifact.put": {
    args: z.object({ id: z.string().uuid(), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    result: z.object({ path: z.string() }),
  },
  "artifact.delete": { args: z.object({ id: z.string().uuid() }), result: z.object({}) },
  "apps.list": { args: z.object({}), result: z.object({ apps: z.array(z.string()) }) },
  "app.info": {
    args: z.object({ app }),
    result: z.object({
      app: z.string(),
      release: z.string().nullable(),
      previous: z.string().nullable(),
      manifestText: z.string().nullable(),
      services: z.record(z.string(), serviceStatus),
      releases: z.array(releaseInfo),
    }),
  },
  "app.history": {
    args: z.object({ app, limit: z.number().int().min(1).max(500).default(50) }),
    result: z.object({ entries: z.array(historyEntry) }),
  },
  "app.deploy": {
    args: z.object({
      /** The uploaded artifact. Omitted for an app whose services are all images (nothing to unpack). */
      artifact: z.string().min(1).optional(),
      manifestText: z.string().min(1).max(262_144),
      skipVerify: z.boolean().optional(),
      /** Logins for the registries the images come from; used for the pulls only and never stored by the agent. */
      registryAuth,
      /** Write what the deploy does to this deployment's log, so `build.log` can show it. */
      logId: z.string().optional(),
      /** Replace the app's domains with this deploy (kept only if the release goes live). Omitted: keep them. */
      domains: z.array(domain).max(200).optional(),
      /** Make this app.yaml the app's configuration, replacing the one it has. Omitted: an app that has one keeps it. */
      replaceConfig: z.boolean().optional(),
    }),
    result: deployResult,
  },
  /** Remove an app from this server completely: units, routing, certificates, releases, shared data, secrets. Irreversible. */
  "app.delete": {
    args: z.object({ app }),
    result: z.object({ app: z.string(), units: z.array(z.string()), hostnames: z.array(z.string()) }),
  },
  "domains.get": { args: z.object({ app }), result: z.object({ domains: z.array(domain) }) },
  "domains.set": {
    args: z.object({
      app,
      domains: z.array(domain).max(200),
      registryAuth,
      /** Write what happens to this deployment's log, so `build.log` can show it. */
      logId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional(),
    }),
    result: z.object({
      domains: z.array(domain),
      deploy: deployResult.nullable(),
      /** How it took effect (older agents don't say): `routing` means HAProxy was updated and nothing was redeployed. */
      mode: z.enum(["unchanged", "saved", "routing", "deploy"]).optional(),
    }),
  },
  /** Tell the agent what the app may connect to (`@other/api.url`): the next deploy, rollback or domain change resolves against it. Agents with the "connections" capability only. */
  "connections.set": {
    args: z.object({ app }).extend(connectionsSchema.shape),
    result: z.object({}),
  },
  /** The string this server's HAProxy serves at /.well-known/freighter-challenge: proof, for domain checks, that a hostname reaches this server. */
  "challenge.get": { args: z.object({}), result: z.object({ token: z.string() }) },
  /** Upgrade this agent in place by re-running the installer for `ref` (default `main`); rolls back unless `upgrade.confirm` arrives. */
  "upgrade.start": {
    args: z.object({
      ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional(),
      /**
       * Re-run the installer with `--with-containers` (Podman) at the version that is installed now, instead of moving
       * to `ref`. Agents with the "containers.install" capability only.
       */
      withContainers: z.boolean().optional(),
      /** Likewise with `--with-storage` (rclone, for S3 storages). Agents with the "storage.install" capability only. */
      withStorage: z.boolean().optional(),
      /** Likewise with `--with-mounts` (cifs-utils and nfs-common, for SMB and NFS volumes). Agents with the "mounts.install" capability only. */
      withMounts: z.boolean().optional(),
      /** Likewise with `--with-archives` (7z and unzip, for extracting archives in the file explorer). Agents with the "archives.install" capability only. */
      withArchives: z.boolean().optional(),
      /** Likewise with `--with-firewall` (ufw, for the firewall tab; installed, not turned on). Agents with the "firewall.install" capability only. */
      withFirewall: z.boolean().optional(),
    }),
    result: z.object({ started: z.literal(true) }),
  },
  "upgrade.status": {
    args: z.object({}),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().nullable(),
      commit: z.string().nullable(),
      upgrade: upgradeInfo.nullable(),
      log: z.string(),
      /** Optional: agents from before this field don't send it. */
      haproxy: z.object({ mode: z.enum(["dedicated", "existing"]) }).optional(),
    }),
  },
  /** Ask the repository this agent was installed from (with the agent's own git) what is new on `ref` (default `main`). Changes nothing on the server. */
  "upgrade.check": {
    args: z.object({ ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional() }),
    result: z.object({
      ref: z.string(),
      installed: z.object({ commit: z.string(), subject: z.string(), committedAt: iso }).nullable(),
      latest: z.object({ commit: z.string(), subject: z.string(), committedAt: iso }),
      state: z.enum(["up-to-date", "behind", "ahead", "different"]),
      behind: z.number().nullable(),
      commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
      checkedAt: iso,
    }),
  },
  "upgrade.confirm": { args: z.object({}), result: z.object({ confirmed: z.boolean() }) },
  "app.rollback": {
    args: z.object({ app, release: ident.optional() }),
    result: z.object({ app: z.string(), from: z.string(), to: z.string(), verified: z.boolean(), historyAt: iso }),
  },
  "app.control": {
    args: z.object({ app, verb: z.enum(["start", "stop", "restart"]), service: ident.optional() }),
    result: z.object({ units: z.array(z.string()) }),
  },
  "app.logs": {
    args: z.object({ app, service: ident, lines: z.number().int().min(1).max(1000).default(100) }),
    result: z.object({ text: z.string() }),
  },
  "metrics.snapshot": {
    args: z.object({}),
    result: z.object({
      samples: z.array(
        z.object({
          app: z.string(),
          service: z.string(),
          unit: z.string(),
          activeState: z.string(),
          memoryBytes: z.number().nullable(),
          cpuNanos: z.number().nullable(),
          restarts: z.number(),
        }),
      ),
    }),
  },
  "git.keygen": {
    args: z.object({ app, rotate: z.boolean().optional() }),
    result: z.object({ publicKey: z.string(), fingerprint: z.string() }),
  },
  /** Validate a pasted private key (decrypting it if needed) and return the normalised key with its public half. */
  "ssh.import": {
    args: z.object({ privateKey: z.string().min(1).max(20000), passphrase: z.string().max(1000).optional() }),
    result: z.object({ privateKey: z.string(), publicKey: z.string(), fingerprint: z.string(), keyType: z.string(), comment: z.string() }),
  },
  "ssh.generate": {
    args: z.object({ comment: z.string().max(64).default("freighter") }),
    result: z.object({ privateKey: z.string(), publicKey: z.string(), fingerprint: z.string(), keyType: z.string(), comment: z.string() }),
  },
  "git.branches": {
    args: z.object({ repository: repoArgs.repository, auth: repoArgs.auth }),
    result: z.object({ branches: z.array(z.object({ name: z.string(), default: z.boolean() })), defaultBranch: z.string().nullable() }),
  },
  "git.inspect": {
    args: z.object({ ...repoArgs, subpath: z.string().max(200).optional() }),
    result: z.object({
      sha: z.string(),
      commit,
      hasManifest: z.boolean(),
      valid: z.boolean(),
      appName: z.string().nullable(),
      error: z.string().nullable(),
      buildCommands: z.array(z.string()),
      /** What app.yaml says, as settings (everything but the name), to start a new app from. */
      settings: z.record(z.string(), z.unknown()).nullable().default(null),
    }),
  },
  "git.check": { args: z.object({ app, ...repoArgs }), result: z.object({ sha: z.string() }) },
  "git.deploy": {
    args: z.object({
      app,
      /** Names the build and its log; the API uses the deployment id. */
      buildId: z.string().regex(/^[0-9a-f-]{8,64}$/),
      ...repoArgs,
      subpath: z.string().max(200).optional(),
      skipIfUnchanged: z.boolean().optional(),
      /** The app.yaml to use when the repository has none (rendered from the settings entered in the UI). */
      fallbackManifest: z.string().max(262_144).optional(),
      registryAuth,
      /** A new configuration for the app: saved first, then built and deployed with. */
      configText: z.string().max(262_144).optional(),
    }),
    result: z.object({ skipped: z.boolean(), commit, buildSeconds: z.number(), deploy: deployResult.optional() }),
  },
  "build.log": {
    args: z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/), from: z.number().int().min(0).default(0) }),
    result: z.object({ text: z.string(), next: z.number(), done: z.boolean() }),
  },
  /** The app's configuration (what app.yaml described when it started): the text, or null before its first deploy. Agents with "app.config" only. */
  "app.config.get": { args: z.object({ app }), result: z.object({ manifestText: z.string().nullable() }) },
  "app.config.set": {
    args: z.object({ app, manifestText: z.string().min(1).max(262_144), registryAuth, logId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional() }),
    result: z.object({ deploy: deployResult.nullable() }),
  },
  // ---- the file explorer: every file on the server, as root. Admins only (the API enforces it). ----
  /** A folder's entries. */
  "fs.list": { args: z.object({ path: fsPath }), result: fsListing },
  "fs.mkdir": { args: z.object({ path: fsPath }), result: z.object({}) },
  "fs.rename": { args: z.object({ path: fsPath, name: z.string().min(1).max(255) }), result: z.object({ path: z.string() }) },
  "fs.copy": { args: z.object({ paths: fsPaths, to: fsPath, onConflict: fsConflict.default("fail") }), result: fsBulk },
  "fs.move": { args: z.object({ paths: fsPaths, to: fsPath, onConflict: fsConflict.default("fail") }), result: fsBulk },
  /** Unpack archives (by extension) into a folder named after each, in `to` or beside the archive. */
  "fs.extract": { args: z.object({ paths: fsPaths, to: fsPath.optional(), onConflict: fsConflict.default("rename") }), result: fsBulk },
  /** The server's users and groups (names and numbers), for choosing an owner. */
  "fs.identities": {
    args: z.object({}),
    result: z.object({ users: z.array(z.object({ name: z.string(), id: z.number() })), groups: z.array(z.object({ name: z.string(), id: z.number() })) }),
  },
  /** Change the owner and/or group of paths, by name or number; `recursive` goes through folders. */
  "fs.chown": {
    args: z.object({ paths: fsPaths, owner: z.string().min(1).max(64).optional(), group: z.string().min(1).max(64).optional(), recursive: z.boolean().default(false) }),
    result: fsBulk,
  },
  /** Ask a deploy, build or pull that is running under this id (the deployment's) to stop. `canceled` is false when nothing is running under it here. */
  "deploy.cancel": { args: z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/) }), result: z.object({ canceled: z.boolean() }) },
  // ---- the process list. Admins only (the API enforces it). ----
  "processes.list": {
    args: z.object({}),
    result: z.object({
      cpus: z.number(),
      memTotal: z.number(),
      uptimeSeconds: z.number(),
      processes: z.array(
        z.object({
          pid: z.number(),
          ppid: z.number(),
          name: z.string(),
          command: z.string(),
          user: z.string(),
          uid: z.number(),
          state: z.string(),
          cpu: z.number(),
          rss: z.number(),
          threads: z.number(),
          startedMs: z.number(),
          starttime: z.number(),
          unit: z.string().nullable(),
          managed: z.object({ kind: z.enum(["app", "storage", "build", "platform"]), app: z.string().nullable(), service: z.string().nullable() }).nullable(),
          kernel: z.boolean(),
        }),
      ),
    }),
  },
  /** Send a signal to one process; `starttime` (from the list) must still match, so a reused pid is never hit. */
  "processes.signal": { args: z.object({ pid: z.number().int().positive(), starttime: z.number().int().nonnegative(), signal: z.enum(["TERM", "KILL", "HUP", "INT", "STOP", "CONT"]) }), result: z.object({}) },
  // ---- the firewall (ufw). Admins only (the API enforces it). A change that would cut off SSH, the web ports or the agent is refused with `conflict` unless `acknowledged`. ----
  "firewall.status": { args: z.object({}), result: fwStatus },
  "firewall.add": {
    args: z.object({
      action: z.enum(["allow", "deny", "reject", "limit"]),
      direction: z.enum(["in", "out"]).optional(),
      proto: z.enum(["tcp", "udp", "any"]).optional(),
      port: z.string().max(100).optional(),
      from: z.string().max(60).optional(),
      to: z.string().max(60).optional(),
      comment: z.string().max(80).optional(),
      position: z.number().int().min(1).max(500).optional(),
      acknowledged: z.boolean().optional(),
    }),
    result: fwStatus,
  },
  /** `signature` is the rule as it was shown (see core's `signature`): a changed list is refused, since numbers move. */
  "firewall.delete": { args: z.object({ number: z.number().int().min(1), signature: z.string().min(1).max(300), twin: z.boolean().optional(), acknowledged: z.boolean().optional() }), result: fwStatus },
  /** Allow the essential ports (and `open`), then turn it on. */
  "firewall.enable": { args: z.object({ open: z.array(z.number().int().min(1).max(65535)).max(50).optional() }), result: fwStatus },
  "firewall.disable": { args: z.object({}), result: fwStatus },
  "firewall.default": { args: z.object({ direction: z.enum(["incoming", "outgoing"]), policy: fwPolicy, acknowledged: z.boolean().optional() }), result: fwStatus },
  "fs.delete": { args: z.object({ paths: fsPaths }), result: fsBulk },
  /** Header line, then `size` raw bytes that become the file (written beside it and renamed in when complete). */
  "fs.write": { args: z.object({ path: fsPath, size: z.number().int().nonnegative(), overwrite: z.boolean().default(false), storage: storageRef.optional() }), result: z.object({}) },
  /** The reply line is followed by `size` raw bytes of the file. */
  "fs.read": { args: z.object({ path: fsPath, storage: storageRef.optional() }), result: z.object({ size: z.number(), mtimeMs: z.number() }) },
  // ---- what a storage holds (buckets and keys, through the storage's own backend). Upload and download are `fs.write` and `fs.read` with `storage`. ----
  "storage.ls": { args: z.object({ name: storageRef, path: fsPath.default("/") }), result: z.object({ path: z.string(), parent: z.string().nullable(), entries: z.array(storageEntry), truncated: z.boolean() }) },
  "storage.mkdir": { args: z.object({ name: storageRef, path: fsPath }), result: z.object({}) },
  "storage.rename": { args: z.object({ name: storageRef, path: fsPath, newName: z.string().min(1).max(1024) }), result: z.object({ path: z.string() }) },
  "storage.rm": { args: z.object({ name: storageRef, paths: fsPaths }), result: fsBulk },
  /**
   * An interactive shell for a service: in its home, as its user (inside the container for an image). The reply line is
   * followed by frames in both directions until the shell ends or the connection closes (see console.ts).
   */
  "console.open": {
    args: z.object({
      app: ident,
      service: ident,
      cols: z.number().int().min(1).max(1000).default(80),
      rows: z.number().int().min(1).max(1000).default(24),
      /** Run this command (as it is, no shell) instead of an interactive shell. */
      command: z.array(z.string().max(8192)).min(1).max(512).optional(),
      /** On a terminal (the default), or with plain pipes: separate standard output and error, no terminal behaviour. */
      tty: z.boolean().default(true),
      /** Variables for the command, over the service's own. */
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768)).optional(),
    }),
    result: z.object({ kind: z.enum(["host", "container"]), user: z.string(), cwd: z.string(), shell: z.string() }),
  },
  /** The reply line is followed by a ZIP of the paths, until the connection closes. */
  "fs.archive": { args: z.object({ paths: fsPaths }), result: z.object({}) },
  /** The remote volumes an app's configuration declares: what is mounted, and whether an SMB password is set. Agents with "volumes" only. */
  "volumes.status": {
    args: z.object({ app }),
    result: z.object({ volumes: z.record(ident, z.object({ type: z.string(), state: z.string(), password: z.boolean().nullable() })) }),
  },
  /** Set the password of an SMB volume declared in the app's configuration. It is written to a root-only file and never read back. */
  "volumes.password.set": { args: z.object({ app, name: ident, password: z.string().min(1).max(256) }), result: z.object({}) },
  /** Variables added on the server, per service, on top of each service's `environment:` in app.yaml. Agents with the "variables" capability only. */
  "variables.get": { args: z.object({ app }), result: z.object({ variables: z.record(ident, z.record(envKey, z.string())) }) },
  "variables.set": {
    args: z.object({
      app,
      service: ident,
      set: z.record(envKey, z.string().max(65_536).refine((v) => !/[\r\n\0]/.test(v), "no newlines")).optional(),
      remove: z.array(envKey).max(200).optional(),
      logId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional(),
    }),
    result: z.object({ variables: z.record(envKey, z.string()), deploy: deployResult.nullable() }),
  },
  /** Create or update the S3 endpoint of a storage (an app the agent manages). Agents with the "storage" capability only. */
  "storage.apply": {
    args: z.object({
      name: storageNameSchema,
      backend: storageBackendSchema,
      accessKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9]+$/),
      secretKey: z.string().min(16).max(256).regex(/^[A-Za-z0-9+/_-]+$/),
      secrets: storageSecretsSchema.optional(),
      /** Also serve everything read-only and without a key, from a second endpoint (a `public` service). */
      public: z.boolean().optional(),
      logId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional(),
    }),
    /** `port`: where the endpoint listens while it has no domain (the agent picks it the first time and keeps it). */
    result: z.object({ deploy: deployResult, port: z.number() }),
  },
  /** Try a backend without creating anything. For SFTP without a pinned host key, returns the key to confirm instead. */
  "storage.test": {
    args: z.object({ backend: storageBackendSchema, secrets: storageSecretsSchema.optional() }),
    result: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      hostKey: z.object({ line: z.string(), fingerprint: z.string(), type: z.string() }).optional(),
    }),
  },
  /** Redeploy the current release unchanged if something its connections resolve to has changed since it went live. Agents with the "reapply" capability only. */
  "app.reapply": {
    args: z.object({ app, registryAuth, logId: z.string().regex(/^[0-9a-f-]{8,64}$/).optional() }),
    result: z.object({ changed: z.boolean(), deploy: deployResult.nullable() }),
  },
  /** The names of a service's secrets that have a value. */
  "env.list": { args: z.object({ app, service: ident }), result: z.object({ names: z.array(z.string()) }) },
  "env.set": {
    args: z.object({ app, service: ident, key: envKey, value: z.string().max(65_536).refine((v) => !/[\r\n\0]/.test(v), "no newlines") }),
    result: z.object({}),
  },
  "certs.status": {
    args: z.object({}),
    result: z.object({ certs: z.array(z.object({ hostname: z.string(), expires: iso.nullable() })) }),
  },
  "certs.renew": {
    args: z.object({ force: z.boolean().optional() }),
    result: z.object({ certs: z.array(z.object({ hostname: z.string(), issued: z.boolean(), expires: iso.nullable() })) }),
  },
  /** The settings that can be changed from the dashboard, with their current values. */
  "config.get": { args: z.object({}), result: z.object({ fields: z.array(configField) }) },
  /** Change settings (key -> value, or null to go back to the default). All or nothing. */
  "config.set": {
    args: z.object({ changes: z.record(z.string(), configValue) }),
    result: z.object({
      changed: z.array(z.string()),
      /** Services that have to be restarted before the changes take effect. */
      restart: z.array(z.enum(["agent", "api"])),
      /** HAProxy listener ports: "applied" to a Freighter-managed config, "manual" for one you maintain, "none" when unaffected. */
      haproxy: z.enum(["applied", "manual", "none"]),
    }),
  },
  "service.restart": { args: z.object({ service: z.enum(["agent", "api"]) }), result: z.object({}) },
} as const;

export type OpName = keyof typeof ops;
export type OpArgs<N extends OpName> = z.input<(typeof ops)[N]["args"]>;
export type OpResult<N extends OpName> = z.infer<(typeof ops)[N]["result"]>;

export const request = z.object({ id: z.string().min(1).max(64), op: z.string(), args: z.unknown().optional() });

export const errorCodes = ["bad_request", "not_found", "conflict", "deploy_failed", "build_failed", "internal"] as const;
export type ErrorCode = (typeof errorCodes)[number];
export interface ErrorExtra {
  rolledBackTo?: string | null;
  releaseId?: string;
  historyAt?: string;
  /** Last lines of a failed build. */
  logTail?: string;
}
export interface WireError extends ErrorExtra {
  code: ErrorCode;
  message: string;
}
export type Reply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: WireError };

export const MAX_LINE_BYTES = 1_048_576;

/** Operations that carry a raw byte stream after the header line; the generic dispatcher must not run them. */
export const RAW_OPS: ReadonlySet<string> = new Set(["artifact.put", "fs.write", "fs.read", "fs.archive", "console.open"]);
