import { X509Certificate } from "node:crypto";
import { AgentError } from "@freighter/protocol";
import { createCsr, fingerprint } from "@freighter/pki";
import { describe, expect, it } from "vitest";
import { sampleOnce } from "../src/index.ts";
import { APP_YAML, makeApi } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof makeApi>>;

async function addServer(t: Api, name = "vps-1", address = "vps1.example.com:7443") {
  return t.request("/v1/servers", { method: "POST", token: t.tokens.admin, json: { name, address }, headers: { host: "freighter.example.com", "x-forwarded-proto": "https" } });
}
const enroll = async (t: Api, token: string, csr?: string, ip?: string) =>
  t.request("/v1/enroll", { method: "POST", json: { token, csr: csr ?? (await createCsr("agent")).csrPem }, ip });

describe("server management", () => {
  it("lists the local server and enforces roles", async () => {
    const t = await makeApi();
    const list = await t.request("/v1/servers", { token: t.tokens.viewer });
    expect(list.json.servers.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([["local", "local"]]);
    expect((await t.request("/v1/servers", { method: "POST", token: t.tokens.deployer, json: { name: "x", address: "a.example.com" } })).status).toBe(403);
    expect((await t.request("/v1/servers")).status).toBe(401);
  });

  it("adds a server and returns a one-time enrollment command with the CA fingerprint", async () => {
    const t = await makeApi();
    const r = await addServer(t);
    expect(r.status).toBe(201);
    const ca = await t.pki.ensureCa();
    expect(r.json.server).toMatchObject({ name: "vps-1", kind: "remote", status: "pending", enrollmentPending: true });
    expect(r.json.enrollment.caFingerprint).toBe(fingerprint(ca.certPem));
    expect(r.json.enrollment.token).toMatch(/^fre_/);
    expect(r.json.enrollment.command).toBe(
      `freighter-agent enroll --control https://freighter.example.com --token ${r.json.enrollment.token} --ca-fingerprint ${fingerprint(ca.certPem)}`,
    );
    // the token is not retrievable later
    const again = await t.request("/v1/servers/vps-1", { token: t.tokens.viewer });
    expect(JSON.stringify(again.json)).not.toContain(r.json.enrollment.token);
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.add", detail: { server: "vps-1" } });
  });

  it("validates names and addresses", async () => {
    const t = await makeApi();
    expect((await addServer(t, "local", "a.example.com")).status).toBe(400);
    expect((await addServer(t, "Bad Name", "a.example.com")).status).toBe(400);
    expect((await addServer(t, "ok", "http://a.example.com")).status).toBe(400);
    expect((await addServer(t, "ok", "a.example.com:99999")).status).toBe(400);
    expect((await addServer(t, "dup", "a.example.com")).status).toBe(201);
    expect((await addServer(t, "dup", "b.example.com")).status).toBe(409);
  });

  it("removes only empty remote servers", async () => {
    const t = await makeApi();
    await addServer(t);
    t.registry.apps.ensure("blog", "vps-1");
    expect((await t.request("/v1/servers/vps-1", { method: "DELETE", token: t.tokens.admin })).status).toBe(409);
    expect((await t.request("/v1/servers/local", { method: "DELETE", token: t.tokens.admin })).status).toBe(400);
    expect((await t.request("/v1/servers/ghost", { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
    await addServer(t, "empty", "e.example.com");
    expect((await t.request("/v1/servers/empty", { method: "DELETE", token: t.tokens.admin })).json).toEqual({ ok: true });
    expect(t.registry.servers.get("empty")).toBeUndefined();
  });
});

describe("enrollment", () => {
  it("signs a certificate for the registered address, ignoring what the CSR asks for", async () => {
    const t = await makeApi();
    const token = (await addServer(t)).json.enrollment.token as string;
    const csr = (await createCsr("i-claim-to-be-the-control-plane")).csrPem;
    const r = await enroll(t, token, csr);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "vps-1", port: 7443 });

    const cert = new X509Certificate(r.json.serverCert);
    expect(cert.subject).toContain("CN=vps-1");
    expect(cert.subjectAltName).toBe("DNS:vps1.example.com");
    expect(cert.verify(new X509Certificate((await t.pki.ensureCa()).certPem).publicKey)).toBe(true); // signed by our CA
    expect(r.json.caCert).toBe((await t.pki.ensureCa()).certPem);
    expect(t.registry.servers.get("vps-1")).toMatchObject({ status: "offline", certFingerprint: fingerprint(r.json.serverCert), enrollmentPending: false });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.enrolled" });
  });

  it("puts an IP address into the certificate as an IP SAN", async () => {
    const t = await makeApi();
    const token = (await addServer(t, "ip-box", "10.1.2.3:7555")).json.enrollment.token as string;
    const r = await enroll(t, token);
    expect(r.json.port).toBe(7555);
    expect(new X509Certificate(r.json.serverCert).subjectAltName).toBe("IP Address:10.1.2.3");
  });

  it("tokens are single-use, expire, and a bad CSR does not burn the token", async () => {
    const t = await makeApi();
    const token = (await addServer(t)).json.enrollment.token as string;
    const bad = await enroll(t, token, "-----BEGIN CERTIFICATE REQUEST-----\n" + "A".repeat(80) + "\n-----END CERTIFICATE REQUEST-----");
    expect(bad.status).toBe(400);
    expect((await enroll(t, token)).status).toBe(200); // still valid after the malformed attempt
    const reused = await enroll(t, token);
    expect(reused.status).toBe(401);
    expect(reused.json.error.message).toMatch(/invalid or expired/);

    const stale = t.registry.servers.newEnrollment("vps-1", -1000);
    expect((await enroll(t, stale)).status).toBe(401);
    expect((await enroll(t, "fre_totally-unknown-token")).status).toBe(401);
  });

  it("rate-limits repeated bad tokens", async () => {
    const t = await makeApi();
    for (let i = 0; i < 10; i++) expect((await enroll(t, `fre_bad-token-${i}`, undefined, "6.6.6.6")).status).toBe(401);
    expect((await enroll(t, "fre_bad-token-x", undefined, "6.6.6.6")).status).toBe(429);
  });

  it("re-enrollment issues a fresh token for an existing server", async () => {
    const t = await makeApi();
    const first = (await addServer(t)).json.enrollment.token as string;
    await enroll(t, first);
    const again = await t.request("/v1/servers/vps-1/enrollment", { method: "POST", token: t.tokens.admin, json: {} });
    expect(again.json.enrollment.token).not.toBe(first);
    expect((await enroll(t, again.json.enrollment.token)).status).toBe(200);
    expect((await t.request("/v1/servers/local/enrollment", { method: "POST", token: t.tokens.admin, json: {} })).status).toBe(400);
  });
});

describe("multi-server routing", () => {
  async function enrolled(t: Api, name = "vps-1") {
    await addServer(t, name);
    t.registry.servers.setCert(name, "SHA256:AA", "2027-01-01T00:00:00.000Z");
  }
  const upload = (t: Api, query = "") => async () =>
    t.request(`/v1/apps/shop/deployments${query}`, { method: "POST", token: t.tokens.deployer, body: await t.tarball() });

  it("refuses to deploy to a server that has not enrolled", async () => {
    const t = await makeApi();
    await addServer(t);
    const r = await upload(t, "?server=vps-1")();
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("server_not_enrolled");
    expect((await upload(t, "?server=ghost")()).status).toBe(404);
  });

  it("deploys to a remote server by uploading the artifact, then pins the app there", async () => {
    const t = await makeApi();
    await enrolled(t);
    const r = await upload(t, "?server=vps-1")();
    expect(r.status).toBe(202);
    await t.api.jobs.idle();

    const remote = t.remote("vps-1");
    const put = remote.calls.find((c) => c.op === "putArtifact")!;
    const deploy = remote.calls.find((c) => c.op === "app.deploy")!;
    expect((deploy.args as { artifact: string }).artifact).toBe(`/remote-spool/${r.json.id}.tar.gz`);
    expect((put.args as { id: string }).id).toBe(r.json.id);
    expect(remote.calls.some((c) => c.op === "artifact.delete")).toBe(true); // remote spool cleaned up
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false); // nothing went to the local agent

    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success", server: "vps-1" });
    expect(t.registry.apps.get("shop")?.server).toBe("vps-1");
    expect(t.spoolFiles()).toEqual([]);

    // later deploys default to the pinned server, and naming another one is refused
    expect((await upload(t)()).status).toBe(202);
    const moved = await upload(t, "?server=local")();
    expect(moved.status).toBe(409);
    expect(moved.json.error.code).toBe("pinned_to_other_server");
    await t.api.jobs.idle();
  });

  it("local deploys keep the path-based flow", async () => {
    const t = await makeApi();
    const r = await upload(t)();
    await t.api.jobs.idle();
    expect(t.calls.some((c) => c.op === "putArtifact")).toBe(false);
    expect((t.calls.find((c) => c.op === "app.deploy")!.args as { artifact: string }).artifact).toBe(`${t.ctx.artifactsDir}/${r.json.id}.tar.gz`);
  });

  it("routes app operations to the server the app is pinned to", async () => {
    const t = await makeApi();
    await enrolled(t);
    t.registry.apps.ensure("shop", "vps-1");
    const remote = t.remote("vps-1");
    expect((await t.request("/v1/apps/shop/restart", { method: "POST", token: t.tokens.deployer, json: {} })).status).toBe(200);
    expect((await t.request("/v1/apps/shop/logs?service=web", { token: t.tokens.deployer })).status).toBe(200);
    expect((await t.request("/v1/apps/shop/services/web/env/TOKEN", { method: "PUT", token: t.tokens.admin, json: { value: "x" } })).status).toBe(200);
    expect((await t.request("/v1/apps/shop/rollback", { method: "POST", token: t.tokens.deployer, json: {} })).status).toBe(202);
    await t.api.jobs.idle();
    expect(remote.calls.map((c) => c.op)).toEqual(expect.arrayContaining(["app.control", "app.logs", "env.set", "app.rollback"]));
    expect(t.calls.filter((c) => ["app.control", "app.logs", "env.set", "app.rollback"].includes(c.op))).toEqual([]);
    expect(t.registry.deployments.list({ app: "shop" })[0]).toMatchObject({ action: "rollback", server: "vps-1" });
  });

  it("reports an unreachable server as 503 for its apps", async () => {
    const t = await makeApi();
    await enrolled(t);
    t.registry.apps.ensure("shop", "vps-1");
    t.remote("vps-1").handlers["app.control"] = () => {
      throw new AgentError("unavailable", "cannot reach agent at vps1.example.com:7443: ECONNREFUSED");
    };
    const r = await t.request("/v1/apps/shop/restart", { method: "POST", token: t.tokens.deployer, json: {} });
    expect(r.status).toBe(503);
    expect(r.json.error.message).toMatch(/ECONNREFUSED/);
  });
});

describe("sync, health and metrics across servers", () => {
  async function two(t: Api) {
    await addServer(t);
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    t.remote("vps-1").handlers["apps.list"] = () => ({ apps: ["blog"] });
    t.remote("vps-1").handlers["app.info"] = () => ({ app: "blog", release: "r9", previous: null, manifestText: "name: blog\n", services: {}, releases: [] });
  }

  it("syncs every server, recording health and pinning each app to its server", async () => {
    const t = await makeApi();
    await two(t);
    const s = await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(s.json).toEqual({ apps: 2, errors: {}, servers: { local: "online", "vps-1": "online" } });
    expect(t.registry.apps.get("shop")?.server).toBe("local");
    expect(t.registry.apps.get("blog")?.server).toBe("vps-1");
    expect(t.registry.servers.get("vps-1")).toMatchObject({ status: "online", agentVersion: "0.0.0", hostname: "box", host: { memFree: 500 } });
    expect((await t.request("/v1/apps/blog", { token: t.tokens.viewer })).json.server).toBe("vps-1");
  });

  it("an offline server does not block the others and is marked offline", async () => {
    const t = await makeApi();
    await two(t);
    t.remote("vps-1").handlers.ping = () => {
      throw new AgentError("unavailable", "cannot reach agent at vps1.example.com:7443: ETIMEDOUT");
    };
    const s = await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(s.json.servers).toEqual({ local: "online", "vps-1": "offline" });
    expect(s.json.errors["vps-1"]).toMatch(/ETIMEDOUT/);
    expect(t.registry.apps.get("shop")?.status).toBe("deployed"); // local still synced
    expect(t.registry.servers.get("vps-1")).toMatchObject({ status: "offline", lastError: expect.stringMatching(/ETIMEDOUT/) });
    t.remote("vps-1").handlers.ping = () => ({ version: "0.0.0", time: "t" });
    const check = await t.request("/v1/servers/vps-1/check", { method: "POST", token: t.tokens.admin, json: {} });
    expect(check.json.status).toBe("online"); // recovers
  });

  it("keeps the first server when two report the same app name", async () => {
    const t = await makeApi();
    await two(t);
    t.remote("vps-1").handlers["apps.list"] = () => ({ apps: ["shop"] });
    const s = await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(s.json.errors.shop).toMatch(/exists on servers "local" and "vps-1"; keeping "local"/);
    expect(t.registry.apps.get("shop")?.server).toBe("local");
  });

  it("does not talk to servers that are still pending", async () => {
    const t = await makeApi();
    await addServer(t);
    const s = await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(s.json.servers).toEqual({ local: "online" });
    expect(t.remote("vps-1").calls).toEqual([]);
  });

  it("aggregates certificates across servers", async () => {
    const t = await makeApi();
    await two(t);
    t.remote("vps-1").handlers["certs.status"] = () => ({ certs: [{ hostname: "blog.example.com", expires: null }] });
    const r = await t.request("/v1/certs", { token: t.tokens.viewer });
    expect(r.json.certs).toEqual([
      { server: "local", hostname: "shop.example.com", expires: null },
      { server: "vps-1", hostname: "blog.example.com", expires: null },
    ]);
    expect((await t.request("/v1/certs?server=vps-1", { token: t.tokens.viewer })).json.certs).toHaveLength(1);
  });

  it("samples metrics from every reachable server and tolerates a failing one", async () => {
    const t = await makeApi();
    await two(t);
    t.remote("vps-1").handlers["metrics.snapshot"] = () => ({
      samples: [{ app: "blog", service: "web", unit: "u", activeState: "active", memoryBytes: 5, cpuNanos: 5, restarts: 0 }],
    });
    expect(await sampleOnce(t.ctx)).toBe(2);
    t.remote("vps-1").handlers["metrics.snapshot"] = () => {
      throw new AgentError("unavailable", "down");
    };
    expect(await sampleOnce(t.ctx)).toBe(1);
    expect(t.registry.metrics.series("blog", "").length).toBe(1);
    expect(APP_YAML).toBeTruthy();
  });
});

describe("upgrading a remote server", () => {
  const status = (over: Record<string, unknown> = {}) => ({ supported: true, reason: null, commit: "aaaaaaaaaaaa", upgrade: null, log: "", ...over });

  async function online(t: Api) {
    await addServer(t);
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    t.ctx.version = "bbbbbbbbbbbb";
    expect((await t.request("/v1/servers/vps-1/check", { method: "POST", token: t.tokens.admin, json: {} })).json.status).toBe("online");
    return t.remote("vps-1");
  }
  const upgrade = (t: Api, json: unknown = {}, name = "vps-1") => t.request(`/v1/servers/${name}/upgrade`, { method: "POST", token: t.tokens.admin, json });

  it("tells the dashboard which version the control plane runs, and whether the server is behind", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    expect((await t.request("/v1/version", { token: t.tokens.viewer })).json).toEqual({ commit: "bbbbbbbbbbbb" });
    const v = await t.request("/v1/servers/vps-1/upgrade", { token: t.tokens.admin });
    expect(v.json).toMatchObject({ supported: true, commit: "aaaaaaaaaaaa", target: "bbbbbbbbbbbb", outdated: true });
    agent.handlers["upgrade.status"] = () => status({ commit: "bbbbbbbbbbbb" });
    expect((await t.request("/v1/servers/vps-1/upgrade", { token: t.tokens.admin })).json.outdated).toBe(false);
    expect((await t.request("/v1/servers/vps-1/upgrade", { token: t.tokens.deployer })).status).toBe(403);
  });

  it("starts an upgrade to the control plane's own commit, and audits it", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers["upgrade.start"] = () => ({ started: true });
    const r = await upgrade(t);
    expect(r.status).toBe(202);
    expect(agent.calls.find((c) => c.op === "upgrade.start")?.args).toEqual({ ref: "bbbbbbbbbbbb" });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.upgrade", detail: { server: "vps-1", ref: "bbbbbbbbbbbb", from: "aaaaaaaaaaaa" } });
    // what the server is told to fetch is the full commit: git can't fetch the 12-character one shown in the dashboard
    t.ctx.versionFull = "b".repeat(12) + "c".repeat(28);
    await upgrade(t);
    expect(agent.calls.filter((c) => c.op === "upgrade.start").at(-1)?.args).toEqual({ ref: "b".repeat(12) + "c".repeat(28) });
    await upgrade(t, { ref: "v1.2.0" });
    expect(agent.calls.filter((c) => c.op === "upgrade.start").at(-1)?.args).toEqual({ ref: "v1.2.0" });
  });

  it("adds container support without moving the server to another version", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images", "containers.install"] });
    agent.handlers["upgrade.start"] = () => ({ started: true });
    const r = await upgrade(t, { containers: true, ref: "ignored" });
    expect(r.status).toBe(202);
    expect(agent.calls.find((c) => c.op === "upgrade.start")?.args).toEqual({ withContainers: true });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.add-containers", detail: { server: "vps-1", from: "aaaaaaaaaaaa" } });
  });

  it("won't add container support through an agent that would upgrade instead, or to the local server", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images"] });
    agent.handlers["upgrade.start"] = () => ({ started: true });
    const old = await upgrade(t, { containers: true });
    expect(old.status).toBe(409);
    expect(old.json.error.message).toMatch(/predates container support/);
    expect(agent.calls.some((c) => c.op === "upgrade.start")).toBe(false);
    const local = await upgrade(t, { containers: true }, "local");
    expect(local.status).toBe(400);
    expect(local.json.error.message).toMatch(/--with-containers/);
  });

  it("adds storage support the same way, and refuses an agent or server that can't", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers["upgrade.start"] = () => ({ started: true });
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images"] });
    const old = await upgrade(t, { storage: true });
    expect(old.status).toBe(409);
    expect(old.json.error.message).toMatch(/predates storage support/);
    expect(agent.calls.some((c) => c.op === "upgrade.start")).toBe(false);
    expect((await upgrade(t, { storage: true }, "local")).json.error.message).toMatch(/--with-storage/);

    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images", "storage.install"] });
    const r = await upgrade(t, { storage: true, ref: "ignored" });
    expect(r.status).toBe(202);
    expect(agent.calls.find((c) => c.op === "upgrade.start")?.args).toEqual({ withStorage: true });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.add-storage", detail: { server: "vps-1" } });
  });

  it("adds archive support (7z and unzip) the same way", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers["upgrade.start"] = () => ({ started: true });
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images"] });
    expect((await upgrade(t, { archives: true })).json.error.message).toMatch(/predates archive support/);
    expect((await upgrade(t, { archives: true }, "local")).json.error.message).toMatch(/--with-archives/);
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images", "archives.install"] });
    expect((await upgrade(t, { archives: true })).status).toBe(202);
    expect(agent.calls.find((c) => c.op === "upgrade.start")?.args).toEqual({ withArchives: true });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.add-archives" });
  });

  it("adds mount support for SMB and NFS volumes the same way", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers["upgrade.start"] = () => ({ started: true });
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images"] });
    const old = await upgrade(t, { mounts: true });
    expect(old.status).toBe(409);
    expect(old.json.error.message).toMatch(/predates volume support/);
    expect((await upgrade(t, { mounts: true }, "local")).json.error.message).toMatch(/--with-mounts/);
    agent.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images", "mounts.install"] });
    expect((await upgrade(t, { mounts: true })).status).toBe(202);
    expect(agent.calls.find((c) => c.op === "upgrade.start")?.args).toEqual({ withMounts: true });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "server.add-mounts" });
  });

  it("refuses what can't work, with the reason", async () => {
    const t = await makeApi();
    expect((await upgrade(t, {}, "local")).status).toBe(400);
    expect((await upgrade(t, {}, "ghost")).status).toBe(404);
    await addServer(t);
    expect((await upgrade(t)).json.error.message).toMatch(/pending/); // not enrolled yet
    const agent = await online(t);
    expect((await upgrade(t, { ref: "--upload-pack=sh" })).status).toBe(400);
    agent.handlers["upgrade.status"] = () => status();
    agent.handlers["upgrade.start"] = () => {
      throw new AgentError("conflict", "an upgrade is already in progress");
    };
    expect((await upgrade(t)).status).toBe(409);
    t.ctx.version = null;
    expect((await upgrade(t)).json.error.message).toMatch(/pass a ref/);
  });

  it("explains agents that predate remote upgrades", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.status"] = () => {
      throw new AgentError("bad_request", 'unknown operation "upgrade.status"');
    };
    const v = await t.request("/v1/servers/vps-1/upgrade", { token: t.tokens.admin });
    expect(v.json).toMatchObject({ supported: false, outdated: true });
    expect(v.json.reason).toMatch(/predates remote upgrades.*installer/);
    const r = await upgrade(t);
    expect(r.status).toBe(409);
    expect(agent.calls.some((c) => c.op === "upgrade.start")).toBe(false);
  });

  it("confirms an agent that answers while it waits for the control plane, so it doesn't roll back", async () => {
    const t = await makeApi();
    const agent = await online(t);
    let confirmed = 0;
    agent.handlers.ping = () => ({ version: "bbbbbbbbbbbb", time: "t", upgrade: "verifying" });
    agent.handlers["upgrade.confirm"] = () => (++confirmed, { confirmed: true });
    const check = await t.request("/v1/servers/vps-1/check", { method: "POST", token: t.tokens.admin, json: {} });
    expect(check.json).toMatchObject({ status: "online", agentVersion: "bbbbbbbbbbbb" });
    expect(confirmed).toBe(1);
    agent.handlers.ping = () => ({ version: "bbbbbbbbbbbb", time: "t" });
    await t.request("/v1/servers/vps-1/check", { method: "POST", token: t.tokens.admin, json: {} });
    expect(confirmed).toBe(1); // only while it is waiting
  });
});

describe("checking a server for updates", () => {
  const result = {
    ref: "main",
    installed: { commit: "a".repeat(40), subject: "old", committedAt: "2026-11-01T10:00:00+00:00" },
    latest: { commit: "b".repeat(40), subject: "new", committedAt: "2026-11-05T10:00:00+00:00" },
    state: "behind",
    behind: 3,
    commits: [{ sha: "bbbbbbb", subject: "new" }],
    checkedAt: "2026-11-06T10:00:00.000Z",
  };
  async function online(t: Api) {
    await addServer(t);
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    t.ctx.version = "cccccccccccc";
    await t.request("/v1/servers/vps-1/check", { method: "POST", token: t.tokens.admin, json: {} });
    return t.remote("vps-1");
  }
  const check = (t: Api, json: unknown = {}, name = "vps-1") => t.request(`/v1/servers/${name}/updates/check`, { method: "POST", token: t.tokens.admin, json });

  it("has the agent ask its own git, and returns the answer next to the control plane's version", async () => {
    const t = await makeApi();
    const agent = await online(t);
    agent.handlers["upgrade.check"] = () => result;
    const r = await check(t, { ref: "release" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: "behind", behind: 3, target: "cccccccccccc" });
    expect(agent.calls.find((c) => c.op === "upgrade.check")?.args).toEqual({ ref: "release" });
    expect((await t.request("/v1/servers/vps-1/updates/check", { method: "POST", token: t.tokens.deployer, json: {} })).status).toBe(403);
  });

  it("explains why it can't: not enrolled, an old agent, a bad ref, no network on the server", async () => {
    const t = await makeApi();
    await addServer(t);
    expect((await check(t)).status).toBe(409); // pending
    expect((await check(t, {}, "ghost")).status).toBe(404);
    const agent = await online(t);
    expect((await check(t, { ref: "--x" })).status).toBe(400);
    agent.handlers["upgrade.check"] = () => {
      throw new AgentError("bad_request", 'unknown operation "upgrade.check"');
    };
    expect((await check(t)).json.error.message).toMatch(/predates remote upgrades/);
    agent.handlers["upgrade.check"] = () => {
      throw new AgentError("bad_request", "could not fetch main from origin: Could not resolve host: github.com");
    };
    const r = await check(t);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Could not resolve host/);
  });
});
