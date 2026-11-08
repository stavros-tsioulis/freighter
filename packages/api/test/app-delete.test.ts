import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof makeApi>>;

function seed(t: Api, name = "shop", status: "deployed" | "missing" = "deployed") {
  t.registry.apps.upsert({ name, server: "local", manifestText: "name: shop\n", currentRelease: "r1", previousRelease: null, status });
  t.registry.pendingDomains.create({ hostname: `${name}.example.com`, app: name, service: "web", tls: "auto" });
  const d = t.registry.deployments.create({ app: name, action: "deploy" });
  t.registry.deployments.update(d.id, { status: "success" });
  return d.id;
}
const del = (t: Api, name: string, json: unknown, token = t.tokens.admin) => t.request(`/v1/apps/${name}`, { method: "DELETE", token, json });

describe("DELETE /v1/apps/:app", () => {
  it("removes the app from its server, then from the registry, and audits it", async () => {
    const t = await makeApi();
    const id = seed(t);
    t.handlers["app.delete"] = (a: { app: string }) => ({ app: a.app, units: ["freighter-shop--web--r1.service"], hostnames: ["shop.example.com"] });
    const r = await del(t, "shop", { confirm: "shop" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, app: "shop", units: ["freighter-shop--web--r1.service"], hostnames: ["shop.example.com"], forgotten: false });
    expect(t.calls.find((c) => c.op === "app.delete")?.args).toEqual({ app: "shop" });
    expect(t.registry.apps.get("shop")).toBeUndefined();
    expect(t.registry.deployments.get(id)).toBeUndefined();
    expect(t.registry.pendingDomains.list("shop")).toEqual([]);
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "app.delete", app: "shop", detail: { server: "local", units: 1, hostnames: ["shop.example.com"] } });
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).status).toBe(404);
  });

  it("makes you type the app's name, and only admins may delete", async () => {
    const t = await makeApi();
    seed(t);
    t.handlers["app.delete"] = () => ({ app: "shop", units: [], hostnames: [] });
    expect((await del(t, "shop", {})).status).toBe(400);
    const wrong = await del(t, "shop", { confirm: "blog" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toMatch(/send its name as "confirm"/);
    expect((await del(t, "shop", { confirm: "shop" }, t.tokens.deployer)).status).toBe(403);
    expect((await del(t, "shop", { confirm: "shop" }, t.tokens.viewer)).status).toBe(403);
    expect(t.calls.some((c) => c.op === "app.delete")).toBe(false);
    expect(t.registry.apps.get("shop")).toBeDefined();
    expect((await del(t, "ghost", { confirm: "ghost" })).status).toBe(404);
  });

  it("won't delete while a deployment is queued or running", async () => {
    const t = await makeApi();
    seed(t);
    t.registry.deployments.create({ app: "shop", action: "deploy" }); // queued
    const r = await del(t, "shop", { confirm: "shop" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/deployment in progress/);
    expect(t.registry.apps.get("shop")).toBeDefined();
  });

  it("keeps the app when the server can't remove it, so nothing is forgotten that still runs", async () => {
    const t = await makeApi();
    seed(t);
    t.handlers["app.delete"] = () => {
      throw new t.AgentError("unavailable", "cannot reach agent");
    };
    expect((await del(t, "shop", { confirm: "shop" })).status).toBeGreaterThanOrEqual(500);
    expect(t.registry.apps.get("shop")).toBeDefined();
  });

  it("tidies up when the server no longer has the app, when it reports it missing, and when asked to forget", async () => {
    const t = await makeApi();
    seed(t);
    t.handlers["app.delete"] = () => {
      throw new t.AgentError("not_found", 'unknown app "shop"');
    };
    expect((await del(t, "shop", { confirm: "shop" })).json).toMatchObject({ ok: true, forgotten: true });
    expect(t.registry.apps.get("shop")).toBeUndefined();

    seed(t, "blog", "missing");
    const before = t.calls.length;
    expect((await del(t, "blog", { confirm: "blog" })).json.forgotten).toBe(true);
    expect(t.calls.length).toBe(before); // the server wasn't asked
    expect(t.registry.apps.get("blog")).toBeUndefined();

    seed(t, "docs");
    t.handlers["app.delete"] = () => {
      throw new t.AgentError("unavailable", "down");
    };
    expect((await del(t, "docs", { confirm: "docs", forget: true })).status).toBe(200);
    expect(t.registry.apps.get("docs")).toBeUndefined();
  });
});
