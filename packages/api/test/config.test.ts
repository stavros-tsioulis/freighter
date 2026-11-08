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

  it("returns the agent settings of the local server, and changes them through the agent with an audit entry", async () => {
    const t = await makeApi();
    withSettings(t);
    const get = await t.request("/v1/servers/local/config", { token: t.tokens.admin });
    expect(get.json.fields.map((f: { key: string }) => f.key)).toEqual(["drainSeconds"]);
    const put = await t.request("/v1/servers/local/config", { method: "PUT", token: t.tokens.admin, json: { changes: { drainSeconds: 9 } } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ changed: ["drainSeconds"], restart: ["agent"], haproxy: "none" });
    expect(t.calls.find((c) => c.op === "config.set")?.args).toEqual({ changes: { drainSeconds: 9 } });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "config.set", detail: { server: "local" } });
  });

  it("keeps control-plane settings off every server's page and refuses to set them there", async () => {
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

describe("a control server without a local agent", () => {
  const without = async () => {
    const t = await makeApi();
    t.registry.servers.setLocal(false);
    return t;
  };
  const enrolled = (t: Api, name: string) => {
    t.registry.servers.create({ name, address: `${name}.example.com` });
    t.registry.servers.setCert(name, "SHA256:x", "2027-01-01T00:00:00.000Z");
  };

  it("sends work to the only enrolled server when none is named, and asks when there are several", async () => {
    const t = await without();
    const none = await t.request("/v1/git/branches", { method: "POST", token: t.tokens.deployer, json: { repository: "git@git.example.com:a/b.git" } });
    expect(none.status).toBe(400);
    expect(none.json.error.message).toMatch(/add one under Servers/);
    enrolled(t, "vps-1");
    expect((await t.request("/v1/git/branches", { method: "POST", token: t.tokens.deployer, json: { repository: "git@git.example.com:a/b.git" } })).status).toBe(200);
    expect(t.remote("vps-1").calls.some((c) => c.op === "git.branches")).toBe(true);
    enrolled(t, "vps-2");
    const many = await t.request("/v1/git/branches", { method: "POST", token: t.tokens.deployer, json: { repository: "git@git.example.com:a/b.git" } });
    expect(many.status).toBe(400);
    expect(many.json.error.message).toMatch(/choose a server/);
  });

  it("validates SSH keys on an online server instead of the missing local one", async () => {
    const t = await without();
    const key = { name: "work", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----" };
    expect((await t.request("/v1/ssh-keys", { method: "POST", token: t.tokens.admin, json: key })).status).toBe(409);
    enrolled(t, "vps-1");
    t.registry.servers.markSeen("vps-1", {});
    const ok = await t.request("/v1/ssh-keys", { method: "POST", token: t.tokens.admin, json: key });
    expect(ok.status).toBe(201);
    expect(t.remote("vps-1").calls.some((c) => c.op === "ssh.import")).toBe(true);
  });

  it("has no local settings to edit", async () => {
    const t = await without();
    expect((await t.request("/v1/servers/local/config", { token: t.tokens.admin })).status).toBe(404);
  });
});


describe("control server settings (no agent involved)", () => {
  const get = async (t: Api) => (await t.request("/v1/settings", { token: t.tokens.admin })).json.fields as { key: string; value: unknown; source: string; envVar?: string }[];
  const byKey = (fields: Awaited<ReturnType<typeof get>>, key: string) => fields.find((f) => f.key === key)!;

  it("is admin-only", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/settings", { token: t.tokens.deployer })).status).toBe(403);
    expect((await t.request("/v1/settings", { method: "PUT", token: t.tokens.deployer, json: { changes: {} } })).status).toBe(403);
  });

  it("lists the control settings with defaults, and saves changes that apply at once", async () => {
    const t = await makeApi();
    const before = await get(t);
    expect(before.every((f) => f.key.startsWith("api."))).toBe(true);
    expect(byKey(before, "api.dnsServers")).toMatchObject({ value: ["1.1.1.1", "8.8.8.8"], source: "default" });
    const put = await t.request("/v1/settings", { method: "PUT", token: t.tokens.admin, json: { changes: { "api.dnsServers": [], "api.maxUploadMb": 5, "api.publicUrl": "https://fr.example.com" } } });
    expect(put.status).toBe(200);
    expect(put.json.changed.sort()).toEqual(["api.dnsServers", "api.maxUploadMb", "api.publicUrl"]);
    const after = await get(t);
    expect(byKey(after, "api.dnsServers")).toMatchObject({ value: [], source: "dashboard" });
    expect(byKey(after, "api.publicUrl")).toMatchObject({ value: "https://fr.example.com", source: "dashboard" });
    expect(t.ctx.maxUploadBytes).toBe(5 * 1024 * 1024);
    expect(t.ctx.publicUrl).toBe("https://fr.example.com");
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "settings.set" });
    // null forgets the saved value
    await t.request("/v1/settings", { method: "PUT", token: t.tokens.admin, json: { changes: { "api.dnsServers": null } } });
    expect(byKey(await get(t), "api.dnsServers")).toMatchObject({ value: ["1.1.1.1", "8.8.8.8"], source: "default" });
  });

  it("rejects invalid values, agent settings and unknown keys, and saves nothing", async () => {
    const t = await makeApi();
    const put = (changes: unknown) => t.request("/v1/settings", { method: "PUT", token: t.tokens.admin, json: { changes } });
    expect((await put({ "api.dnsServers": ["not-an-ip"] })).status).toBe(400);
    expect((await put({ "api.publicUrl": "nope" })).status).toBe(400);
    expect((await put({ "api.maxUploadMb": 0 })).status).toBe(400);
    expect((await put({ drainSeconds: 3 })).status).toBe(400);
    expect((await put({ "api.nothing": 1 })).status).toBe(400);
    expect(t.registry.settings.all()).toEqual({});
  });
});
