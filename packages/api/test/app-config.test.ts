import { describe, expect, it } from "vitest";
import { makeApi, sleepMs } from "./helpers.ts";

const TEXT = "name: shop\nservices:\n  web:\n    command: node server.js\n    port: 3000\n    environment:\n      A: one\n";
const seed = (t: Awaited<ReturnType<typeof makeApi>>) => t.registry.apps.upsert({ name: "shop", server: "local", manifestText: TEXT, currentRelease: "r1", previousRelease: null, status: "deployed" });

describe("GET /v1/apps/:app/config", () => {
  it("returns the agent's configuration as settings, or the current manifest from an agent that keeps none", async () => {
    const t = await makeApi();
    seed(t);
    const fromRelease = (await t.request("/v1/apps/shop/config", { token: t.tokens.viewer })).json;
    expect(fromRelease.settings.services.web).toMatchObject({ command: "node server.js", environment: { A: "one" } });
    expect(fromRelease.settings.name).toBeUndefined();

    t.handlers["app.config.get"] = () => ({ manifestText: TEXT.replace("one", "kept") });
    expect((await t.request("/v1/apps/shop/config", { token: t.tokens.viewer })).json.settings.services.web.environment).toEqual({ A: "kept" });
    expect((await t.request("/v1/apps/nope/config", { token: t.tokens.viewer })).status).toBe(404);
  });
});

describe("PUT /v1/apps/:app/config", () => {
  const settings = { services: { web: { command: "node other.js", environment: { A: "two" } } } };
  it("is admin-only, validates, and hands the rendered configuration to the agent after the connections", async () => {
    const t = await makeApi();
    seed(t);
    const put = (token: string, s: unknown = settings) => t.request("/v1/apps/shop/config", { method: "PUT", token, json: { settings: s } });
    expect((await put(t.tokens.deployer)).status).toBe(403);
    expect((await put(t.tokens.admin, { services: {} })).status).toBe(422);
    expect((await put(t.tokens.admin, { services: { web: { command: "x", secrets: ["lower"] } } })).status).toBe(400);
    t.handlers["app.config.set"] = () => ({ deploy: { app: "shop", releaseId: "r2", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true } });
    const r = await put(t.tokens.admin);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ok: true, status: "queued" });
    for (let i = 0; i < 100 && t.registry.deployments.get(r.json.id)?.status !== "success"; i++) await sleepMs(20);
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success", releaseId: "r2" });
    const call = t.calls.find((c) => c.op === "app.config.set")!;
    expect((call.args as { manifestText: string }).manifestText).toMatch(/^name: shop/m);
    expect((call.args as { manifestText: string }).manifestText).toMatch(/node other.js/);
    expect(t.calls.findIndex((c) => c.op === "connections.set")).toBeLessThan(t.calls.findIndex((c) => c.op === "app.config.set"));
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "config.set", app: "shop" });
  });
});

describe("a configuration change in progress", () => {
  it("is reported as pending until the deployment ends", async () => {
    const t = await makeApi();
    seed(t);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.handlers["app.config.set"] = async () => {
      await gate;
      return { deploy: null };
    };
    const settings = { services: { web: { command: "node server.js", port: 3000 }, extra: { command: "node extra.js" } } };
    const r = await t.request("/v1/apps/shop/config", { method: "PUT", token: t.tokens.admin, json: { settings } });
    expect(r.status).toBe(202);
    const during = (await t.request("/v1/apps/shop/config", { token: t.tokens.viewer })).json;
    expect(Object.keys(during.settings.services)).toEqual(["web"]);
    expect(Object.keys(during.pending.services)).toEqual(["web", "extra"]);
    release();
    for (let i = 0; i < 100 && t.registry.deployments.get(r.json.id)?.status !== "success"; i++) await sleepMs(20);
    expect((await t.request("/v1/apps/shop/config", { token: t.tokens.viewer })).json.pending).toBeNull();
  });
});

describe("an app being created", () => {
  it("lists the services it will have while its first deploy is waiting and running, and stops when it ends", async () => {
    const t = await makeApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.handlers["app.deploy"] = async () => {
      await gate;
      return { app: "fresh", releaseId: "r1", previous: null, units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: "2026-11-06T11:00:00.000Z" };
    };
    const manifest = JSON.stringify({ name: "fresh", services: { web: { image: "nginx:1" }, cache: { image: "redis:7" } } });
    const r = await t.request("/v1/apps/fresh/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest } });
    expect(r.status).toBe(202);
    const during = (await t.request("/v1/apps/fresh/config", { token: t.tokens.viewer })).json;
    expect(during.settings).toBeNull();
    expect(Object.keys(during.pending.services)).toEqual(["web", "cache"]);
    release();
    await t.api.jobs.idle();
    expect((await t.request("/v1/apps/fresh/config", { token: t.tokens.viewer })).json.pending).toBeNull();
  });
});

describe("volumes", () => {
  it("lists what the agent reports, and takes an SMB password from admins only, never logging it", async () => {
    const t = await makeApi();
    seed(t);
    t.handlers["volumes.status"] = () => ({ volumes: { media: { type: "smb", state: "mounted", password: true } } });
    expect((await t.request("/v1/apps/shop/volumes", { token: t.tokens.viewer })).json).toEqual({ volumes: { media: { type: "smb", state: "mounted", password: true } } });
    expect((await t.request("/v1/apps/nope/volumes", { token: t.tokens.viewer })).status).toBe(404);

    const put = (token: string, body: unknown = { password: "s3cret-pw" }) => t.request("/v1/apps/shop/volumes/media/password", { method: "PUT", token, json: body });
    expect((await put(t.tokens.deployer)).status).toBe(403);
    expect((await put(t.tokens.admin, { password: "" })).status).toBe(400);
    expect((await put(t.tokens.admin)).status).toBe(200);
    expect(t.calls.at(-1)).toEqual({ op: "volumes.password.set", args: { app: "shop", name: "media", password: "s3cret-pw" } });
    expect(JSON.stringify(t.registry.audit.list())).not.toContain("s3cret-pw");
  });
});

describe("variables that point at volumes", () => {
  it("resolve to the path the service sees", async () => {
    const t = await makeApi();
    t.registry.apps.upsert({ name: "shop", server: "local", manifestText: "name: shop\nservices:\n  web:\n    command: x\n    volumes:\n      up: /data/up\n    environment:\n      A: \"@volume:up.path\"\n      B: \"@volume:shared.path\"\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    const vars = (await t.request("/v1/apps/shop/variables", { token: t.tokens.viewer })).json.variables;
    const by = Object.fromEntries(vars.map((v: { key: string }) => [v.key, v]));
    expect(by.A.resolved).toBe("/data/up");
    expect(by.B.resolved).toBe("/srv/apps/shop/shared");
  });
});
