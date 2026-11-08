import { HOSTNAME_RE, IDENT_RE } from "@freighter/manifest";
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
      artifact: z.string().min(1),
      manifestText: z.string().min(1).max(262_144),
      skipVerify: z.boolean().optional(),
      /** Replace the app's domains with this deploy (kept only if the release goes live). Omitted: keep them. */
      domains: z.array(domain).max(200).optional(),
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
    args: z.object({ app, domains: z.array(domain).max(200) }),
    result: z.object({
      domains: z.array(domain),
      deploy: deployResult.nullable(),
      /** How it took effect (older agents don't say): `routing` means HAProxy was updated and nothing was redeployed. */
      mode: z.enum(["unchanged", "saved", "routing", "deploy"]).optional(),
    }),
  },
  /** The string this server's HAProxy serves at /.well-known/freighter-challenge: proof, for domain checks, that a hostname reaches this server. */
  "challenge.get": { args: z.object({}), result: z.object({ token: z.string() }) },
  /** Upgrade this agent in place by re-running the installer for `ref` (default `main`); rolls back unless `upgrade.confirm` arrives. */
  "upgrade.start": {
    args: z.object({ ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional() }),
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
      haproxy: z.object({ mode: z.enum(["dedicated", "existing"]), instructions: z.string().nullable() }).optional(),
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
    }),
    result: z.object({ skipped: z.boolean(), commit, buildSeconds: z.number(), deploy: deployResult.optional() }),
  },
  "build.log": {
    args: z.object({ id: z.string().regex(/^[0-9a-f-]{8,64}$/), from: z.number().int().min(0).default(0) }),
    result: z.object({ text: z.string(), next: z.number(), done: z.boolean() }),
  },
  "env.list": { args: z.object({ app }), result: z.object({ names: z.array(z.string()) }) },
  "env.set": {
    args: z.object({ app, key: envKey, value: z.string().max(65_536).refine((v) => !/[\r\n\0]/.test(v), "no newlines") }),
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
export const RAW_OPS: ReadonlySet<string> = new Set(["artifact.put"]);
