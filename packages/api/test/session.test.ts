import { describe, expect, it } from "vitest";
import { buildSeries, sampleOnce } from "../src/index.ts";
import { makeApi } from "./helpers.ts";

const CSRF = { "x-requested-with": "freighter" };

describe("browser session", () => {
  async function login(t: Awaited<ReturnType<typeof makeApi>>, token = t.tokens.admin, extra: Record<string, string> = {}) {
    return t.request("/v1/session", { method: "POST", json: { token }, headers: { ...CSRF, ...extra } });
  }
  const cookieOf = (setCookie: string | null) => /fr_session=([^;]+)/.exec(setCookie ?? "")?.[1];

  it("sets an httpOnly, SameSite=Strict cookie and returns the principal", async () => {
    const t = await makeApi();
    const r = await login(t);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "admin", role: "admin" });
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toContain(`fr_session=${t.tokens.admin}`);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=604800/);
    expect(sc).not.toMatch(/Secure/i); // plain http in this test
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "session.login" });
  });

  it("marks the cookie Secure behind an https proxy", async () => {
    const t = await makeApi();
    const r = await login(t, t.tokens.viewer, { "x-forwarded-proto": "https" });
    expect(r.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("rejects bad tokens, missing CSRF header and counts failures", async () => {
    const t = await makeApi();
    expect((await login(t, "fr_nope")).status).toBe(401);
    expect((await t.request("/v1/session", { method: "POST", json: { token: t.tokens.admin } })).status).toBe(403);
    expect((await t.request("/v1/session", { method: "POST", json: {}, headers: CSRF })).status).toBe(400);
    for (let i = 0; i < 10; i++) await login(t, "fr_bad", { "x-forwarded-for": "8.8.8.8" });
    expect((await login(t, t.tokens.admin, { "x-forwarded-for": "8.8.8.8" })).status).toBe(429);
  });

  it("authenticates later requests from the cookie", async () => {
    const t = await makeApi();
    const cookie = `fr_session=${cookieOf((await login(t)).headers.get("set-cookie"))}`;
    const me = await t.request("/v1/session", { headers: { cookie } });
    expect(me.json).toMatchObject({ name: "admin", role: "admin" });
    expect((await t.request("/v1/apps", { headers: { cookie } })).status).toBe(200);
  });

  it("requires the CSRF header for state-changing cookie requests, but not for bearer tokens", async () => {
    const t = await makeApi();
    const cookie = `fr_session=${t.tokens.deployer}`;
    const post = (headers: Record<string, string>) => t.request("/v1/apps/shop/restart", { method: "POST", json: {}, headers });
    expect((await post({ cookie })).status).toBe(403);
    expect((await post({ cookie })).json.error.code).toBe("csrf");
    expect((await post({ cookie, ...CSRF })).status).toBe(200);
    expect((await t.request("/v1/apps/shop/restart", { method: "POST", json: {}, token: t.tokens.deployer })).status).toBe(200);
  });

  it("probing without credentials is free; a revoked token's cookie stops working; logout clears", async () => {
    const t = await makeApi();
    for (let i = 0; i < 15; i++) expect((await t.request("/v1/session", { ip: "7.7.7.7" })).status).toBe(401);
    expect((await t.request("/v1/apps", { token: t.tokens.viewer, ip: "7.7.7.7" })).status).toBe(200); // never rate limited

    const made = await t.request("/v1/tokens", { method: "POST", token: t.tokens.admin, json: { name: "x", role: "viewer" } });
    const cookie = `fr_session=${made.json.token}`;
    expect((await t.request("/v1/apps", { headers: { cookie } })).status).toBe(200);
    await t.request(`/v1/tokens/${made.json.id}`, { method: "DELETE", token: t.tokens.admin });
    expect((await t.request("/v1/apps", { headers: { cookie } })).status).toBe(401);

    const out = await t.request("/v1/session", { method: "DELETE" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/fr_session=;|Max-Age=0|Expires=/i);
  });
});

describe("deployments list", () => {
  it("lists recent deployments across apps", async () => {
    const t = await makeApi();
    t.registry.deployments.create({ app: "a", action: "deploy" });
    t.registry.deployments.create({ app: "b", action: "rollback" });
    const r = await t.request("/v1/deployments?limit=1", { token: t.tokens.viewer });
    expect(r.json.deployments).toHaveLength(1);
    expect((await t.request("/v1/deployments", { token: t.tokens.viewer })).json.deployments).toHaveLength(2);
  });
});

describe("metrics", () => {
  const row = (service: string, at: string, cpuNanos: number | null, unit = "u1") => ({ app: "shop", service, unit, at, active: "active", memoryBytes: 100, cpuNanos, restarts: 0 });

  it("derives cpu percent from counter deltas, skipping resets and unit changes", () => {
    const s = buildSeries([
      row("web", "2026-11-06T10:00:00.000Z", 0),
      row("web", "2026-11-06T10:00:10.000Z", 5_000_000_000), // 50% of a core
      row("web", "2026-11-06T10:00:20.000Z", 1_000_000_000), // counter went backwards -> skipped
      row("web", "2026-11-06T10:00:30.000Z", 2_000_000_000, "u2"), // new unit -> skipped
      row("web", "2026-11-06T10:00:40.000Z", null, "u2"),
      row("worker", "2026-11-06T10:00:00.000Z", 10),
    ]);
    expect(s.web!.map((p) => p.cpuPercent)).toEqual([null, 50, null, null, null]);
    expect(s.worker).toHaveLength(1);
    expect(s.worker![0]!.cpuPercent).toBeNull();
  });

  it("samples from the agent, stores, and prunes beyond retention", async () => {
    const t = await makeApi();
    let now = new Date("2026-11-06T10:00:00.000Z");
    t.ctx.now = () => now;
    t.ctx.metricsRetentionHours = 1;
    expect(await sampleOnce(t.ctx)).toBe(1);
    now = new Date("2026-11-06T10:30:00.000Z");
    await sampleOnce(t.ctx);
    now = new Date("2026-11-06T11:15:00.000Z");
    await sampleOnce(t.ctx); // the 10:00 sample is now older than 1h
    expect(t.registry.metrics.series("shop", "").map((r) => r.at)).toEqual(["2026-11-06T10:30:00.000Z", "2026-11-06T11:15:00.000Z"]);
  });

  it("serves a series for the requested window", async () => {
    const t = await makeApi();
    t.ctx.now = () => new Date("2026-11-06T10:10:00.000Z");
    t.registry.metrics.add([{ app: "shop", service: "web", unit: "u", active: "active", memoryBytes: 1, cpuNanos: 0, restarts: 0 }], "2026-11-06T10:00:00.000Z");
    t.registry.metrics.add([{ app: "shop", service: "web", unit: "u", active: "active", memoryBytes: 2, cpuNanos: 6_000_000_000, restarts: 0 }], "2026-11-06T10:05:00.000Z");
    const r = await t.request("/v1/apps/shop/metrics?minutes=30", { token: t.tokens.viewer });
    expect(r.json.series.web.map((p: { cpuPercent: number | null }) => p.cpuPercent)).toEqual([null, 2]);
    expect((await t.request("/v1/apps/shop/metrics?minutes=5", { token: t.tokens.viewer })).json.series.web).toHaveLength(1);
    expect((await t.request("/v1/apps/shop/metrics?minutes=99999", { token: t.tokens.viewer })).status).toBe(400);
    expect((await t.request("/v1/apps/shop/metrics", {})).status).toBe(401);
  });
});
