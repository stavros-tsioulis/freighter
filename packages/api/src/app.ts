import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { IDENT_RE, domainSchema, environmentValues, findReferences, referencedStorages, storageApp, storageBackendSchema, storageNameSchema, storageOfApp, storageSecretsSchema, type StorageBackend, type StorageSecrets, imageHost, foldSharedEnvironment, imageServices, parseManifest, renderManifest, settingsSchema, validateBranch, validateRepoUrl, validateSubpath } from "@freighter/manifest";
import { AgentError, ops } from "@freighter/protocol";
import { assertValidCsr, certExpiry, fingerprint, issueServerCert } from "@freighter/pki";
import { isRole, type GitLinkRow, type PendingDomainRow, type Role, type StorageRow } from "@freighter/registry";
import {
  createApp,
  createRouter,
  defineEventHandler,
  getHeader,
  getQuery,
  getRequestURL,
  getRequestWebStream,
  getRouterParam,
  readBody,
  readRawBody,
  deleteCookie,
  getRequestProtocol,
  setCookie,
  setResponseStatus,
  type H3Event,
} from "h3";
import { z, ZodError } from "zod";
import { SESSION_COOKIE, assertCsrfHeader, authenticate, clientIp, createFailureLimiter } from "./auth.ts";
import { buildSeries } from "./metrics.ts";
import { buildGraph } from "./graph.ts";
import { buildConnections, ownFacts, pushConnections } from "./connections.ts";
import { resolveEnvironmentEach } from "@freighter/core/references";
import type { ApiContext, Principal } from "./context.ts";
import { ApiError, toHttpError } from "./errors.ts";
import { createJobs, type Jobs } from "./jobs.ts";
import { MAX_LINK_SECONDS, presignGet } from "./presign.ts";
import { parseAddress } from "./agents.ts";
import { createControlSettings } from "./control-settings.ts";
import { parseHostConfig } from "@freighter/core/config";
import { SettingsError } from "@freighter/core/fields";
import { checkDomainDns, type ChallengeProbe, isLocalName, isPrivateOrLoopback, resolveAll, systemDns, type DnsResolver } from "./dns.ts";
import { checkServer, reachableServers } from "./servers.ts";
import { checkServerUpdates, controlVersion, startServerUpgrade, UpgradeRefused, upgradeView } from "./upgrade.ts";
import { syncAll, syncApp, type SyncResult } from "./sync.ts";

const execFileP = promisify(execFile);

export interface Api {
  /** h3 app with routes under /v1 and /health; mount it under /api. */
  app: ReturnType<typeof createApp>;
  jobs: Jobs;
  syncAll(opts?: { force?: boolean }): Promise<SyncResult | { skipped: true }>;
}

const appName = z.string().regex(IDENT_RE, "invalid app name");
const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "invalid env key");
const optionalIdent = z.string().regex(IDENT_RE).optional();

async function body<T extends z.ZodTypeAny>(event: H3Event, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = (await readBody(event)) ?? {};
  } catch {
    throw new ApiError(400, "bad_request", "request body must be valid JSON");
  }
  return schema.parse(raw);
}

const limitParam = (event: H3Event, fallback: number) => {
  const n = Number(getQuery(event).limit ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 500) : fallback;
};

/** Stream the request body to the spool dir, enforcing the size cap and hashing as we go. */
async function receiveArtifact(event: H3Event, ctx: ApiContext, id: string): Promise<{ path: string; sha256: string }> {
  const declared = Number(getHeader(event, "content-length") ?? 0);
  if (declared > ctx.maxUploadBytes) throw new ApiError(413, "payload_too_large", `artifact exceeds ${Math.round(ctx.maxUploadBytes / 1048576)} MiB`);
  const web = getRequestWebStream(event);
  if (!web) throw new ApiError(400, "bad_request", "request body must be a .tar.gz artifact");

  await mkdir(ctx.artifactsDir, { recursive: true, mode: 0o770 });
  const path = join(ctx.artifactsDir, `${id}.tar.gz`);
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > ctx.maxUploadBytes) return cb(new ApiError(413, "payload_too_large", `artifact exceeds ${Math.round(ctx.maxUploadBytes / 1048576)} MiB`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(web as never), counter, createWriteStream(path, { mode: 0o640 }));
    if (size === 0) throw new ApiError(400, "bad_request", "request body must be a .tar.gz artifact");
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  return { path, sha256: hash.digest("hex") };
}

async function readManifestText(artifact: string): Promise<string> {
  for (const member of ["app.yaml", "./app.yaml"]) {
    try {
      return (await execFileP("tar", ["-xzOf", artifact, member], { maxBuffer: 512 * 1024 })).stdout;
    } catch {
      /* try the next spelling */
    }
  }
  throw new ApiError(400, "bad_request", "artifact must be a .tar.gz containing app.yaml at its root");
}

export function createApi(ctx: ApiContext): Api {
  const limiter = createFailureLimiter();
  const jobs = createJobs(ctx);
  const app = createApp();
  const router = createRouter();

  const audit = (p: Principal, action: string, appName?: string, detail?: Record<string, unknown>) =>
    ctx.registry.audit.add({ tokenId: p.id, action, app: appName ?? null, detail });

  /** Wrap a handler with authentication, role checking and error normalization. */
  const route = <T>(need: Role, fn: (event: H3Event, who: Principal) => Promise<T> | T) =>
    defineEventHandler(async (event) => {
      try {
        return await fn(event, authenticate(event, ctx, limiter, need));
      } catch (e) {
        const { status, body } = toHttpError(e);
        setResponseStatus(event, status);
        return body;
      }
    });
  const appParam = (event: H3Event) => appName.parse(getRouterParam(event, "app"));
  /** An app a user manages: the apps that serve storages are managed through the storage instead. */
  const userAppParam = (event: H3Event) => {
    const name = appParam(event);
    const storage = ctx.registry.apps.get(name)?.kind === "storage" ? storageOfApp(name) : null;
    if (storage) throw new ApiError(409, "managed_by_storage", `"${name}" serves the storage "${storage}"; manage it under Storage`);
    return name;
  };

  /** Server named in `?server=` (only meaningful for apps that are not pinned yet). */
  const requestedServer = (event: H3Event) => {
    const v = getQuery(event).server;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  /**
   * The server used when none is named: "local" if this control server runs apps itself, else the only enrolled server.
   * With several, the caller has to say which.
   */
  const defaultServer = (): string => {
    if (ctx.registry.servers.get("local")) return "local";
    const usable = reachableServers(ctx);
    if (usable.length === 1) return usable[0]!.name;
    throw new ApiError(400, "bad_request", usable.length ? "choose a server: this control server runs no apps of its own" : "there is no server to run apps yet: add one under Servers");
  };
  /** The agent for work that belongs to no server (validating or generating SSH keys): this machine's, else any online one. */
  const anyAgent = () => {
    const s = ctx.registry.servers.get("local") ?? reachableServers(ctx).find((x) => x.status === "online");
    if (!s) throw new ApiError(409, "no_server", "no server is online to do this; add and enroll a server first");
    return ctx.agents.forServer(s.name);
  };
  /** The server an app lives on: its pin if it has one, else the requested server, else the default. */
  const serverOf = (event: H3Event, name: string) => ctx.registry.apps.get(name)?.server ?? requestedServer(event) ?? defaultServer();
  const agentFor = (event: H3Event, name: string) => ctx.agents.forServer(serverOf(event, name));
  /** Every `environment:` value of an app.yaml's services, or nothing if it can't be read. */
  const environmentOf = (manifestText: string): string[] => {
    try {
      return environmentValues(parseManifest(manifestText, { legacy: true }));
    } catch {
      return [];
    }
  };
  const origin = (event: H3Event) => {
    const u = getRequestURL(event, { xForwardedHost: ctx.trustProxy, xForwardedProto: ctx.trustProxy });
    return `${u.protocol}//${u.host}`;
  };
  const enrollmentInfo = async (event: H3Event, name: string, token: string) => {
    const ca = await ctx.pki.ensureCa();
    const fp = fingerprint(ca.certPem);
    const server = ctx.registry.servers.get(name)!;
    return {
      server,
      enrollment: {
        token,
        expiresAt: server.enrollExpiresAt,
        caFingerprint: fp,
        command: `freighter-agent enroll --control ${origin(event)} --token ${token} --ca-fingerprint ${fp}`,
      },
    };
  };

  /** Like route(), for public endpoints that do their own checks. */
  const open = <T>(fn: (event: H3Event) => Promise<T> | T) =>
    defineEventHandler(async (event) => {
      try {
        return await fn(event);
      } catch (e) {
        const { status, body } = toHttpError(e);
        setResponseStatus(event, status);
        return body;
      }
    });

  router.get("/health", defineEventHandler(() => ({ ok: true })));

  // ---- browser session (token in an httpOnly cookie) ----
  router.post("/v1/session", open(async (event) => {
    assertCsrfHeader(event);
    const ip = clientIp(event, ctx);
    limiter.assertAllowed(ip);
    const { token } = await body(event, z.object({ token: z.string().max(200) }));
    const row = ctx.registry.tokens.verify(token);
    if (!row) {
      limiter.recordFailure(ip);
      throw new ApiError(401, "unauthorized", "invalid API token");
    }
    setCookie(event, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: getRequestProtocol(event, { xForwardedProto: ctx.trustProxy }) === "https",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    ctx.registry.audit.add({ tokenId: row.id, action: "session.login" });
    return { id: row.id, name: row.name, role: row.role };
  }));
  router.get("/v1/session", route("viewer", (_event, who) => who));
  router.delete("/v1/session", open((event) => {
    deleteCookie(event, SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }));

  // ---- read-only (viewer) ----
  router.get("/v1/apps", route("viewer", () => ({
    apps: ctx.registry.apps.list().map((a) => ({ ...a, manifestText: undefined, services: ctx.registry.services.list(a.name) })),
  })));

  router.get("/v1/projects", route("viewer", () => ({ projects: ctx.registry.projects.list() })));

  /** service -> image reference, as written in the app's current app.yaml ({} for an app without image services). */
  const imagesOf = (manifestText: string | null | undefined): Record<string, string> => {
    if (!manifestText) return {};
    try {
      return imageServices(parseManifest(manifestText, { legacy: true }));
    } catch {
      return {};
    }
  };

  /** For each service that runs an image, what app.yaml says about its container (the Source tab shows it). */
  const imageDetailsOf = (manifestText: string | null | undefined): Record<string, { image: string; containerPort?: number; volumes?: Record<string, string> }> => {
    if (!manifestText) return {};
    try {
      const m = parseManifest(manifestText, { legacy: true });
      return Object.fromEntries(
        Object.entries(m.services).flatMap(([name, s]) => (s.image ? [[name, { image: s.image, ...(s.containerPort ? { containerPort: s.containerPort } : {}), ...(s.volumes ? { volumes: s.volumes } : {}) }]] : [])),
      );
    } catch {
      return {};
    }
  };

  router.get("/v1/apps/:app", route("viewer", (event) => {
    const name = appParam(event);
    const a = ctx.registry.apps.get(name);
    if (!a) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    return { ...a, images: imagesOf(a.manifestText), imageDetails: imageDetailsOf(a.manifestText), registryLogins: ctx.registry.registryCredentials.appChoices(name), services: ctx.registry.services.list(name), deployments: ctx.registry.deployments.list({ app: name, limit: 5 }) };
  }));

  // Variables, per service: app.yaml's `environment:` gives the initial values, anything added here is laid over it. Connections are resolved.
  router.get("/v1/apps/:app/variables", route("viewer", async (event) => {
    const name = appParam(event);
    const row = ctx.registry.apps.get(name);
    if (!row) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    // a change that is still being applied counts: what was just added is listed at once
    const facts = await ownFacts(ctx, name, jobs.pendingConfig(name) ?? undefined);
    if (!facts) return { variables: [] };
    const { peers, storages } = await buildConnections(ctx, name, row.server);
    return {
      variables: Object.entries(facts.environment).flatMap(([service, env]) => {
        const resolved = resolveEnvironmentEach(facts, service, peers, storages);
        return Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => {
            const r = resolved[key]!;
            // a variable is the service's own, or it comes from the app's environment and applies to every service
            const source = key in (facts.own[service] ?? {}) || key in (facts.stored[service] ?? {}) ? "service" : "app";
            // credentials a connection resolves to are not shown
            return { service, key, value, source, resolved: "value" in r && !r.secret ? r.value : null, secret: "value" in r && r.secret, error: "error" in r ? r.error : null, reference: findReferences(value).length > 0 };
          });
      }),
    };
  }));

  const serviceParam = (event: H3Event) => z.string().regex(IDENT_RE).parse(getRouterParam(event, "service"));
  /**
   * A variable is part of its service's configuration, so changing one is a change of the configuration: checked here
   * (a reference to nothing is refused at once), then applied in the background like any other.
   */
  const variableChange = async (event: H3Event, who: Principal, change: { set?: Record<string, string>; remove?: string[] }) => {
    const name = userAppParam(event);
    const service = serviceParam(event);
    const server = serverOf(event, name);
    const key = Object.keys(change.set ?? {})[0] ?? change.remove?.[0];
    // The agent folds variables an older version kept apart into the configuration when it reads it.
    let current: string | null = ctx.registry.apps.get(name)?.manifestText ?? null;
    try {
      current = (await ctx.agents.forServer(server).call("app.config.get", { app: name })).manifestText ?? current;
    } catch {
      /* an agent from before configuration was kept separately */
    }
    current = jobs.pendingConfig(name) ?? current; // build on a change that is still being applied, not beside it
    if (!current) throw new ApiError(404, "not_found", `app "${name}" has no configuration yet`);
    const { name: _name, source: _source, ...settings } = parseManifest(current, { legacy: true, raw: true });
    const svc = settings.services[service];
    if (!svc) throw new ApiError(400, "bad_request", `${name} has no service "${service}"`);
    const env = { ...svc.environment };
    for (const [k, v] of Object.entries(change.set ?? {})) {
      if (k === "PORT") throw new ApiError(400, "bad_request", "PORT is set by Freighter");
      if (svc.secrets.includes(k)) throw new ApiError(400, "bad_request", `${k} is a secret; set it under Secrets`);
      if (/[\r\n\0]/.test(v)) throw new ApiError(400, "bad_request", "variable values cannot contain newlines");
      env[k] = v;
    }
    for (const k of change.remove ?? []) delete env[k];
    let text: string;
    try {
      text = renderManifest(name, { ...settings, services: { ...settings.services, [service]: { ...svc, environment: env } } } as never);
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message.split("\n")[0]! : String(e));
    }
    audit(who, change.set ? "variable.set" : "variable.remove", name, { service, key }); // plain values, but not worth logging
    return queueConfig(event, who, name, text);
  };
  router.put("/v1/apps/:app/services/:service/variables/:key", route("admin", async (event, who) => {
    const key = envKey.parse(getRouterParam(event, "key"));
    const { value } = await body(event, z.object({ value: z.string().max(65_536) }));
    return variableChange(event, who, { set: { [key]: value } });
  }));
  router.delete("/v1/apps/:app/services/:service/variables/:key", route("admin", (event, who) => variableChange(event, who, { remove: [envKey.parse(getRouterParam(event, "key"))] })));

  // The app's configuration: what app.yaml described when the app started, and the dashboard and CLI keep from then on.
  router.get("/v1/apps/:app/config", route("viewer", async (event) => {
    const name = appParam(event);
    const row = ctx.registry.apps.get(name);
    if (!row) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    let text: string | null = row.manifestText ?? null;
    try {
      text = (await ctx.agents.forServer(row.server).call("app.config.get", { app: name })).manifestText ?? text;
    } catch {
      // an agent from before configuration was kept separately: the manifest of the current release is it
    }
    // What a deployment still in progress is about to make of it: its services are shown as on their way.
    let pending = null;
    const queued = jobs.pendingConfig(name);
    if (queued) {
      try {
        const { name: _n, source: _s, ...p } = parseManifest(queued, { legacy: true, raw: true });
        pending = p;
      } catch {
        /* not parseable: nothing to show */
      }
    }
    if (!text) return { text: null, settings: null, pending };
    const { name: _name, source: _source, ...settings } = parseManifest(text, { legacy: true, raw: true });
    return { text, settings, pending };
  }));
  router.put("/v1/apps/:app/config", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const { settings } = await body(event, z.object({ settings: settingsSchema }));
    if (Object.keys(settings.services ?? {}).length === 0) throw new ApiError(422, "no_manifest", "define at least one service");
    checkSettings(name, settings);
    const text = renderManifest(name, settings as never);
    return queueConfig(event, who, name, text);
  }));
  /** Make `text` the app's configuration. The deploy runs in the background; the deployment follows it and holds its log. */
  const queueConfig = async (event: H3Event, who: Principal, name: string, text: string) => {
    const server = serverOf(event, name);
    const id = randomUUID();
    ctx.registry.deployments.create({ id, app: name, server, action: "deploy", requestedBy: who.id, trigger: "manual" });
    // New build commands only mean something when the code is built again, so an app that is built from Git is built
    // again with them (a new release from the branch head). Anything else changes the configuration of the release
    // that is running.
    const link = ctx.registry.gitLinks.get(name);
    let rebuild = false;
    if (link) {
      let before: string | null = ctx.registry.apps.get(name)?.manifestText ?? null;
      try {
        before = (await ctx.agents.forServer(server).call("app.config.get", { app: name })).manifestText ?? before;
      } catch {
        /* an agent from before configuration was kept separately */
      }
      const buildOf = (t: string | null) => JSON.stringify((t ? parseManifest(t, { legacy: true }).build : undefined) ?? null);
      rebuild = buildOf(before) !== buildOf(text);
    }
    audit(who, "config.set", name, { server, deployment: id, rebuild });
    if (link && rebuild) {
      jobs.enqueueGit({ id, app: name, server, repository: link.repository, branch: link.branch, subpath: link.subpath, skipIfUnchanged: false, trigger: "manual", sshKeyId: link.sshKeyId, configText: text });
    } else {
      jobs.enqueueConfig({ id, app: name, server, manifestText: text });
    }
    setResponseStatus(event, 202);
    return { ok: true, id, status: "queued", rebuild };
  };

  // Remote volumes of the app (declared in its configuration): what is mounted, and whether an SMB password is set.
  router.get("/v1/apps/:app/volumes", route("viewer", async (event) => {
    const name = appParam(event);
    const row = ctx.registry.apps.get(name);
    if (!row) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    return ctx.agents.forServer(row.server).call("volumes.status", { app: name }).catch(() => ({ volumes: {} }));
  }));
  router.put("/v1/apps/:app/volumes/:name/password", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const volume = z.string().regex(IDENT_RE).parse(getRouterParam(event, "name"));
    const { password } = await body(event, z.object({ password: z.string().min(1).max(256).refine((p) => !/[\r\n\0]/.test(p), "no newlines") }));
    await agentFor(event, name).call("volumes.password.set", { app: name, name: volume, password });
    audit(who, "volume.password", name, { volume }); // never the value
    return { ok: true };
  }));

  // Remove an app for good: from its server (units, routing, certificates, releases, shared data, secrets), then from here.
  // Typing the name is required of API clients too, so a stray DELETE can't do it.
  router.delete("/v1/apps/:app", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const { confirm, forget } = await body(event, z.object({ confirm: z.string(), forget: z.boolean().optional() }));
    const row = ctx.registry.apps.get(name);
    if (!row) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    if (confirm !== name) throw new ApiError(400, "bad_request", `to delete ${name}, send its name as "confirm"`);
    if (ctx.registry.deployments.list({ app: name, limit: 20 }).some((x) => x.status === "queued" || x.status === "running")) {
      throw new ApiError(409, "conflict", `${name} has a deployment in progress; wait for it to finish`);
    }
    let removed: { units: string[]; hostnames: string[] } | null = null;
    // An app its server no longer reports (`missing`), or one the caller asks to just forget, has nothing left to remove there.
    if (row.status !== "missing" && !forget) {
      try {
        removed = await ctx.agents.forServer(row.server).call("app.delete", { app: name }, { timeoutMs: 5 * 60_000 });
      } catch (e) {
        if (!(e instanceof AgentError && e.code === "not_found")) throw e; // already gone from the server: carry on and tidy up here
      }
    }
    ctx.registry.apps.remove(name);
    audit(who, "app.delete", name, { server: row.server, units: removed?.units.length ?? 0, hostnames: removed?.hostnames ?? [], forgotten: !removed });
    return { ok: true, app: name, server: row.server, units: removed?.units ?? [], hostnames: removed?.hostnames ?? [], forgotten: !removed };
  }));

  router.get("/v1/apps/:app/releases", route("viewer", async (event) => {
    const { releases } = await agentFor(event, appParam(event)).call("app.info", { app: appParam(event) });
    return { releases };
  }));

  router.get("/v1/apps/:app/deployments", route("viewer", (event) => ({
    deployments: ctx.registry.deployments.list({ app: appParam(event), limit: limitParam(event, 50) }),
  })));

  router.get("/v1/deployments", route("viewer", (event) => ({ deployments: ctx.registry.deployments.list({ limit: limitParam(event, 20) }) })));

  router.get("/v1/apps/:app/metrics", route("viewer", (event) => {
    const name = appParam(event);
    const maxMinutes = (ctx.metricsRetentionHours ?? 6) * 60;
    const q = z.object({ minutes: z.coerce.number().int().min(1).max(maxMinutes).default(60) }).parse(getQuery(event));
    const since = new Date((ctx.now ?? (() => new Date()))().getTime() - q.minutes * 60_000).toISOString();
    return { minutes: q.minutes, series: buildSeries(ctx.registry.metrics.series(name, since)) };
  }));

  router.get("/v1/deployments/:id", route("viewer", (event) => {
    const d = ctx.registry.deployments.get(getRouterParam(event, "id") ?? "");
    if (!d) throw new ApiError(404, "not_found", "unknown deployment");
    return d;
  }));

  router.post("/v1/deployments/:id/cancel", route("deployer", async (event, who) => {
    const d = ctx.registry.deployments.get(getRouterParam(event, "id") ?? "");
    if (!d) throw new ApiError(404, "not_found", "unknown deployment");
    let outcome;
    try {
      outcome = await jobs.cancel(d.id, who.name);
    } catch (e) {
      if (e instanceof AgentError && /unknown operation/.test(e.message)) throw new ApiError(409, "conflict", "this server's agent predates canceling. Upgrade it first");
      throw e;
    }
    if (outcome === "finished") throw new ApiError(409, "conflict", "this deployment is already over");
    audit(who, "deploy.cancel", d.app, { deployment: d.id, outcome });
    setResponseStatus(event, 202);
    return { id: d.id, status: outcome };
  }));

  // ---- domains: configured on the app (not in app.yaml). A new domain waits for its DNS records, then goes live ----
  /** Read on every use: the DNS servers are a setting that can change while the API runs. */
  const dnsResolver = (): DnsResolver => ctx.dns ?? systemDns;
  const lookup = async (host: string) => {
    try {
      return await resolveAll(dnsResolver(), host);
    } catch (e) {
      throw new ApiError(502, "dns_unavailable", `Could not look up ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** The address(es) a domain's DNS record must point to: the app's server. */
  const targetAddresses = async (event: H3Event, server: string): Promise<string[]> => {
    const row = ctx.registry.servers.get(server);
    if (row?.kind === "remote" && row.address) return lookup(parseAddress(row.address).host);
    if (ctx.publicIps?.length) return ctx.publicIps;
    const host = getRequestURL(event, { xForwardedHost: ctx.trustProxy }).hostname.replace(/^\[|\]$/g, "");
    if (isLocalName(host)) return [];
    return (await lookup(host)).filter((ip) => !isPrivateOrLoopback(ip));
  };
  const hostParam = (event: H3Event) => (getRouterParam(event, "hostname") ?? "").toLowerCase();
  const domainBody = z.object({ hostname: z.string().transform((x) => x.trim().toLowerCase()), service: z.string(), tls: z.enum(["auto", "off"]).default("auto") });
  const activeDomains = async (name: string, server: string) => (await ctx.agents.forServer(server).call("domains.get", { app: name })).domains;
  const pendingView = (p: PendingDomainRow) => ({ hostname: p.hostname, service: p.service, tls: p.tls, status: "pending" as const, checkedAt: p.checkedAt, lastError: p.lastError });
  const dnsTargets = async (event: H3Event, server: string) => {
    const addresses = await targetAddresses(event, server);
    return { addresses, records: addresses.map((value) => ({ type: value.includes(":") ? "AAAA" : "A", value })) };
  };

  router.get("/v1/apps/:app/domains", route("viewer", async (event) => {
    const name = appParam(event);
    const server = serverOf(event, name);
    const active = await activeDomains(name, server);
    return {
      domains: [...active.map((d) => ({ ...d, status: "active" as const, checkedAt: null, lastError: null })), ...ctx.registry.pendingDomains.list(name).map(pendingView)],
      dns: await dnsTargets(event, server),
    };
  }));

  router.post("/v1/apps/:app/domains", route("admin", async (event, who) => {
    const name = appParam(event);
    const d = domainSchema.parse(await body(event, domainBody));
    const server = serverOf(event, name);
    const target = ctx.registry.servers.get(server);
    if (!target) throw new ApiError(404, "not_found", `unknown server "${server}"`);
    if (target.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${server}" has not been enrolled yet`);
    const waiting = ctx.registry.pendingDomains.get(d.hostname);
    const live = ctx.registry.apps.list().find((a) => a.name !== name && ctx.registry.services.list(a.name).some((s) => s.hostnames.includes(d.hostname)));
    if (waiting || live) throw new ApiError(409, "conflict", `${d.hostname} is already used by app "${waiting?.app ?? live!.name}"`);
    if ((await activeDomains(name, server)).some((x) => x.hostname === d.hostname)) throw new ApiError(409, "conflict", `${d.hostname} is already one of this app's domains`);
    const known = ctx.registry.services.list(name);
    if (known.length > 0 && !known.some((s) => s.name === d.service)) throw new ApiError(400, "bad_request", `${name} has no service "${d.service}"`);
    ctx.registry.apps.ensure(name, server); // pins the app to its server
    const row = ctx.registry.pendingDomains.create({ hostname: d.hostname, app: name, service: d.service, tls: d.tls });
    audit(who, "domain.add", name, { hostname: d.hostname });
    setResponseStatus(event, 201);
    return { domain: pendingView(row), dns: await dnsTargets(event, server) };
  }));

  // Check DNS; when it points at this server, put the domain live (a recorded, health-gated deployment).
  router.post("/v1/apps/:app/domains/:hostname/verify", route("admin", async (event, who) => {
    const name = appParam(event);
    const p = ctx.registry.pendingDomains.get(hostParam(event));
    if (!p || p.app !== name) throw new ApiError(404, "not_found", "no such domain waiting for verification");
    const server = serverOf(event, name);
    const agent = ctx.agents.forServer(server);
    const doFetch = ctx.fetch ?? fetch;
    const challenge: ChallengeProbe = {
      token: async () => (await agent.call("challenge.get", {})).token,
      fetch: async (url) => {
        const res = await doFetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
        return { status: res.status, text: (await res.text()).slice(0, 200) };
      },
    };
    const check = await checkDomainDns(dnsResolver(), p.hostname, await targetAddresses(event, server), challenge);
    if (!check.ok) {
      ctx.registry.pendingDomains.markChecked(p.hostname, check.reason);
      return { verified: false, ...check };
    }
    const next = [...(await activeDomains(name, server)).filter((x) => x.hostname !== p.hostname), { hostname: p.hostname, service: p.service, tls: p.tls }];
    const row = ctx.registry.deployments.create({ id: randomUUID(), app: name, server, action: "deploy", trigger: "manual", requestedBy: who.id });
    audit(who, "domain.verify", name, { deployment: row.id, hostname: p.hostname });
    jobs.enqueueDomains({
      id: row.id, app: name, server, domains: next,
      done: (err) => (err ? ctx.registry.pendingDomains.markChecked(p.hostname, `DNS is right, but going live failed: ${err}`) : ctx.registry.pendingDomains.remove(p.hostname)),
    });
    setResponseStatus(event, 202);
    return { verified: true, id: row.id, ...check };
  }));

  router.delete("/v1/apps/:app/domains/:hostname", route("admin", async (event, who) => {
    const name = appParam(event);
    const hostname = hostParam(event);
    const p = ctx.registry.pendingDomains.get(hostname);
    if (p && p.app === name) {
      ctx.registry.pendingDomains.remove(hostname);
      audit(who, "domain.remove", name, { hostname });
      return { ok: true };
    }
    const server = serverOf(event, name);
    const active = await activeDomains(name, server);
    if (!active.some((x) => x.hostname === hostname)) throw new ApiError(404, "not_found", "no such domain");
    const row = ctx.registry.deployments.create({ id: randomUUID(), app: name, server, action: "deploy", trigger: "manual", requestedBy: who.id });
    audit(who, "domain.remove", name, { deployment: row.id, hostname });
    jobs.enqueueDomains({ id: row.id, app: name, server, domains: active.filter((x) => x.hostname !== hostname) });
    setResponseStatus(event, 202);
    return { id: row.id, status: "queued" };
  }));

  router.get("/v1/apps/:app/services/:service/env", route("viewer", async (event) => {
    const name = appParam(event);
    const service = serviceParam(event);
    const { names } = await agentFor(event, name).call("env.list", { app: name, service });
    const text = ctx.registry.apps.get(name)?.manifestText;
    let declared: string[] = [];
    try {
      declared = text ? (parseManifest(text, { legacy: true }).services[service]?.secrets ?? []) : [];
    } catch {
      // an unreadable manifest declares nothing
    }
    return { names, declared };
  }));
  router.get("/v1/certs", route("viewer", async (event) => {
    const only = requestedServer(event);
    const certs: { server: string; hostname: string; expires: string | null }[] = [];
    for (const s of reachableServers(ctx).filter((x) => !only || x.name === only)) {
      try {
        const r = await ctx.agents.forServer(s.name).call("certs.status", {}, { timeoutMs: 8_000 });
        certs.push(...r.certs.map((c) => ({ server: s.name, ...c })));
      } catch {
        /* unreachable servers are shown as offline on the Servers page */
      }
    }
    return { certs };
  }));

  // ---- deploy / operate (deployer) ----
  router.post("/v1/apps/:app/deployments", route("deployer", async (event, who) => {
    const name = userAppParam(event);
    const server = serverOf(event, name);
    const wanted = requestedServer(event);
    if (wanted && wanted !== server) throw new ApiError(409, "pinned_to_other_server", `app "${name}" is pinned to server "${server}"`);
    const target = ctx.registry.servers.get(server);
    if (!target) throw new ApiError(404, "not_found", `unknown server "${server}"`);
    if (target.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${server}" has not been enrolled yet`);
    const id = randomUUID();
    const { path, sha256 } = await receiveArtifact(event, ctx, id);
    try {
      const manifestText = await readManifestText(path);
      let manifest;
      try {
        manifest = parseManifest(manifestText); // ZodError -> 400 with details
      } catch (e) {
        if (e instanceof z.ZodError) throw e;
        throw new ApiError(400, "bad_request", `app.yaml is invalid: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
      if (manifest.name !== name) throw new ApiError(400, "bad_request", `app.yaml is for "${manifest.name}" but the URL is for "${name}"`);
      ctx.registry.apps.ensure(name, server); // pins the app to its server
      ctx.registry.deployments.create({ id, app: name, server, action: "deploy", requestedBy: who.id, artifactSha256: sha256 });
      audit(who, "deploy.queued", name, { deployment: id, sha256, server });
      jobs.enqueueDeploy({ id, app: name, server, artifactPath: path, manifestText });
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    setResponseStatus(event, 202);
    return { id, status: "queued" };
  }));

  // An app whose services are all images has nothing to upload: the server pulls them. `manifest` is the text of app.yaml.
  const queueImageDeploy = (event: H3Event, who: Principal, name: string, manifestText: string, trigger: "manual" | "upload", logins: Record<string, string> = {}, replaceConfig = false) => {
    let manifest;
    try {
      manifest = parseManifest(manifestText);
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new ApiError(400, "bad_request", `app.yaml is invalid: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    if (manifest.name !== name) throw new ApiError(400, "bad_request", `app.yaml is for "${manifest.name}" but the URL is for "${name}"`);
    if (Object.keys(imageServices(manifest)).length !== Object.keys(manifest.services).length) {
      throw new ApiError(400, "bad_request", "every service must set `image` for a deploy without an upload; upload an artifact to deploy services that run a command");
    }
    const server = serverOf(event, name);
    const wanted = requestedServer(event);
    if (wanted && wanted !== server) throw new ApiError(409, "pinned_to_other_server", `app "${name}" is pinned to server "${server}"`);
    const target = ctx.registry.servers.get(server);
    if (!target) throw new ApiError(404, "not_found", `unknown server "${server}"`);
    if (target.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${server}" has not been enrolled yet`);
    // Logins chosen in the form stick to the app, so a redeploy pulls with the same ones. Several logins for a registry
    // and no choice would be a guess, so that is refused here rather than failing after the deployment was queued.
    for (const [host, username] of Object.entries(logins)) {
      if (!ctx.registry.registryCredentials.setAppChoice(name, host, username)) throw new ApiError(400, "bad_request", `no login "${username}" for "${host}"`);
    }
    for (const host of new Set(Object.values(imageServices(manifest)).map(imageHost))) {
      const c = ctx.registry.registryCredentials.resolve(name, host);
      if (c && "ambiguous" in c) throw new ApiError(409, "login_required", `${host} has several logins (${c.ambiguous.join(", ")}); choose which ${name} pulls with`);
    }
    const id = randomUUID();
    ctx.registry.apps.ensure(name, server);
    ctx.registry.deployments.create({ id, app: name, server, action: "deploy", requestedBy: who.id, trigger });
    audit(who, "deploy.queued", name, { deployment: id, server, images: Object.values(imageServices(manifest)) });
    jobs.enqueueImageDeploy({ id, app: name, server, manifestText, replaceConfig });
    setResponseStatus(event, 202);
    return { id, status: "queued" };
  };

  router.post("/v1/apps/:app/image-deployments", route("deployer", async (event, who) => {
    const { manifest, logins, replaceConfig } = await body(event, z.object({ manifest: z.string().min(1).max(262_144), logins: z.record(z.string(), z.string().min(1)).optional(), replaceConfig: z.boolean().optional() }));
    return queueImageDeploy(event, who, userAppParam(event), manifest, "manual", logins, replaceConfig);
  }));

  // Pull the app's images again (a moved tag, a fixed image) and release the result, keeping the app's current app.yaml.
  router.post("/v1/apps/:app/redeploy", route("deployer", (event, who) => {
    const name = userAppParam(event);
    const text = ctx.registry.apps.get(name)?.manifestText;
    if (!text) throw new ApiError(404, "not_found", `app "${name}" has not been deployed`);
    // A release written with a shared environment is released again in the per-service form.
    let current = text;
    try {
      parseManifest(text);
    } catch {
      const { name: _name, source: _source, ...rest } = parseManifest(text, { legacy: true, raw: true });
      current = renderManifest(name, rest);
    }
    return queueImageDeploy(event, who, name, current, "manual");
  }));

  // Change the image (usually the tag) of some services and release it. Everything else in app.yaml stays as it was.
  router.post("/v1/apps/:app/images", route("deployer", async (event, who) => {
    const name = userAppParam(event);
    const { images } = await body(event, z.object({ images: z.record(z.string(), z.string().min(1)).refine((i) => Object.keys(i).length > 0, "name at least one service") }));
    const text = ctx.registry.apps.get(name)?.manifestText;
    if (!text) throw new ApiError(404, "not_found", `app "${name}" has not been deployed`);
    const current = parseManifest(text, { legacy: true, raw: true });
    for (const service of Object.keys(images)) {
      if (!current.services[service]?.image) throw new ApiError(400, "bad_request", `service "${service}" does not run an image`);
    }
    const { name: _name, source: _source, ...rest } = current;
    const next = { ...rest, services: Object.fromEntries(Object.entries(current.services).map(([k, v]) => [k, images[k] ? { ...v, image: images[k] } : v])) };
    let manifestText: string;
    try {
      manifestText = renderManifest(name, next);
    } catch (e) {
      if (e instanceof z.ZodError) throw e;
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message.split("\n")[0]! : String(e));
    }
    return queueImageDeploy(event, who, name, manifestText, "manual", {}, true);
  }));

  router.post("/v1/apps/:app/rollback", route("deployer", async (event, who) => {
    const name = userAppParam(event);
    const { release } = await body(event, z.object({ release: optionalIdent }));
    const server = serverOf(event, name);
    const row = ctx.registry.deployments.create({ id: randomUUID(), app: name, server, action: "rollback", requestedBy: who.id });
    audit(who, "rollback.queued", name, { deployment: row.id, release: release ?? null, server });
    jobs.enqueueRollback({ id: row.id, app: name, server, release });
    setResponseStatus(event, 202);
    return { id: row.id, status: "queued" };
  }));

  for (const verb of ["start", "stop", "restart"] as const) {
    router.post(`/v1/apps/:app/${verb}`, route("deployer", async (event, who) => {
      const name = appParam(event);
      const { service } = await body(event, z.object({ service: optionalIdent }));
      const r = await agentFor(event, name).call("app.control", { app: name, verb, service });
      audit(who, `service.${verb}`, name, { service: service ?? null });
      return r;
    }));
  }

  router.get("/v1/apps/:app/logs", route("deployer", async (event) => {
    const q = z.object({ service: z.string().regex(IDENT_RE), lines: z.coerce.number().int().min(1).max(1000).default(100) }).parse(getQuery(event));
    return agentFor(event, appParam(event)).call("app.logs", { app: appParam(event), ...q });
  }));

  // ---- administration (admin) ----
  router.put("/v1/apps/:app/services/:service/env/:key", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const service = serviceParam(event);
    const key = envKey.parse(getRouterParam(event, "key"));
    const { value } = await body(event, z.object({ value: z.string() }));
    await agentFor(event, name).call("env.set", { app: name, service, key, value });
    audit(who, "env.set", name, { service, key }); // never the value
    return { ok: true };
  }));

  router.get("/v1/tokens", route("admin", () => ({ tokens: ctx.registry.tokens.list() })));
  router.post("/v1/tokens", route("admin", async (event, who) => {
    const { name, role } = await body(event, z.object({ name: z.string().min(1).max(64), role: z.string().refine(isRole, "invalid role") }));
    const { token, row } = ctx.registry.tokens.create({ name, role: role as Role });
    audit(who, "token.create", undefined, { id: row.id, role });
    setResponseStatus(event, 201);
    return { token, ...row }; // the plaintext token is shown exactly once
  }));
  router.delete("/v1/tokens/:id", route("admin", (event, who) => {
    const id = getRouterParam(event, "id") ?? "";
    if (!ctx.registry.tokens.revoke(id)) throw new ApiError(404, "not_found", "unknown or already revoked token");
    audit(who, "token.revoke", undefined, { id });
    return { ok: true };
  }));

  router.get("/v1/audit", route("admin", (event) => ({ entries: ctx.registry.audit.list(limitParam(event, 100)) })));
  router.post("/v1/certs/renew", route("admin", async (event, who) => {
    const { force } = await body(event, z.object({ force: z.boolean().optional() }));
    const only = requestedServer(event);
    audit(who, "certs.renew", undefined, { force: force ?? false, server: only ?? "all" });
    const certs: { server: string; hostname: string; issued: boolean; expires: string | null }[] = [];
    for (const s of reachableServers(ctx).filter((x) => !only || x.name === only)) {
      const r = await ctx.agents.forServer(s.name).call("certs.renew", { force });
      certs.push(...r.certs.map((c) => ({ server: s.name, ...c })));
    }
    return { certs };
  }));

  // ---- SSH keys: private keys imported for cloning private repositories ----
  const needSshKey = (id: string) => {
    const k = ctx.registry.sshKeys.get(id);
    if (!k) throw new ApiError(404, "not_found", `unknown SSH key "${id}"`);
    return k;
  };
  /** The decrypted key to hand to the agent that is about to clone. */
  const authFor = (sshKeyId: string | null | undefined) => {
    if (!sshKeyId) return undefined;
    const sshKey = ctx.registry.sshKeys.privateKey(sshKeyId);
    if (!sshKey) throw new ApiError(404, "not_found", `unknown SSH key "${sshKeyId}"`);
    return { sshKey };
  };
  const publicSshKey = (k: ReturnType<typeof needSshKey>) => ({
    id: k.id, name: k.name, keyType: k.keyType, publicKey: k.publicKey, fingerprint: k.fingerprint, comment: k.comment,
    createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, appCount: k.appCount,
  });

  router.get("/v1/ssh-keys", route("admin", () => ({ keys: ctx.registry.sshKeys.list().map(publicSshKey) })));

  router.post("/v1/ssh-keys", route("admin", async (event, who) => {
    const b = await body(event, z.object({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/, "name: letters, digits, spaces and . _ @ -"),
      privateKey: z.string().min(1).max(20000),
      passphrase: z.string().max(1000).optional(),
    }));
    if (ctx.registry.sshKeys.list().some((k) => k.name === b.name)) throw new ApiError(409, "conflict", `a key named "${b.name}" already exists`);
    const k = await anyAgent().call("ssh.import", { privateKey: b.privateKey, passphrase: b.passphrase });
    const dup = ctx.registry.sshKeys.list().find((x) => x.fingerprint === k.fingerprint);
    if (dup) throw new ApiError(409, "conflict", `this key is already imported as "${dup.name}"`);
    const created = ctx.registry.sshKeys.create({ name: b.name, keyType: k.keyType, publicKey: k.publicKey, fingerprint: k.fingerprint, comment: k.comment || null, privateKey: k.privateKey, createdBy: who.id });
    audit(who, "ssh-key.import", undefined, { name: created.name, fingerprint: created.fingerprint });
    setResponseStatus(event, 201);
    return publicSshKey(created);
  }));

  // Create a key pair on the server: the private half is stored encrypted, the public half is for the git host.
  router.post("/v1/ssh-keys/generate", route("admin", async (event, who) => {
    const b = await body(event, z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/, "name: letters, digits, spaces and . _ @ -") }));
    if (ctx.registry.sshKeys.list().some((k) => k.name === b.name)) throw new ApiError(409, "conflict", `a key named "${b.name}" already exists`);
    const k = await anyAgent().call("ssh.generate", { comment: `freighter:${b.name}` });
    const created = ctx.registry.sshKeys.create({ name: b.name, keyType: k.keyType, publicKey: k.publicKey, fingerprint: k.fingerprint, comment: k.comment || null, privateKey: k.privateKey, createdBy: who.id });
    audit(who, "ssh-key.generate", undefined, { name: created.name, fingerprint: created.fingerprint });
    setResponseStatus(event, 201);
    return publicSshKey(created);
  }));

  router.delete("/v1/ssh-keys/:id", route("admin", (event, who) => {
    const k = needSshKey(getRouterParam(event, "id") ?? "");
    if (k.appCount > 0) throw new ApiError(409, "conflict", `key "${k.name}" is used by ${k.appCount} app${k.appCount === 1 ? "" : "s"}; switch them to another key first`);
    ctx.registry.sshKeys.remove(k.id);
    audit(who, "ssh-key.remove", undefined, { name: k.name, fingerprint: k.fingerprint });
    return { ok: true };
  }));

  // ---- projects: a place to organize apps in ----
  const projectBody = z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default("") });
  const projectParam = (event: H3Event) => {
    const p = ctx.registry.projects.get(getRouterParam(event, "id") ?? "");
    if (!p) throw new ApiError(404, "not_found", "unknown project");
    return p;
  };
  const taken = (name: string, except?: string) => ctx.registry.projects.list().some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase());

  router.post("/v1/projects", route("admin", async (event, who) => {
    const b = await body(event, projectBody);
    if (taken(b.name)) throw new ApiError(409, "conflict", `there is already a project named "${b.name}"`);
    const row = ctx.registry.projects.create({ ...b, createdBy: who.id });
    audit(who, "project.create", undefined, { project: row.name });
    return row;
  }));

  router.patch("/v1/projects/:id", route("admin", async (event, who) => {
    const cur = projectParam(event);
    const b = await body(event, projectBody.partial());
    if (b.name !== undefined && taken(b.name, cur.id)) throw new ApiError(409, "conflict", `there is already a project named "${b.name}"`);
    ctx.registry.projects.update(cur.id, b);
    audit(who, "project.update", undefined, { project: b.name ?? cur.name, was: cur.name });
    return ctx.registry.projects.get(cur.id);
  }));

  // Apps in the project are kept and become ungrouped.
  router.delete("/v1/projects/:id", route("admin", (event, who) => {
    const cur = projectParam(event);
    ctx.registry.projects.remove(cur.id);
    audit(who, "project.delete", undefined, { project: cur.name, ungrouped: cur.appCount });
    return { ok: true };
  }));

  // The canvas: a project's services, the connections between them and where they sit. "none" is the apps without a project.
  const graphScope = (event: H3Event) => {
    const id = getRouterParam(event, "id") ?? "";
    return id === "none" ? null : projectParam(event).id;
  };
  router.get("/v1/projects/:id/graph", route("viewer", (event) => buildGraph(ctx, graphScope(event))));
  const position = z.object({ x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) });
  router.put("/v1/projects/:id/layout", route("deployer", async (event, who) => {
    const scope = graphScope(event);
    const { positions } = await body(event, z.object({ positions: z.record(z.string().max(200), position).refine((p) => Object.keys(p).length <= 2000, "too many nodes") }));
    ctx.registry.layouts.set(scope ?? "none", positions);
    audit(who, "project.layout", undefined, { project: scope ? ctx.registry.projects.get(scope)?.name : null, nodes: Object.keys(positions).length });
    return { ok: true };
  }));

  // Move an app into a project (null: out of any project).
  router.put("/v1/apps/:app/project", route("deployer", async (event, who) => {
    const name = userAppParam(event);
    const { projectId } = await body(event, z.object({ projectId: z.string().nullable() }));
    if (!ctx.registry.apps.get(name)) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    if (!ctx.registry.apps.setProject(name, projectId)) throw new ApiError(404, "not_found", "unknown project");
    audit(who, "app.project", name, { project: projectId ? ctx.registry.projects.get(projectId)?.name : null });
    return { projectId };
  }));

  // ---- S3 storage: an endpoint served from this server's disk or from a remote system, optionally on a domain ----
  const storageView = (row: StorageRow) => {
    const app = storageApp(row.name);
    const a = ctx.registry.apps.get(app);
    const services = ctx.registry.services.list(app);
    const svc = services.find((s) => s.name === "s3");
    const open = services.find((s) => s.name === "public");
    return {
      ...row,
      app,
      status: a?.status ?? "unknown",
      activeState: svc?.activeState ?? "inactive",
      hostnames: svc?.hostnames ?? [],
      /** The read-only endpoint of a public storage, and where it can be reached. */
      publicHostnames: row.public ? (open?.hostnames ?? []) : [],
      publicState: row.public ? (open?.activeState ?? "inactive") : null,
      deployments: ctx.registry.deployments.list({ app, limit: 5 }),
    };
  };
  const needStorage = (event: H3Event) => {
    const name = storageNameSchema.safeParse(getRouterParam(event, "name"));
    const row = name.success ? ctx.registry.storages.get(name.data) : undefined;
    if (!row) throw new ApiError(404, "not_found", "unknown storage");
    return row;
  };
  const storageBody = {
    backend: storageBackendSchema,
    secrets: storageSecretsSchema.optional(),
  };
  /** Refuse early what the agent would refuse after the deployment was queued. */
  const checkBackend = (backend: StorageBackend, secrets: StorageSecrets | undefined) => {
    if (backend.kind === "sftp") {
      if (!backend.hostKey) throw new ApiError(400, "bad_request", "pin the server's SSH host key first: test the connection and confirm its fingerprint");
      if (backend.auth === "key" && !secrets?.privateKey) throw new ApiError(400, "bad_request", "a private key is required for key authentication");
    }
    if ((backend.kind === "smb" || (backend.kind === "sftp" && backend.auth === "password")) && !secrets?.password) throw new ApiError(400, "bad_request", "a password is required");
  };
  const readyServer = async (server: string) => {
    const target = ctx.registry.servers.get(server);
    if (!target) throw new ApiError(404, "not_found", `unknown server "${server}"`);
    if (target.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${server}" has not been enrolled yet`);
    const caps = (await ctx.agents.forServer(server).call("ping", {}).catch((e: unknown) => {
      throw new ApiError(502, "agent_unreachable", `server "${server}" did not answer: ${e instanceof Error ? e.message : String(e)}`);
    })).capabilities ?? [];
    if (!caps.includes("storage")) throw new ApiError(409, "storage_unavailable", `server "${server}" cannot serve storages: install rclone ${"1.65"} or newer (re-run the installer with FREIGHTER_WITH_STORAGE=1) and upgrade its agent`);
  };
  const queueStorage = (event: H3Event, who: Principal, name: string, server: string, what: string) => {
    const id = randomUUID();
    ctx.registry.deployments.create({ id, app: storageApp(name), server, action: "deploy", requestedBy: who.id, trigger: "manual" });
    audit(who, `storage.${what}`, storageApp(name), { storage: name, deployment: id, server });
    jobs.enqueueStorage({ id, name, server });
    setResponseStatus(event, 202);
    return id;
  };
  const newKeyPair = () => ({ accessKey: `FR${randomBytes(10).toString("hex").toUpperCase()}`, secretKey: randomBytes(30).toString("base64url") });

  router.get("/v1/storages", route("viewer", () => ({ storages: ctx.registry.storages.list().map(storageView) })));
  router.get("/v1/storages/:name", route("viewer", (event) => storageView(needStorage(event))));

  // Try a backend before creating anything. An SFTP server's host key comes back to be confirmed (and sent with the real request).
  router.post("/v1/storages/test", route("admin", async (event) => {
    const b = await body(event, z.object({ server: z.string().optional(), ...storageBody }));
    const server = b.server ?? defaultServer();
    await readyServer(server);
    return ctx.agents.forServer(server).call("storage.test", { backend: b.backend, secrets: b.secrets }, { timeoutMs: 60_000 });
  }));

  router.post("/v1/storages", route("admin", async (event, who) => {
    const b = await body(event, z.object({ name: storageNameSchema, server: z.string().optional(), ...storageBody }));
    if (ctx.registry.storages.get(b.name) || ctx.registry.apps.get(storageApp(b.name))) throw new ApiError(409, "conflict", `there is already a storage or an app named "${storageApp(b.name)}"`);
    checkBackend(b.backend, b.secrets);
    const server = b.server ?? defaultServer();
    await readyServer(server);
    const keys = newKeyPair();
    ctx.registry.apps.ensure(storageApp(b.name), server, "storage");
    const row = ctx.registry.storages.create({ name: b.name, server, backend: b.backend, port: 0, ...keys, remoteSecrets: b.secrets, createdBy: who.id });
    const id = queueStorage(event, who, b.name, server, "create");
    // The key pair is shown once, here; later it is only reachable by an app that connects to the storage.
    return { id, status: "queued", storage: storageView(row), ...keys };
  }));

  // Change the backend or its credentials (what is left out stays), then redeploy the endpoint.
  router.patch("/v1/storages/:name", route("admin", async (event, who) => {
    const cur = needStorage(event);
    const b = await body(event, z.object({ backend: storageBackendSchema.optional(), secrets: storageSecretsSchema.optional(), public: z.boolean().optional() }));
    const backend = b.backend ?? cur.backend;
    // Credentials carry over while the kind of backend stays; a different kind starts from what is sent.
    const sameKind = !b.backend || b.backend.kind === cur.backend.kind;
    const merged = sameKind ? { ...ctx.registry.storages.secrets(cur.name)!.remote, ...b.secrets } : { ...b.secrets };
    checkBackend(backend, merged);
    await readyServer(cur.server);
    ctx.registry.storages.update(cur.name, { backend, remoteSecrets: merged, public: b.public });
    return { id: queueStorage(event, who, cur.name, cur.server, b.public === undefined ? "update" : b.public ? "make-public" : "make-private"), status: "queued" };
  }));

  // Deploy the endpoint again with what is stored (after a failed create, or to pick up a newer rclone).
  router.post("/v1/storages/:name/apply", route("admin", async (event, who) => {
    const cur = needStorage(event);
    await readyServer(cur.server);
    return { id: queueStorage(event, who, cur.name, cur.server, "apply"), status: "queued" };
  }));

  // A new secret key (the access key stays). Shown once.
  router.post("/v1/storages/:name/rotate-keys", route("admin", async (event, who) => {
    const cur = needStorage(event);
    await readyServer(cur.server);
    const { secretKey } = newKeyPair();
    ctx.registry.storages.update(cur.name, { secretKey });
    return { id: queueStorage(event, who, cur.name, cur.server, "rotate-keys"), status: "queued", accessKey: cur.accessKey, secretKey };
  }));

  router.delete("/v1/storages/:name", route("admin", async (event, who) => {
    const cur = needStorage(event);
    const { confirm, forget } = await body(event, z.object({ confirm: z.string(), forget: z.boolean().optional() }));
    if (confirm !== cur.name) throw new ApiError(400, "bad_request", `to delete ${cur.name}, send its name as "confirm"`);
    const users = ctx.registry.apps.list().filter((a) => a.manifestText && referencedStorages(environmentOf(a.manifestText)).includes(cur.name)).map((a) => a.name);
    if (users.length && !forget) throw new ApiError(409, "in_use", `${cur.name} is used by ${users.join(", ")}; remove those references first`);
    const app = storageApp(cur.name);
    if (ctx.registry.deployments.list({ app, limit: 20 }).some((x) => x.status === "queued" || x.status === "running")) throw new ApiError(409, "conflict", `${cur.name} has a deployment in progress; wait for it to finish`);
    const row = ctx.registry.apps.get(app);
    let removed = null as null | { units: string[]; hostnames: string[] };
    if (row && row.status !== "missing") {
      try {
        removed = await ctx.agents.forServer(cur.server).call("app.delete", { app }, { timeoutMs: 5 * 60_000 });
      } catch (e) {
        if (!(e instanceof AgentError && e.code === "not_found")) throw e;
      }
    }
    ctx.registry.apps.remove(app);
    ctx.registry.storages.remove(cur.name);
    audit(who, "storage.delete", app, { storage: cur.name, server: cur.server, hostnames: removed?.hostnames ?? [] });
    return { ok: true, storage: cur.name, hostnames: removed?.hostnames ?? [] };
  }));

  // ---- container registries: logins used when pulling the images of image services ----
  const registryHost = z.string().toLowerCase().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/, "expected a registry host such as ghcr.io");
  // Names only (never the secret): deployers need them to choose which login an app pulls with.
  router.get("/v1/registries", route("deployer", () => ({ registries: ctx.registry.registryCredentials.list() })));

  router.put("/v1/registries/:host", route("admin", async (event, who) => {
    const host = registryHost.parse(getRouterParam(event, "host"));
    // A token pasted from a web page often carries a newline or a space at the end, which no registry accepts.
    const b = await body(event, z.object({ username: z.string().trim().min(1).max(255), password: z.string().trim().min(1).max(4096) }));
    const row = ctx.registry.registryCredentials.set({ host, username: b.username, password: b.password, createdBy: who.id });
    audit(who, "registry.set", undefined, { host, username: b.username });
    return row;
  }));

  // `?username=` says which login when a registry has several.
  router.delete("/v1/registries/:host", route("admin", (event, who) => {
    const host = registryHost.parse(getRouterParam(event, "host"));
    const mine = ctx.registry.registryCredentials.list().filter((c) => c.host === host);
    if (mine.length === 0) throw new ApiError(404, "not_found", `no login for "${host}"`);
    const asked = getQuery(event).username;
    const username = typeof asked === "string" && asked ? asked : mine.length === 1 ? mine[0]!.username : undefined;
    if (username === undefined) throw new ApiError(400, "bad_request", `${host} has several logins (${mine.map((c) => c.username).join(", ")}); say which with ?username=`);
    if (!ctx.registry.registryCredentials.remove(host, username)) throw new ApiError(404, "not_found", `no login "${username}" for "${host}"`);
    audit(who, "registry.remove", undefined, { host, username });
    return { ok: true };
  }));

  // Which login an app pulls its images from `host` with (null: the registry's default, i.e. its only login).
  router.put("/v1/apps/:app/registry-logins/:host", route("deployer", async (event, who) => {
    const name = userAppParam(event);
    const host = registryHost.parse(getRouterParam(event, "host"));
    const { username } = await body(event, z.object({ username: z.string().min(1).max(255).nullable() }));
    if (!ctx.registry.registryCredentials.setAppChoice(name, host, username)) throw new ApiError(404, "not_found", `no login "${username}" for "${host}"`);
    audit(who, "registry.choose", name, { host, username });
    return { registryLogins: ctx.registry.registryCredentials.appChoices(name) };
  }));

  // ---- git: link a repository, deploy from it, receive push webhooks ----
  const MAX_HOOK_BYTES = 5 * 1024 * 1024;
  const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
  const newSecret = () => randomBytes(32).toString("hex");
  const linkSchema = z.object({
    repository: z.string().min(1).max(300),
    branch: z.string().min(1).max(100).default("main"),
    provider: z.enum(["github", "gitlab", "other"]).default("github"),
    subpath: z.string().max(200).default(""),
    autoDeploy: z.boolean().default(true),
    server: z.string().optional(),
    /** An imported SSH key (Settings → SSH keys). Without one, the app uses its own generated deploy key. */
    sshKeyId: z.string().nullable().optional(),
    /** What to deploy if the repository has no app.yaml (same options as app.yaml, minus the name). null clears it. */
    settings: settingsSchema.nullable().optional(),
  });
  /** Reject settings that app.yaml itself would reject, with the manifest's own messages. */
  const checkSettings = (name: string, settings: unknown) => {
    if (!settings) return;
    try {
      renderManifest(name, settings as never);
    } catch (e) {
      if (e instanceof ZodError) throw e; // reported field by field
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
    }
  };
  const fallbackFor = (l: GitLinkRow) => (l.settings ? renderManifest(l.app, l.settings as never) : undefined);
  const checkLink = (l: { repository: string; branch: string; subpath: string }) => {
    try {
      validateRepoUrl(l.repository, { allowLocal: ctx.gitAllowLocal });
      validateBranch(l.branch);
      validateSubpath(l.subpath);
    } catch (e) {
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
    }
  };
  /** Never includes the webhook secret. */
  const publicLink = (event: H3Event, l: GitLinkRow) => ({
    app: l.app,
    provider: l.provider,
    repository: l.repository,
    branch: l.branch,
    subpath: l.subpath,
    autoDeploy: l.autoDeploy,
    publicKey: l.sshKeyId ? "" : l.publicKey,
    keyFingerprint: l.sshKeyId ? "" : l.keyFingerprint,
    webhookUrl: `${origin(event)}/api/v1/hooks/${l.app}`,
    sshKeyId: l.sshKeyId,
    settings: foldSharedEnvironment(l.settings),
    sshKey: l.sshKeyId ? (() => { const k = ctx.registry.sshKeys.get(l.sshKeyId!); return k ? { id: k.id, name: k.name, fingerprint: k.fingerprint } : null; })() : null,
    lastDeliveryAt: l.lastDeliveryAt,
    lastDeliveryResult: l.lastDeliveryResult,
    createdAt: l.createdAt,
  });
  const needLink = (name: string) => {
    const l = ctx.registry.gitLinks.get(name);
    if (!l) throw new ApiError(404, "not_found", `app "${name}" is not linked to a repository`);
    return l;
  };

  /** Queue a deployment of the linked branch, folding into one that is already waiting. */
  function queueGitDeploy(name: string, link: GitLinkRow, trigger: "manual" | "webhook", requestedBy: string | null, skipIfUnchanged: boolean) {
    const waiting = jobs.queuedGit(name);
    if (waiting) return { id: waiting, status: "queued" as const, coalesced: true };
    const server = ctx.registry.apps.get(name)?.server ?? defaultServer();
    const id = randomUUID();
    ctx.registry.deployments.create({ id, app: name, server, action: "deploy", trigger, requestedBy });
    jobs.enqueueGit({ id, app: name, server, repository: link.repository, branch: link.branch, subpath: link.subpath, skipIfUnchanged, trigger, sshKeyId: ctx.registry.gitLinks.get(name)?.sshKeyId ?? link.sshKeyId, fallbackManifest: fallbackFor(link) });
    return { id, status: "queued" as const, coalesced: false };
  }

  router.get("/v1/apps/:app/git", route("viewer", (event) => publicLink(event, needLink(appParam(event)))));

  router.put("/v1/apps/:app/git", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const b = await body(event, linkSchema);
    checkLink(b);
    const existing = ctx.registry.gitLinks.get(name);
    const pinned = ctx.registry.apps.get(name)?.server;
    if (pinned && b.server && b.server !== pinned) throw new ApiError(409, "pinned_to_other_server", `app "${name}" is pinned to server "${pinned}"`);
    const server = pinned ?? b.server ?? defaultServer();
    const target = ctx.registry.servers.get(server);
    if (!target) throw new ApiError(404, "not_found", `unknown server "${server}"`);
    if (target.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${server}" has not been enrolled yet`);
    const sshKeyId = b.sshKeyId ?? null;
    if (sshKeyId) needSshKey(sshKeyId);
    checkSettings(name, b.settings);
    const key = sshKeyId ? { publicKey: "", fingerprint: "" } : await ctx.agents.forServer(server).call("git.keygen", { app: name });
    ctx.registry.apps.ensure(name, server);
    const secret = existing?.webhookSecret ?? newSecret();
    const link = ctx.registry.gitLinks.upsert({
      app: name, provider: b.provider, repository: b.repository.trim(), branch: b.branch, subpath: b.subpath, autoDeploy: b.autoDeploy,
      webhookSecret: secret, publicKey: key.publicKey, keyFingerprint: key.fingerprint, sshKeyId,
      settings: b.settings === undefined ? (existing?.settings ?? null) : b.settings,
    });
    audit(who, existing ? "git.update" : "git.link", name, { repository: link.repository, branch: link.branch, server });
    setResponseStatus(event, existing ? 200 : 201);
    return { link: publicLink(event, link), ...(existing ? {} : { webhookSecret: secret }) }; // the secret is shown once
  }));

  router.patch("/v1/apps/:app/git", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const cur = needLink(name);
    const patch = await body(event, linkSchema.partial().omit({ server: true }));
    const merged = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as GitLinkRow;
    checkLink(merged);
    checkSettings(name, patch.settings);
    if (patch.sshKeyId !== undefined) {
      merged.sshKeyId = patch.sshKeyId;
      if (patch.sshKeyId) needSshKey(patch.sshKeyId);
      else if (!merged.publicKey) {
        const key = await agentFor(event, name).call("git.keygen", { app: name });
        merged.publicKey = key.publicKey;
        merged.keyFingerprint = key.fingerprint;
      }
    }
    const link = ctx.registry.gitLinks.upsert(merged);
    audit(who, "git.update", name, { branch: link.branch, autoDeploy: link.autoDeploy });
    return publicLink(event, link);
  }));

  const refuseIfImportedKey = (l: GitLinkRow) => {
    if (l.sshKeyId) throw new ApiError(400, "bad_request", "this repository uses an imported SSH key; manage it under Settings → SSH keys");
  };

  router.post("/v1/apps/:app/git/rotate-secret", route("admin", (event, who) => {
    const name = userAppParam(event);
    const cur = needLink(name);
    const secret = newSecret();
    ctx.registry.gitLinks.upsert({ ...cur, webhookSecret: secret });
    audit(who, "git.rotate-secret", name);
    return { webhookSecret: secret }; // shown once
  }));

  router.post("/v1/apps/:app/git/rotate-key", route("admin", async (event, who) => {
    const name = userAppParam(event);
    const cur = needLink(name);
    refuseIfImportedKey(cur);
    const key = await agentFor(event, name).call("git.keygen", { app: name, rotate: true });
    const link = ctx.registry.gitLinks.upsert({ ...cur, publicKey: key.publicKey, keyFingerprint: key.fingerprint });
    audit(who, "git.rotate-key", name);
    return publicLink(event, link);
  }));

  router.post("/v1/apps/:app/git/check", route("deployer", async (event) => {
    const name = userAppParam(event);
    const link = needLink(name);
    return agentFor(event, name).call("git.check", { app: name, repository: link.repository, branch: link.branch, auth: authFor(link.sshKeyId) });
  }));

  router.post("/v1/apps/:app/git/deploy", route("deployer", (event, who) => {
    const name = userAppParam(event);
    const r = queueGitDeploy(name, needLink(name), "manual", who.id, false);
    audit(who, "git.deploy", name, { deployment: r.id, coalesced: r.coalesced });
    setResponseStatus(event, 202);
    return r;
  }));

  router.delete("/v1/apps/:app/git", route("admin", async (event, who) => {
    const name = userAppParam(event);
    needLink(name);
    ctx.registry.gitLinks.remove(name);
    audit(who, "git.unlink", name);
    return { ok: true };
  }));

  // Public: GitHub/GitLab push events. The payload only *triggers*; the agent fetches the branch from the remote itself.
  router.post("/v1/hooks/:app", open(async (event) => {
    const ip = clientIp(event, ctx);
    limiter.assertAllowed(ip);
    const parsed = appName.safeParse(getRouterParam(event, "app"));
    const link = parsed.success ? ctx.registry.gitLinks.get(parsed.data) : undefined;
    if (!link) {
      limiter.recordFailure(ip);
      throw new ApiError(404, "not_found", "unknown hook");
    }
    if (Number(getHeader(event, "content-length") ?? 0) > MAX_HOOK_BYTES) throw new ApiError(413, "payload_too_large", "webhook payload too large");
    const raw = Buffer.from((await readRawBody(event, false)) ?? Buffer.alloc(0));
    if (raw.length > MAX_HOOK_BYTES) throw new ApiError(413, "payload_too_large", "webhook payload too large");

    let authentic = false;
    let kind = "";
    if (link.provider === "github") {
      const sig = getHeader(event, "x-hub-signature-256") ?? "";
      authentic = sig !== "" && safeEqual(sig, `sha256=${createHmac("sha256", link.webhookSecret).update(raw).digest("hex")}`);
      kind = getHeader(event, "x-github-event") ?? "";
    } else if (link.provider === "gitlab") {
      const token = getHeader(event, "x-gitlab-token") ?? "";
      authentic = token !== "" && safeEqual(token, link.webhookSecret);
      kind = getHeader(event, "x-gitlab-event") ?? "";
    } else {
      throw new ApiError(400, "bad_request", "webhooks need the repository's provider to be github or gitlab");
    }
    if (!authentic) {
      limiter.recordFailure(ip);
      throw new ApiError(401, "unauthorized", "invalid webhook signature");
    }

    const ignore = (reason: string) => {
      ctx.registry.gitLinks.markDelivery(link.app, `ignored: ${reason}`);
      return { ok: true, ignored: reason };
    };
    if (link.provider === "github" && kind === "ping") return ignore("ping");
    if (kind !== (link.provider === "github" ? "push" : "Push Hook")) return ignore(`event "${kind}" is not a push`);

    let payload: { ref?: string; after?: string; checkout_sha?: string | null; deleted?: boolean };
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ApiError(400, "bad_request", "webhook body is not valid JSON");
    }
    const after = payload.after ?? payload.checkout_sha ?? "";
    if (!payload.ref?.startsWith("refs/heads/")) return ignore("not a branch push");
    if (payload.ref.slice("refs/heads/".length) !== link.branch) return ignore(`branch ${payload.ref.slice("refs/heads/".length)} is not ${link.branch}`);
    if (payload.deleted === true || /^0+$/.test(after) || payload.checkout_sha === null) return ignore("branch deleted");
    if (!link.autoDeploy) return ignore("auto-deploy is off");

    const r = queueGitDeploy(link.app, link, "webhook", null, true);
    ctx.registry.gitLinks.markDelivery(link.app, r.coalesced ? "queued (joined a waiting deployment)" : "queued");
    setResponseStatus(event, 202);
    return { ok: true, ...r };
  }));

  /** Which server runs the git operation: the app's pinned one, the requested one, or local. */
  const gitServer = (requested: string | undefined, appNameOrNull?: string) => {
    const pinned = appNameOrNull ? ctx.registry.apps.get(appNameOrNull)?.server : undefined;
    const name = pinned ?? requested ?? defaultServer();
    const srv = ctx.registry.servers.get(name);
    if (!srv) throw new ApiError(404, "not_found", `unknown server "${name}"`);
    if (srv.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${name}" has not been enrolled yet`);
    return name;
  };
  const probeSchema = z.object({ repository: z.string().min(1).max(300), sshKeyId: z.string().nullable().optional(), server: z.string().optional() });

  // List a repository's branches over SSH (or public HTTPS) without cloning it.
  router.post("/v1/git/branches", route("deployer", async (event) => {
    const b = await body(event, probeSchema);
    checkLink({ repository: b.repository, branch: "main", subpath: "" });
    return ctx.agents.forServer(gitServer(b.server)).call("git.branches", { repository: b.repository.trim(), auth: authFor(b.sshKeyId) }, { timeoutMs: 60_000 });
  }));

  // Fetch a branch and read app.yaml so the UI can show what would be deployed (and under which name).
  router.post("/v1/git/inspect", route("deployer", async (event) => {
    const b = await body(event, probeSchema.extend({ branch: z.string().min(1).max(100), subpath: z.string().max(200).default("") }));
    checkLink({ repository: b.repository, branch: b.branch, subpath: b.subpath });
    return ctx.agents.forServer(gitServer(b.server)).call("git.inspect", { repository: b.repository.trim(), branch: b.branch, subpath: b.subpath || undefined, auth: authFor(b.sshKeyId) }, { timeoutMs: 120_000 });
  }));

  // One step: inspect the branch, name the app from its app.yaml, link the repository and deploy it.
  router.post("/v1/git/deployments", route("admin", async (event, who) => {
    // Without an app.yaml in the repository, the caller names the app and supplies its settings instead.
    const b = await body(event, linkSchema.extend({ appName: z.string().regex(IDENT_RE, "invalid app name").optional() }));
    checkLink(b);
    const server = gitServer(b.server);
    const sshKeyId = b.sshKeyId ?? null;
    const auth = authFor(sshKeyId);
    const seen = await ctx.agents.forServer(server).call("git.inspect", { repository: b.repository.trim(), branch: b.branch, subpath: b.subpath || undefined, auth }, { timeoutMs: 120_000 });
    let name: string;
    if (seen.hasManifest) {
      // app.yaml names the app and fills the form in; the settings the form sends (if any) are what the app starts from
      if (!seen.valid || !seen.appName) throw new ApiError(422, "invalid_manifest", seen.error ?? "app.yaml is invalid");
      name = seen.appName;
      if (b.settings) checkSettings(name, b.settings);
    } else {
      if (!b.appName) throw new ApiError(422, "no_manifest", "the repository has no app.yaml: give the app a name and its settings");
      if (!b.settings || Object.keys(b.settings.services ?? {}).length === 0) throw new ApiError(422, "no_manifest", "the repository has no app.yaml: define at least one service");
      name = b.appName;
      checkSettings(name, b.settings);
    }
    if (ctx.registry.apps.get(name)?.kind === "storage") throw new ApiError(409, "managed_by_storage", `"${name}" serves a storage; pick another name`);
    const pinned = ctx.registry.apps.get(name)?.server;
    if (pinned && pinned !== server) throw new ApiError(409, "pinned_to_other_server", `app "${name}" is pinned to server "${pinned}"`);
    if (ctx.registry.gitLinks.get(name)) throw new ApiError(409, "conflict", `app "${name}" is already linked to a repository`);
    const key = sshKeyId ? { publicKey: "", fingerprint: "" } : await ctx.agents.forServer(server).call("git.keygen", { app: name });
    ctx.registry.apps.ensure(name, server);
    const secret = newSecret();
    const link = ctx.registry.gitLinks.upsert({
      app: name, provider: b.provider, repository: b.repository.trim(), branch: b.branch, subpath: b.subpath, autoDeploy: b.autoDeploy,
      webhookSecret: secret, publicKey: key.publicKey, keyFingerprint: key.fingerprint, sshKeyId,
      settings: b.settings ?? null,
    });
    const r = queueGitDeploy(name, link, "manual", who.id, false);
    audit(who, "git.link", name, { repository: link.repository, branch: link.branch, server, deployment: r.id });
    setResponseStatus(event, 202);
    return { app: name, deployment: r, link: publicLink(event, link), webhookSecret: secret }; // the secret is shown once
  }));

  // Render settings as the app.yaml they stand for (the UI shows it as a preview); errors are the manifest's own.
  router.post("/v1/manifest/render", route("viewer", async (event) => {
    const b = await body(event, z.object({ name: z.string().regex(IDENT_RE, "invalid app name"), settings: settingsSchema }));
    checkSettings(b.name, b.settings);
    return { text: renderManifest(b.name, b.settings as never) };
  }));

  router.get("/v1/deployments/:id/log", route("deployer", async (event) => {
    const d = ctx.registry.deployments.get(getRouterParam(event, "id") ?? "");
    if (!d) throw new ApiError(404, "not_found", "unknown deployment");
    const from = Math.max(0, Number(getQuery(event).from ?? 0) || 0);
    if (d.status === "queued" || d.status === "running") {
      try {
        const r = await ctx.agents.forServer(d.server).call("build.log", { id: d.id, from }, { timeoutMs: 8_000 });
        return { text: r.text, next: r.next, done: false };
      } catch {
        return { text: "", next: from, done: false };
      }
    }
    const bytes = Buffer.from(ctx.registry.deployments.getLog(d.id) ?? "");
    return { text: bytes.subarray(Math.min(from, bytes.length)).toString("utf8"), next: bytes.length, done: true };
  }));

  // ---- servers ----
  const serverName = z.string().regex(IDENT_RE, "invalid server name");
  const sName = (event: H3Event) => serverName.parse(getRouterParam(event, "name"));
  const needServer = (name: string) => {
    const s = ctx.registry.servers.get(name);
    if (!s) throw new ApiError(404, "not_found", `unknown server "${name}"`);
    return s;
  };

  router.get("/v1/servers", route("viewer", () => ({ servers: ctx.registry.servers.list() })));
  router.get("/v1/servers/:name", route("viewer", (event) => needServer(sName(event))));

  router.post("/v1/servers", route("admin", async (event, who) => {
    const { name, address } = await body(event, z.object({ name: serverName, address: z.string().min(1).max(260) }));
    if (name === "local") throw new ApiError(400, "bad_request", '"local" is reserved');
    try {
      parseAddress(address);
    } catch (e) {
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
    }
    if (ctx.registry.servers.get(name)) throw new ApiError(409, "conflict", `server "${name}" already exists`);
    ctx.registry.servers.create({ name, address: address.trim() });
    const token = ctx.registry.servers.newEnrollment(name);
    audit(who, "server.add", undefined, { server: name, address });
    setResponseStatus(event, 201);
    return enrollmentInfo(event, name, token);
  }));

  router.post("/v1/servers/:name/enrollment", route("admin", async (event, who) => {
    const name = sName(event);
    if (needServer(name).kind === "local") throw new ApiError(400, "bad_request", "the local server needs no enrollment");
    audit(who, "server.enrollment", undefined, { server: name });
    return enrollmentInfo(event, name, ctx.registry.servers.newEnrollment(name));
  }));

  router.post("/v1/servers/:name/check", route("admin", async (event) => {
    const name = sName(event);
    needServer(name);
    return (await checkServer(ctx, name)) ?? needServer(name);
  }));

  // ---- settings of a server: /etc/freighter/config.yaml, edited through its agent ----
  const settingsFor = async (name: string) => {
    const s = needServer(name);
    const { fields } = await ctx.agents.forServer(name).call("config.get", {});
    return { server: s, fields: fields.filter((f) => f.scope === "agent") };
  };
  router.get("/v1/servers/:name/config", route("admin", async (event) => {
    const { fields } = await settingsFor(sName(event));
    return { fields };
  }));
  router.put("/v1/servers/:name/config", route("admin", async (event, who) => {
    const name = sName(event);
    const { changes } = await body(event, ops["config.set"].args);
    const { fields } = await settingsFor(name);
    const allowed = new Set(fields.map((f) => f.key));
    for (const key of Object.keys(changes)) {
      if (!allowed.has(key)) throw new ApiError(400, "bad_request", `"${key}" is not a setting that can be changed on ${name}`);
    }
    const result = await ctx.agents.forServer(name).call("config.set", { changes });
    audit(who, "config.set", undefined, { server: name, changes });
    return result;
  }));
  // ---- settings of the control server itself: saved in the registry, no agent involved ----
  const control = ctx.controlSettings ?? createControlSettings({ registry: ctx.registry, file: parseHostConfig({}).api, target: ctx, applyNow: false });
  router.get("/v1/settings", route("admin", () => ({ fields: control.list() })));
  router.put("/v1/settings", route("admin", async (event, who) => {
    const { changes } = await body(event, ops["config.set"].args);
    let result;
    try {
      result = control.set(changes);
    } catch (e) {
      if (e instanceof SettingsError) throw new ApiError(400, "bad_request", e.message);
      throw e;
    }
    if (result.changed.length) audit(who, "settings.set", undefined, { changes });
    return { ...result, restart: [] as ("agent" | "api")[], haproxy: "none" as const };
  }));
  router.get("/v1/version", route("viewer", async () => ({ commit: await controlVersion(ctx) })));
  router.get("/v1/servers/:name/upgrade", route("admin", async (event) => {
    const name = sName(event);
    needServer(name);
    return upgradeView(ctx, name);
  }));
  router.post("/v1/servers/:name/upgrade", route("admin", async (event, who) => {
    const name = sName(event);
    needServer(name);
    const { ref, containers, storage, mounts, archives } = await body(event, z.object({ ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional(), containers: z.boolean().optional(), storage: z.boolean().optional(), mounts: z.boolean().optional(), archives: z.boolean().optional() }));
    let view;
    try {
      view = await startServerUpgrade(ctx, name, ref, { withContainers: containers, withStorage: storage, withMounts: mounts, withArchives: archives });
    } catch (e) {
      if (e instanceof UpgradeRefused) throw new ApiError(e.status, e.status === 409 ? "conflict" : "bad_request", e.message);
      throw e;
    }
    audit(who, archives ? "server.add-archives" : mounts ? "server.add-mounts" : storage ? "server.add-storage" : containers ? "server.add-containers" : "server.upgrade", undefined, { server: name, ...(containers || storage || mounts || archives ? {} : { ref: ref ?? view.target }), from: view.commit });
    setResponseStatus(event, 202);
    return view;
  }));
  // How a server's machine has been doing: load, memory and disk, sampled with the apps' metrics.
  router.get("/v1/servers/:name/metrics", route("viewer", (event) => {
    const name = sName(event);
    needServer(name);
    const { minutes } = z.object({ minutes: z.coerce.number().int().min(1).max(24 * 60).default(60) }).parse(getQuery(event));
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    return { points: ctx.registry.hostSamples.series(name, since) };
  }));

  // ---- the file explorer: every file on a server, as root. Admins only; changes and downloads are in the audit log. ----
  const fsAgent = (event: H3Event) => {
    const name = sName(event);
    const server = needServer(name);
    if (server.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${name}" has not been enrolled yet`);
    return { name, agent: ctx.agents.forServer(name) };
  };
  /** An agent from before the file explorer says it doesn't know the operation; say what to do instead. */
  const fsCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentError && /unknown operation/.test(e.message)) throw new ApiError(409, "conflict", "this server's agent predates the file explorer. Upgrade it first");
      throw e;
    }
  };
  const fsPathParam = z.string().min(1).max(4096);
  const fsPathsBody = z.array(fsPathParam).min(1).max(1000);
  const fsTouched = (paths: string[]) => (paths.length > 20 ? [...paths.slice(0, 20), `… and ${paths.length - 20} more`] : paths);
  const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  const download = (event: H3Event, stream: Readable, name: string, size?: number) =>
    new Response(Readable.toWeb(stream) as never, {
      headers: { "content-type": "application/octet-stream", "content-disposition": attachment(name), "cache-control": "no-store", "x-content-type-options": "nosniff", ...(size === undefined ? {} : { "content-length": String(size) }) },
    });

  router.get("/v1/servers/:name/fs", route("admin", (event) => {
    const { agent } = fsAgent(event);
    const { path } = z.object({ path: fsPathParam.default("/") }).parse(getQuery(event));
    return fsCall(() => agent.call("fs.list", { path }, { timeoutMs: 60_000 }));
  }));
  router.post("/v1/servers/:name/fs/mkdir", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const { path } = await body(event, z.object({ path: fsPathParam }));
    await fsCall(() => agent.call("fs.mkdir", { path }, { timeoutMs: 30_000 }));
    audit(who, "file.mkdir", undefined, { server: name, path });
    return { ok: true };
  }));
  router.post("/v1/servers/:name/fs/rename", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const b = await body(event, z.object({ path: fsPathParam, name: z.string().min(1).max(255) }));
    const r = await fsCall(() => agent.call("fs.rename", b, { timeoutMs: 30_000 }));
    audit(who, "file.rename", undefined, { server: name, path: b.path, to: r.path });
    return r;
  }));
  for (const op of ["copy", "move"] as const) {
    router.post(`/v1/servers/:name/fs/${op}`, route("admin", async (event, who) => {
      const { name, agent } = fsAgent(event);
      const b = await body(event, z.object({ paths: fsPathsBody, to: fsPathParam, onConflict: z.enum(["fail", "overwrite", "rename"]).optional() }));
      const r = await fsCall(() => agent.call(op === "copy" ? "fs.copy" : "fs.move", b, { timeoutMs: 6 * 3_600_000 }));
      audit(who, `file.${op}`, undefined, { server: name, paths: fsTouched(b.paths), to: b.to, done: r.done.length, failed: r.failed.length });
      return r;
    }));
  }
  router.post("/v1/servers/:name/fs/extract", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const b = await body(event, z.object({ paths: fsPathsBody, to: fsPathParam.optional(), onConflict: z.enum(["fail", "overwrite", "rename"]).optional() }));
    const r = await fsCall(() => agent.call("fs.extract", b, { timeoutMs: 6 * 3_600_000 }));
    audit(who, "file.extract", undefined, { server: name, paths: fsTouched(b.paths), ...(b.to ? { to: b.to } : {}), done: r.done.length, failed: r.failed.length });
    return r;
  }));
  router.get("/v1/servers/:name/fs/identities", route("admin", async (event) => {
    const { agent } = fsAgent(event);
    return fsCall(() => agent.call("fs.identities", {}, { timeoutMs: 30_000 }));
  }));
  router.post("/v1/servers/:name/fs/chown", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const b = await body(event, z.object({ paths: fsPathsBody, owner: z.string().min(1).max(64).optional(), group: z.string().min(1).max(64).optional(), recursive: z.boolean().optional() }));
    if (!b.owner && !b.group) throw new ApiError(400, "bad_request", "name an owner, a group, or both");
    const r = await fsCall(() => agent.call("fs.chown", b, { timeoutMs: 3_600_000 }));
    audit(who, "file.chown", undefined, { server: name, paths: fsTouched(b.paths), ...(b.owner ? { owner: b.owner } : {}), ...(b.group ? { group: b.group } : {}), recursive: !!b.recursive, done: r.done.length, failed: r.failed.length });
    return r;
  }));
  router.post("/v1/servers/:name/fs/delete", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const b = await body(event, z.object({ paths: fsPathsBody }));
    const r = await fsCall(() => agent.call("fs.delete", b, { timeoutMs: 3_600_000 }));
    audit(who, "file.delete", undefined, { server: name, paths: fsTouched(b.paths), done: r.done.length, failed: r.failed.length });
    return r;
  }));
  // Upload one file: the body is the file. `path` is where it goes; the browser sends one request per file.
  router.put("/v1/servers/:name/fs/upload", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const q = z.object({ path: fsPathParam, overwrite: z.enum(["0", "1"]).default("0") }).parse(getQuery(event));
    const size = Number(getHeader(event, "content-length"));
    if (!Number.isInteger(size) || size < 0) throw new ApiError(411, "length_required", "send the file with a Content-Length");
    const web = getRequestWebStream(event);
    const source = web ? Readable.fromWeb(web as never) : Readable.from([]);
    if (size > 0 && !web) throw new ApiError(400, "bad_request", "the request has no body");
    await fsCall(() => agent.writeFile({ path: q.path, size, overwrite: q.overwrite === "1" }, source, { timeoutMs: 2 * 3_600_000 }));
    audit(who, "file.upload", undefined, { server: name, path: q.path, bytes: size, overwrite: q.overwrite === "1" });
    return { ok: true, path: q.path, size };
  }));
  router.get("/v1/servers/:name/fs/download", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const { path } = z.object({ path: fsPathParam }).parse(getQuery(event));
    const { result, body: stream } = await fsCall(() => agent.openStream("fs.read", { path }));
    audit(who, "file.download", undefined, { server: name, path, bytes: result.size });
    return download(event, stream, path.split("/").pop() || "download", result.size);
  }));
  // A zip of several paths: the browser downloads it by following a link, which can't carry a body, so the paths are
  // registered first and the link holds a ticket that works for a minute.
  const tickets = new Map<string, { server: string; paths: string[]; who: string; expires: number }>();
  router.post("/v1/servers/:name/fs/archive", route("admin", async (event, who) => {
    const { name } = fsAgent(event);
    const { paths } = await body(event, z.object({ paths: fsPathsBody }));
    const now = Date.now();
    for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, { server: name, paths, who: who.id, expires: now + 60_000 });
    const base = paths.length === 1 ? paths[0]!.split("/").pop() || "root" : "files";
    return { ticket, name: `${name}-${base}.zip` };
  }));
  router.get("/v1/servers/:name/fs/archive/:ticket", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const t = tickets.get(getRouterParam(event, "ticket") ?? "");
    if (!t || t.expires < Date.now() || t.server !== name || t.who !== who.id) throw new ApiError(404, "not_found", "this download link has expired; start it again");
    const { body: stream } = await fsCall(() => agent.openStream("fs.archive", { paths: t.paths }));
    audit(who, "file.archive", undefined, { server: name, paths: fsTouched(t.paths) });
    const base = t.paths.length === 1 ? t.paths[0]!.split("/").pop() || "root" : "files";
    return download(event, stream, `${name}-${base}.zip`);
  }));

  // ---- what a storage holds: buckets and keys, browsed through the agent of the server it runs on ----
  const storageFiles = (event: H3Event) => {
    const row = needStorage(event);
    const server = ctx.registry.servers.get(row.server);
    if (!server || server.status === "pending") throw new ApiError(409, "server_not_enrolled", `server "${row.server}" is not available`);
    return { name: row.name, agent: ctx.agents.forServer(row.server) };
  };
  const keyPath = z.string().min(1).max(4096).refine((p) => p.startsWith("/"), "the path starts with /");
  router.get("/v1/storages/:name/files", route("admin", (event) => {
    const { name, agent } = storageFiles(event);
    const { path } = z.object({ path: keyPath.default("/") }).parse(getQuery(event));
    return fsCall(() => agent.call("storage.ls", { name, path }, { timeoutMs: 60_000 }));
  }));
  router.post("/v1/storages/:name/files/mkdir", route("admin", async (event, who) => {
    const { name, agent } = storageFiles(event);
    const { path } = await body(event, z.object({ path: keyPath }));
    await fsCall(() => agent.call("storage.mkdir", { name, path }, { timeoutMs: 60_000 }));
    audit(who, "storage.mkdir", undefined, { storage: name, path });
    return { ok: true };
  }));
  router.post("/v1/storages/:name/files/rename", route("admin", async (event, who) => {
    const { name, agent } = storageFiles(event);
    const b = await body(event, z.object({ path: keyPath, newName: z.string().min(1).max(1024) }));
    const r = await fsCall(() => agent.call("storage.rename", { name, ...b }, { timeoutMs: 30 * 60_000 }));
    audit(who, "storage.rename", undefined, { storage: name, path: b.path, to: r.path });
    return r;
  }));
  router.post("/v1/storages/:name/files/delete", route("admin", async (event, who) => {
    const { name, agent } = storageFiles(event);
    const b = await body(event, z.object({ paths: fsPathsBody }));
    const r = await fsCall(() => agent.call("storage.rm", { name, paths: b.paths }, { timeoutMs: 3_600_000 }));
    audit(who, "storage.delete-files", undefined, { storage: name, paths: fsTouched(b.paths), done: r.done.length, failed: r.failed.length });
    return r;
  }));
  router.put("/v1/storages/:name/files/upload", route("admin", async (event, who) => {
    const { name, agent } = storageFiles(event);
    const q = z.object({ path: keyPath, overwrite: z.enum(["0", "1"]).default("0") }).parse(getQuery(event));
    const size = Number(getHeader(event, "content-length"));
    if (!Number.isInteger(size) || size < 0) throw new ApiError(411, "length_required", "send the file with a Content-Length");
    const web = getRequestWebStream(event);
    const source = web ? Readable.fromWeb(web as never) : Readable.from([]);
    if (size > 0 && !web) throw new ApiError(400, "bad_request", "the request has no body");
    await fsCall(() => agent.writeFile({ path: q.path, size, overwrite: q.overwrite === "1", storage: name }, source, { timeoutMs: 2 * 3_600_000 }));
    audit(who, "storage.upload", undefined, { storage: name, path: q.path, bytes: size, overwrite: q.overwrite === "1" });
    return { ok: true, path: q.path, size };
  }));
  // A link that downloads one object for a while without a key: the storage's buckets are private, so a bare address
  // answers "UnsupportedAlgorithm". Needs a domain, since the link has to be reachable from where it is opened.
  router.post("/v1/storages/:name/files/link", route("admin", async (event, who) => {
    const row = needStorage(event);
    const { path, expires } = await body(event, z.object({ path: keyPath, expires: z.number().int().min(60).max(MAX_LINK_SECONDS).default(3600) }));
    if (path.split("/").filter(Boolean).length < 2) throw new ApiError(400, "bad_request", "a link is for a file in a bucket: /bucket/name");
    const secrets = ctx.registry.storages.secrets(row.name);
    if (!secrets) throw new ApiError(409, "conflict", "this storage has no keys yet");
    const domain = await ctx.agents.forServer(row.server).call("domains.get", { app: storageApp(row.name) }).then((r) => r.domains.find((d) => d.service === "s3"), () => undefined);
    if (!domain) throw new ApiError(409, "conflict", "give this storage a domain first: a link has to work from outside the server");
    const url = presignGet({ endpoint: `${domain.tls === "auto" ? "https" : "http"}://${domain.hostname}`, path, accessKey: row.accessKey, secretKey: secrets.secretKey, expires });
    audit(who, "storage.link", undefined, { storage: row.name, path, expires }); // never the link: it is the credential
    return { url, expiresAt: new Date(Date.now() + expires * 1000).toISOString() };
  }));
  router.get("/v1/storages/:name/files/download", route("admin", async (event, who) => {
    const { name, agent } = storageFiles(event);
    const { path } = z.object({ path: keyPath }).parse(getQuery(event));
    const { result, body: stream } = await fsCall(() => agent.openStream("fs.read", { path, storage: name }));
    audit(who, "storage.download", undefined, { storage: name, path, bytes: result.size });
    return download(event, stream, path.split("/").pop() || "download", result.size);
  }));

  // ---- the process list of a server ----
  const procCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AgentError && /unknown operation/.test(e.message)) throw new ApiError(409, "conflict", "this server's agent predates the process list. Upgrade it first");
      throw e;
    }
  };
  router.get("/v1/servers/:name/processes", route("admin", (event) => {
    const { agent } = fsAgent(event);
    return procCall(() => agent.call("processes.list", {}, { timeoutMs: 30_000 }));
  }));
  router.post("/v1/servers/:name/processes/signal", route("admin", async (event, who) => {
    const { name, agent } = fsAgent(event);
    const b = await body(event, z.object({ pid: z.number().int().positive(), starttime: z.number().int().nonnegative(), signal: z.enum(["TERM", "KILL", "HUP", "INT", "STOP", "CONT"]), /** What the user saw, for the audit log (never the command line, which can hold secrets). */ name: z.string().max(64).optional() }));
    await procCall(() => agent.call("processes.signal", { pid: b.pid, starttime: b.starttime, signal: b.signal }, { timeoutMs: 15_000 }));
    audit(who, "process.signal", undefined, { server: name, pid: b.pid, signal: b.signal, ...(b.name ? { process: b.name } : {}) });
    return { ok: true };
  }));

  router.post("/v1/servers/:name/updates/check", route("admin", async (event) => {
    const name = sName(event);
    needServer(name);
    const { ref } = await body(event, z.object({ ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional() }));
    try {
      return await checkServerUpdates(ctx, name, ref);
    } catch (e) {
      if (e instanceof UpgradeRefused) throw new ApiError(e.status, e.status === 409 ? "conflict" : "bad_request", e.message);
      throw e;
    }
  }));
  router.post("/v1/servers/:name/restart", route("admin", async (event, who) => {
    const name = sName(event);
    const { service } = await body(event, ops["service.restart"].args);
    const s = needServer(name);
    if (service === "api" && s.kind !== "local") throw new ApiError(400, "bad_request", "the API runs on the control server only");
    audit(who, "service.restart", undefined, { server: name, service });
    return ctx.agents.forServer(name).call("service.restart", { service });
  }));

  router.delete("/v1/servers/:name", route("admin", (event, who) => {
    const s = needServer(sName(event));
    if (s.kind === "local") throw new ApiError(400, "bad_request", "the local server cannot be removed");
    if (s.appCount > 0) throw new ApiError(409, "conflict", `server "${s.name}" still has ${s.appCount} app(s) pinned to it`);
    ctx.registry.servers.remove(s.name);
    audit(who, "server.remove", undefined, { server: s.name });
    return { ok: true };
  }));

  // Public: an agent redeems its one-time token and gets a certificate for the address we registered for it.
  router.post("/v1/enroll", open(async (event) => {
    const ip = clientIp(event, ctx);
    limiter.assertAllowed(ip);
    const { token, csr } = await body(event, z.object({ token: z.string().min(8).max(200), csr: z.string().min(50).max(8192) }));
    try {
      await assertValidCsr(csr); // check before burning the one-time token
    } catch (e) {
      throw new ApiError(400, "bad_request", e instanceof Error ? e.message : String(e));
    }
    const server = ctx.registry.servers.consumeEnrollment(token);
    if (!server || !server.address) {
      limiter.recordFailure(ip);
      throw new ApiError(401, "unauthorized", "invalid or expired enrollment token");
    }
    const { host, port } = parseAddress(server.address);
    const ca = await ctx.pki.ensureCa();
    const serverCert = await issueServerCert({ ca, csrPem: csr, name: server.name, hosts: [host] });
    ctx.registry.servers.setCert(server.name, fingerprint(serverCert), certExpiry(serverCert).toISOString());
    ctx.registry.audit.add({ action: "server.enrolled", detail: { server: server.name } });
    return { name: server.name, port, serverCert, caCert: ca.certPem };
  }));

  async function runSync(opts: { force?: boolean } = {}) {
    if (jobs.busy() && !opts.force) return { skipped: true as const };
    return syncAll(ctx);
  }
  router.post("/v1/sync", route("admin", async (event, who) => {
    audit(who, "sync");
    if (jobs.busy()) throw new ApiError(409, "conflict", "a deployment is in progress; try again when it finishes");
    return syncAll(ctx);
  }));

  app.use(router);
  return { app, jobs, syncAll: runSync };
}
