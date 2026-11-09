import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

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
    expect(r.json).toMatchObject({ ok: true, redeployed: true });
    const call = t.calls.find((c) => c.op === "app.config.set")!;
    expect((call.args as { manifestText: string }).manifestText).toMatch(/^name: shop/m);
    expect((call.args as { manifestText: string }).manifestText).toMatch(/node other.js/);
    expect(t.calls.findIndex((c) => c.op === "connections.set")).toBeLessThan(t.calls.findIndex((c) => c.op === "app.config.set"));
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "config.set", app: "shop" });
  });
});
