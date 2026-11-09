import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { IDENT_RE, domainSchema, imageHost, imageServices, parseManifest, renderManifest, settingsSchema, validateBranch, validateRepoUrl, validateSubpath } from "@freighter/manifest";
import { AgentError, ops } from "@freighter/protocol";
import { assertValidCsr, certExpiry, fingerprint, issueServerCert } from "@freighter/pki";
import { isRole, type GitLinkRow, type PendingDomainRow, type Role } from "@freighter/registry";
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
import type { ApiContext, Principal } from "./context.ts";
import { ApiError, toHttpError } from "./errors.ts";
import { createJobs, type Jobs } from "./jobs.ts";
import { parseAddress } from "./agents.ts";
import { createControlSettings } from "./control-settings.ts";
import { parseHostConfig } from "@freighter/core/config";
import { SettingsError } from "@freighter/core/fields";
import { checkDomainDns, type ChallengeProbe, isLocalName, isPrivateOrLoopback, resolveAll, systemDns, type DnsResolver } from "./dns.ts";
import { checkServer, reachableServers } from "./servers.ts";
import { checkServerUpdates, controlVersion, startServerUpgrade, UpgradeRefused, upgradeView } from "./upgrade.ts";
import { syncAll, type SyncResult } from "./sync.ts";

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

  /** service -> image reference, as written in the app's current app.yaml ({} for an app without image services). */
  const imagesOf = (manifestText: string | null | undefined): Record<string, string> => {
    if (!manifestText) return {};
    try {
      return imageServices(parseManifest(manifestText, { legacy: true }));
    } catch {
      return {};
    }
  };

  router.get("/v1/apps/:app", route("viewer", (event) => {
    const name = appParam(event);
    const a = ctx.registry.apps.get(name);
    if (!a) throw new ApiError(404, "not_found", `unknown app "${name}"`);
    return { ...a, images: imagesOf(a.manifestText), registryLogins: ctx.registry.registryCredentials.appChoices(name), services: ctx.registry.services.list(name), deployments: ctx.registry.deployments.list({ app: name, limit: 5 }) };
  }));

  // Remove an app for good: from its server (units, routing, certificates, releases, shared data, secrets), then from here.
  // Typing the name is required of API clients too, so a stray DELETE can't do it.
  router.delete("/v1/apps/:app", route("admin", async (event, who) => {
    const name = appParam(event);
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

  router.get("/v1/apps/:app/env", route("viewer", async (event) => agentFor(event, appParam(event)).call("env.list", { app: appParam(event) })));
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
    const name = appParam(event);
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
  const queueImageDeploy = (event: H3Event, who: Principal, name: string, manifestText: string, trigger: "manual" | "upload", logins: Record<string, string> = {}) => {
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
    jobs.enqueueImageDeploy({ id, app: name, server, manifestText });
    setResponseStatus(event, 202);
    return { id, status: "queued" };
  };

  router.post("/v1/apps/:app/image-deployments", route("deployer", async (event, who) => {
    const { manifest, logins } = await body(event, z.object({ manifest: z.string().min(1).max(262_144), logins: z.record(z.string(), z.string().min(1)).optional() }));
    return queueImageDeploy(event, who, appParam(event), manifest, "manual", logins);
  }));

  // Pull the app's images again (a moved tag, a fixed image) and release the result, keeping the app's current app.yaml.
  router.post("/v1/apps/:app/redeploy", route("deployer", (event, who) => {
    const name = appParam(event);
    const text = ctx.registry.apps.get(name)?.manifestText;
    if (!text) throw new ApiError(404, "not_found", `app "${name}" has not been deployed`);
    return queueImageDeploy(event, who, name, text, "manual");
  }));

  // Change the image (usually the tag) of some services and release it. Everything else in app.yaml stays as it was.
  router.post("/v1/apps/:app/images", route("deployer", async (event, who) => {
    const name = appParam(event);
    const { images } = await body(event, z.object({ images: z.record(z.string(), z.string().min(1)).refine((i) => Object.keys(i).length > 0, "name at least one service") }));
    const text = ctx.registry.apps.get(name)?.manifestText;
    if (!text) throw new ApiError(404, "not_found", `app "${name}" has not been deployed`);
    const current = parseManifest(text, { legacy: true });
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
    return queueImageDeploy(event, who, name, manifestText, "manual");
  }));

  router.post("/v1/apps/:app/rollback", route("deployer", async (event, who) => {
    const name = appParam(event);
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
  router.put("/v1/apps/:app/env/:key", route("admin", async (event, who) => {
    const name = appParam(event);
    const key = envKey.parse(getRouterParam(event, "key"));
    const { value } = await body(event, z.object({ value: z.string() }));
    await agentFor(event, name).call("env.set", { app: name, key, value });
    audit(who, "env.set", name, { key }); // never the value
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

  // ---- container registries: logins used when pulling the images of image services ----
  const registryHost = z.string().toLowerCase().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/, "expected a registry host such as ghcr.io");
  // Names only (never the secret): deployers need them to choose which login an app pulls with.
  router.get("/v1/registries", route("deployer", () => ({ registries: ctx.registry.registryCredentials.list() })));

  router.put("/v1/registries/:host", route("admin", async (event, who) => {
    const host = registryHost.parse(getRouterParam(event, "host"));
    const b = await body(event, z.object({ username: z.string().min(1).max(255), password: z.string().min(1).max(4096) }));
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
    const name = appParam(event);
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
    settings: l.settings,
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
    const name = appParam(event);
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
    const name = appParam(event);
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
    const name = appParam(event);
    const cur = needLink(name);
    const secret = newSecret();
    ctx.registry.gitLinks.upsert({ ...cur, webhookSecret: secret });
    audit(who, "git.rotate-secret", name);
    return { webhookSecret: secret }; // shown once
  }));

  router.post("/v1/apps/:app/git/rotate-key", route("admin", async (event, who) => {
    const name = appParam(event);
    const cur = needLink(name);
    refuseIfImportedKey(cur);
    const key = await agentFor(event, name).call("git.keygen", { app: name, rotate: true });
    const link = ctx.registry.gitLinks.upsert({ ...cur, publicKey: key.publicKey, keyFingerprint: key.fingerprint });
    audit(who, "git.rotate-key", name);
    return publicLink(event, link);
  }));

  router.post("/v1/apps/:app/git/check", route("deployer", async (event) => {
    const name = appParam(event);
    const link = needLink(name);
    return agentFor(event, name).call("git.check", { app: name, repository: link.repository, branch: link.branch, auth: authFor(link.sshKeyId) });
  }));

  router.post("/v1/apps/:app/git/deploy", route("deployer", (event, who) => {
    const name = appParam(event);
    const r = queueGitDeploy(name, needLink(name), "manual", who.id, false);
    audit(who, "git.deploy", name, { deployment: r.id, coalesced: r.coalesced });
    setResponseStatus(event, 202);
    return r;
  }));

  router.delete("/v1/apps/:app/git", route("admin", async (event, who) => {
    const name = appParam(event);
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
      if (!seen.valid || !seen.appName) throw new ApiError(422, "invalid_manifest", seen.error ?? "app.yaml is invalid");
      name = seen.appName; // the file in the repository is the source of truth
    } else {
      if (!b.appName) throw new ApiError(422, "no_manifest", "the repository has no app.yaml: give the app a name and its settings");
      if (!b.settings || Object.keys(b.settings.services ?? {}).length === 0) throw new ApiError(422, "no_manifest", "the repository has no app.yaml: define at least one service");
      name = b.appName;
      checkSettings(name, b.settings);
    }
    const pinned = ctx.registry.apps.get(name)?.server;
    if (pinned && pinned !== server) throw new ApiError(409, "pinned_to_other_server", `app "${name}" is pinned to server "${pinned}"`);
    if (ctx.registry.gitLinks.get(name)) throw new ApiError(409, "conflict", `app "${name}" is already linked to a repository`);
    const key = sshKeyId ? { publicKey: "", fingerprint: "" } : await ctx.agents.forServer(server).call("git.keygen", { app: name });
    ctx.registry.apps.ensure(name, server);
    const secret = newSecret();
    const link = ctx.registry.gitLinks.upsert({
      app: name, provider: b.provider, repository: b.repository.trim(), branch: b.branch, subpath: b.subpath, autoDeploy: b.autoDeploy,
      webhookSecret: secret, publicKey: key.publicKey, keyFingerprint: key.fingerprint, sshKeyId,
      settings: seen.hasManifest ? (b.settings ?? null) : b.settings!,
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
    const { ref, containers } = await body(event, z.object({ ref: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((r) => !r.includes(".."), "invalid ref").optional(), containers: z.boolean().optional() }));
    let view;
    try {
      view = await startServerUpgrade(ctx, name, ref, { withContainers: containers });
    } catch (e) {
      if (e instanceof UpgradeRefused) throw new ApiError(e.status, e.status === 409 ? "conflict" : "bad_request", e.message);
      throw e;
    }
    audit(who, containers ? "server.add-containers" : "server.upgrade", undefined, { server: name, ...(containers ? {} : { ref: ref ?? view.target }), from: view.commit });
    setResponseStatus(event, 202);
    return view;
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
