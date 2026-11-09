import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const WEB = `name: web
services:
  web:
    image: ghcr.io/org/web:1
    port: 3000
environment:
  PAY: "@billing/api.url"
  INT: "@billing/api.internal"
  GONE: "@ghost/x.url"
`;
const BILLING = "name: billing\nservices:\n  api:\n    image: ghcr.io/org/billing:1\n";

async function setup() {
  const t = await makeApi();
  const p = (await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "Shop" } })).json;
  t.registry.apps.upsert({ name: "web", server: "local", manifestText: WEB, currentRelease: "r1", previousRelease: null, status: "deployed" });
  t.registry.apps.upsert({ name: "billing", server: "local", manifestText: BILLING, currentRelease: "r1", previousRelease: null, status: "deployed" });
  t.registry.services.replace("web", [{ name: "web", unit: "u", port: 3000, hostnames: [], activeState: "active", subState: "running", restarts: 0, memoryBytes: null }]);
  t.registry.services.replace("billing", [{ name: "api", unit: "u", port: null, hostnames: ["pay.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: null }]);
  for (const a of ["web", "billing"]) t.registry.apps.setProject(a, p.id);
  return { t, p };
}

describe("project graph", () => {
  it("lists services and the connections between them, flagging the ones that can't resolve", async () => {
    const { t, p } = await setup();
    const g = (await t.request(`/v1/projects/${p.id}/graph`, { token: t.tokens.viewer })).json;
    expect(g.apps.map((a: { name: string }) => a.name).sort()).toEqual(["billing", "web"]);
    const edge = (attr: string, key: string) => g.edges.find((e: { attr: string; key: string }) => e.attr === attr && e.key === key);
    expect(edge("url", "PAY")).toMatchObject({ from: { app: "web", service: "web" }, to: { app: "billing", service: "api" }, broken: null });
    expect(edge("internal", "INT").broken).toMatch(/has no port/);
    expect(edge("url", "GONE").broken).toMatch(/not in this project/);
  });

  it("keeps apps without a project on their own canvas", async () => {
    const { t, p } = await setup();
    t.registry.apps.setProject("web", null);
    const none = (await t.request("/v1/projects/none/graph", { token: t.tokens.viewer })).json;
    expect(none.apps.map((a: { name: string }) => a.name)).toEqual(["web"]);
    expect((await t.request("/v1/projects/prj_nope/graph", { token: t.tokens.viewer })).status).toBe(404);
    expect((await t.request(`/v1/projects/${p.id}/graph`, { token: t.tokens.viewer })).json.apps.map((a: { name: string }) => a.name)).toEqual(["billing"]);
  });

  it("saves node positions for deployers, per project, and drops them with the project", async () => {
    const { t, p } = await setup();
    const put = (token: string, positions: unknown) => t.request(`/v1/projects/${p.id}/layout`, { method: "PUT", token, json: { positions } });
    expect((await put(t.tokens.viewer, {})).status).toBe(403);
    expect((await put(t.tokens.deployer, { "web/web": { x: "no", y: 1 } })).status).toBe(400);
    expect((await put(t.tokens.deployer, { "web/web": { x: 10, y: 20 } })).status).toBe(200);
    expect((await t.request(`/v1/projects/${p.id}/graph`, { token: t.tokens.viewer })).json.layout).toEqual({ "web/web": { x: 10, y: 20 } });
    await t.request(`/v1/projects/${p.id}`, { method: "DELETE", token: t.tokens.admin });
    expect(t.registry.layouts.get(p.id)).toEqual({});
  });
});

describe("GET /v1/apps/:app/variables", () => {
  it("lists the plain environment with connections resolved, and says why one can't be", async () => {
    const { t } = await setup();
    t.handlers["domains.get"] = ({ app }: { app: string }) => ({ domains: app === "billing" ? [{ hostname: "pay.example.com", service: "api", tls: "auto" }] : [] });
    const r = await t.request("/v1/apps/web/variables", { token: t.tokens.viewer });
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.json.variables.map((v: { key: string }) => [v.key, v]));
    expect(byKey.PAY).toMatchObject({ value: "@billing/api.url", resolved: "https://pay.example.com", error: null, reference: true });
    expect(byKey.INT.error).toMatch(/has no port/);
    expect(byKey.INT.resolved).toBeNull();
    expect(byKey.PAY.source).toBe("app.yaml");
    expect((await t.request("/v1/apps/nope/variables", { token: t.tokens.viewer })).status).toBe(404);
  });
});

describe("changing variables", () => {
  it("is admin-only, validates the name, tells the agent, and labels added and overridden values", async () => {
    const { t } = await setup();
    const put = (token: string, key = "MODE", value = "x") => t.request(`/v1/apps/web/variables/${key}`, { method: "PUT", token, json: { value } });
    expect((await put(t.tokens.deployer)).status).toBe(403);
    expect((await put(t.tokens.admin, "lower")).status).toBe(400);
    expect((await put(t.tokens.admin)).json).toMatchObject({ ok: true, redeployed: false });
    expect(t.calls.find((c) => c.op === "variables.set")!.args).toMatchObject({ app: "web", set: { MODE: "x" } });
    expect(t.calls.findIndex((c) => c.op === "connections.set")).toBeLessThan(t.calls.findIndex((c) => c.op === "variables.set"));

    // the change re-syncs the app from the (fake) agent, which knows a different manifest
    t.registry.apps.upsert({ name: "web", server: "local", manifestText: WEB, currentRelease: "r1", previousRelease: null, status: "deployed" });
    t.handlers["variables.get"] = () => ({ variables: { PAY: "https://other", NEW: "1" } });
    const vars = (await t.request("/v1/apps/web/variables", { token: t.tokens.viewer })).json.variables;
    const src = Object.fromEntries(vars.map((v: { key: string; source: string }) => [v.key, v.source]));
    expect(src).toMatchObject({ PAY: "override", NEW: "added", INT: "app.yaml" });
    expect((await t.request("/v1/apps/web/variables/NEW", { method: "DELETE", token: t.tokens.admin })).status).toBe(200);
    expect(t.calls.filter((c) => c.op === "variables.set").at(-1)!.args).toMatchObject({ remove: ["NEW"] });
  });
});
