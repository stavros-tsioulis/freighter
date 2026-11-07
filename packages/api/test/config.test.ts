import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof makeApi>>;

const field = (key: string, scope: "agent" | "control", extra = {}) =>
  ({ key, section: "S", label: key, help: "", type: "number", scope, restart: "agent", value: 1, default: 1, explicit: false, ...extra });

function withSettings(t: Api, server = "local") {
  const h = server === "local" ? t.handlers : t.remote(server).handlers;
  h["config.get"] = () => ({ fields: [field("drainSeconds", "agent"), field("api.maxUploadMb", "control")] });
  h["config.set"] = (a: { changes: Record<string, unknown> }) => ({ changed: Object.keys(a.changes), restart: ["agent"], haproxy: "none" });
}

describe("server settings", () => {
  it("is admin-only", async () => {
    const t = await makeApi();
    withSettings(t);
    expect((await t.request("/v1/servers/local/config", { token: t.tokens.deployer })).status).toBe(403);
    expect((await t.request("/v1/servers/local/config", { method: "PUT", token: t.tokens.deployer, json: { changes: {} } })).status).toBe(403);
    expect((await t.request("/v1/servers/local/restart", { method: "POST", token: t.tokens.deployer, json: { service: "agent" } })).status).toBe(403);
  });

  it("returns every setting for the local server, and changes them through the agent with an audit entry", async () => {
    const t = await makeApi();
    withSettings(t);
    const get = await t.request("/v1/servers/local/config", { token: t.tokens.admin });
    expect(get.json.fields.map((f: { key: string }) => f.key)).toEqual(["drainSeconds", "api.maxUploadMb"]);
    const put = await t.request("/v1/servers/local/config", { method: "PUT", token: t.tokens.admin, json: { changes: { drainSeconds: 9, "api.maxUploadMb": null } } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ changed: ["drainSeconds", "api.maxUploadMb"], restart: ["agent"], haproxy: "none" });
    expect(t.calls.find((c) => c.op === "config.set")?.args).toEqual({ changes: { drainSeconds: 9, "api.maxUploadMb": null } });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "config.set", detail: { server: "local" } });
  });

  it("hides control-plane settings on a remote server and refuses to set them there", async () => {
    const t = await makeApi();
    t.registry.servers.create({ name: "vps-1", address: "vps1.example.com:7443" });
    withSettings(t, "vps-1");
    const get = await t.request("/v1/servers/vps-1/config", { token: t.tokens.admin });
    expect(get.json.fields.map((f: { key: string }) => f.key)).toEqual(["drainSeconds"]);
    const bad = await t.request("/v1/servers/vps-1/config", { method: "PUT", token: t.tokens.admin, json: { changes: { "api.maxUploadMb": 5 } } });
    expect(bad.status).toBe(400);
    expect(t.remote("vps-1").calls.some((c) => c.op === "config.set")).toBe(false);
  });

  it("rejects values of the wrong shape, unknown servers and the API restart on a remote", async () => {
    const t = await makeApi();
    withSettings(t);
    t.registry.servers.create({ name: "vps-1", address: "vps1.example.com:7443" });
    expect((await t.request("/v1/servers/local/config", { method: "PUT", token: t.tokens.admin, json: { changes: { drainSeconds: { x: 1 } } } })).status).toBe(400);
    expect((await t.request("/v1/servers/nope/config", { token: t.tokens.admin })).status).toBe(404);
    t.handlers["service.restart"] = () => ({});
    expect((await t.request("/v1/servers/local/restart", { method: "POST", token: t.tokens.admin, json: { service: "api" } })).status).toBe(200);
    expect((await t.request("/v1/servers/vps-1/restart", { method: "POST", token: t.tokens.admin, json: { service: "api" } })).status).toBe(400);
  });
});
