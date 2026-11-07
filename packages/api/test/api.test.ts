import { AgentError } from "@freighter/protocol";
import { describe, expect, it } from "vitest";
import { APP_YAML, makeApi, type Body } from "./helpers.ts";

describe("auth", () => {
  const routes: [string, string, "viewer" | "deployer" | "admin"][] = [
    ["GET", "/v1/apps", "viewer"],
    ["GET", "/v1/apps/shop/releases", "viewer"],
    ["GET", "/v1/apps/shop/deployments", "viewer"],
    ["GET", "/v1/apps/shop/env", "viewer"],
    ["GET", "/v1/apps/shop/domains", "viewer"],
    ["POST", "/v1/apps/shop/domains", "admin"],
    ["POST", "/v1/apps/shop/domains/a.example.com/verify", "admin"],
    ["DELETE", "/v1/apps/shop/domains/a.example.com", "admin"],
    ["GET", "/v1/certs", "viewer"],
    ["POST", "/v1/apps/shop/rollback", "deployer"],
    ["POST", "/v1/apps/shop/restart", "deployer"],
    ["GET", "/v1/apps/shop/logs?service=web", "deployer"],
    ["PUT", "/v1/apps/shop/env/TOKEN", "admin"],
    ["GET", "/v1/tokens", "admin"],
    ["GET", "/v1/audit", "admin"],
    ["POST", "/v1/certs/renew", "admin"],
    ["POST", "/v1/sync", "admin"],
  ];

  it("health is public", async () => {
    const { request } = await makeApi();
    const r = await request("/health");
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    const { request } = await makeApi();
    for (const token of [undefined, "nope", "fr_unknown"]) {
      const r = await request("/v1/apps", { token });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe("unauthorized");
    }
  });

  it.each(routes)("%s %s requires %s", async (method, path, need) => {
    const { request, tokens } = await makeApi();
    const roles = ["viewer", "deployer", "admin"] as const;
    for (const role of roles) {
      const r = await request(path, { method, token: tokens[role], json: method === "GET" ? undefined : method === "PUT" ? { value: "x" } : {} });
      if (roles.indexOf(role) < roles.indexOf(need)) expect(r.status, `${role} on ${path}`).toBe(403);
      else expect(r.status, `${role} on ${path}`).not.toBe(403);
    }
  });

  it("rate-limits repeated failures per address", async () => {
    const { request, tokens } = await makeApi();
    for (let i = 0; i < 10; i++) expect((await request("/v1/apps", { token: "fr_bad", ip: "9.9.9.9" })).status).toBe(401);
    expect((await request("/v1/apps", { token: "fr_bad", ip: "9.9.9.9" })).status).toBe(429);
    expect((await request("/v1/apps", { token: tokens.viewer, ip: "9.9.9.9" })).status).toBe(429);
    expect((await request("/v1/apps", { token: tokens.viewer, ip: "1.1.1.1" })).status).toBe(200);
  });
});

describe("deployments", () => {
  it("accepts an artifact, runs the job, records success and cleans the spool", async () => {
    const t = await makeApi();
    const res = await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball(), headers: { "content-type": "application/gzip" } });
    expect(res.status).toBe(202);
    const id = res.json.id as string;
    expect(t.registry.deployments.get(id)?.status).toMatch(/queued|running|success/);

    await t.api.jobs.idle();
    const d = await t.request(`/v1/deployments/${id}`, { token: t.tokens.viewer });
    expect(d.json).toMatchObject({ status: "success", releaseId: "r2", previousRelease: "r1", source: "api", warnings: ["w1"], historyAt: "2026-11-06T11:00:00.000Z" });
    expect(d.json.artifactSha256).toMatch(/^[0-9a-f]{64}$/);

    const call = t.calls.find((c) => c.op === "app.deploy")!;
    expect((call.args as { artifact: string }).artifact).toBe(`${t.ctx.artifactsDir}/${id}.tar.gz`);
    expect((call.args as { manifestText: string }).manifestText).toBe(APP_YAML);
    expect(t.spoolFiles()).toEqual([]); // spool file removed
    expect(t.registry.audit.list().some((a) => a.action === "deploy.queued" && a.app === "shop")).toBe(true);
    // the job synced observed state
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).json.services[0]).toMatchObject({ name: "web", port: 20001 });
  });

  it("records a failed deploy with the agent's details", async () => {
    const t = await makeApi();
    t.handlers["app.deploy"] = () => {
      throw new AgentError("deploy_failed", "deploy of r3 failed:\n  web: no healthy response", { rolledBackTo: "r2", releaseId: "r3", historyAt: "2026-11-06T13:00:00.000Z" });
    };
    const id = (await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() })).json.id;
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(id)).toMatchObject({ status: "failed", releaseId: "r3", previousRelease: "r2", historyAt: "2026-11-06T13:00:00.000Z" });
    expect(t.registry.deployments.get(id)?.error).toContain("no healthy response");
    expect(t.spoolFiles()).toEqual([]);
  });

  it("serializes jobs and survives a crashed agent call", async () => {
    const t = await makeApi();
    t.handlers["app.deploy"] = () => {
      throw new AgentError("unavailable", "cannot reach agent");
    };
    const id = (await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() })).json.id;
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(id)).toMatchObject({ status: "failed", error: "cannot reach agent" });
    expect(t.api.jobs.busy()).toBe(false);
  });

  it("validates the upload", async () => {
    const t = await makeApi({ maxUploadBytes: 2000 });
    const post = (body: Body, headers: Record<string, string> = {}, app = "shop") =>
      t.request(`/v1/apps/${app}/deployments`, { method: "POST", token: t.tokens.deployer, body, headers });

    expect((await post("not a tarball")).json.error.message).toMatch(/containing app\.yaml/);
    expect((await post(await t.tarball({ "server.mjs": "x" }))).status).toBe(400);
    const bad = await post(await t.tarball({ "app.yaml": "name: shop\nservices: {}\nfoo: [" }));
    expect(bad.status).toBe(400);
    const mismatch = await post(await t.tarball(), {}, "other");
    expect(mismatch.json.error.message).toMatch(/is for "shop" but the URL is for "other"/);
    expect((await post(new Uint8Array(0))).status).toBe(400);

    const big = new Uint8Array(5000).fill(1);
    expect((await post(big, { "content-length": "5000" })).status).toBe(413);
    expect((await post(big)).status).toBe(413);
    expect(t.spoolFiles()).toEqual([]);
    expect(t.registry.deployments.list()).toEqual([]);
  });

  it("queues a rollback", async () => {
    const t = await makeApi();
    const r = await t.request("/v1/apps/shop/rollback", { method: "POST", token: t.tokens.deployer, json: { release: "r1" } });
    expect(r.status).toBe(202);
    await t.api.jobs.idle();
    expect(t.calls.find((c) => c.op === "app.rollback")?.args).toEqual({ app: "shop", release: "r1" });
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ action: "rollback", status: "success", releaseId: "r1", previousRelease: "r2" });
    expect((await t.request("/v1/apps/shop/rollback", { method: "POST", token: t.tokens.deployer, json: { release: "Bad Id" } })).status).toBe(400);
  });
});

describe("operations", () => {
  it("controls services, reads logs and releases", async () => {
    const t = await makeApi();
    const c = await t.request("/v1/apps/shop/restart", { method: "POST", token: t.tokens.deployer, json: { service: "web" } });
    expect(c.json).toEqual({ units: ["restart-unit"] });
    expect(t.calls.at(-1)).toEqual({ op: "app.control", args: { app: "shop", verb: "restart", service: "web" } });
    expect((await t.request("/v1/apps/shop/logs?service=web&lines=5", { token: t.tokens.deployer })).json.text).toBe("line1\nline2\n");
    expect((await t.request("/v1/apps/shop/logs", { token: t.tokens.deployer })).status).toBe(400);
    expect((await t.request("/v1/apps/shop/logs?service=web&lines=99999", { token: t.tokens.deployer })).status).toBe(400);
    expect((await t.request("/v1/apps/shop/releases", { token: t.tokens.viewer })).json.releases).toHaveLength(2);
    expect((await t.request("/v1/apps/Bad_Name/releases", { token: t.tokens.viewer })).status).toBe(400);
  });

  describe("domains", () => {
    const add = (t: Awaited<ReturnType<typeof makeApi>>, hostname: string, extra: object = {}, token = t.tokens.admin) =>
      t.request("/v1/apps/shop/domains", { method: "POST", token, json: { hostname, service: "web", ...extra } });
    const verify = (t: Awaited<ReturnType<typeof makeApi>>, hostname: string) => t.request(`/v1/apps/shop/domains/${hostname}/verify`, { method: "POST", token: t.tokens.admin });

    it("a new domain only waits: nothing is routed until its DNS is verified", async () => {
      const t = await makeApi();
      const r = await add(t, " Blog.Example.com ", { tls: "off" });
      expect(r.status).toBe(201);
      expect(r.json.domain).toMatchObject({ hostname: "blog.example.com", service: "web", tls: "off", status: "pending" });
      expect(r.json.dns.records).toEqual([{ type: "A", value: "203.0.113.7" }]); // what to set at the DNS provider
      expect(t.calls.some((c) => c.op === "domains.set")).toBe(false);

      const list = (await t.request("/v1/apps/shop/domains", { token: t.tokens.viewer })).json;
      expect(list.domains.map((d: any) => [d.hostname, d.status])).toEqual([["shop.example.com", "active"], ["blog.example.com", "pending"]]);
      expect(t.registry.apps.get("shop")?.server).toBe("local");
    });

    it("verifying checks DNS, explains what is wrong, and only then applies it as a recorded deployment", async () => {
      const t = await makeApi();
      await add(t, "blog.example.com");

      let v = await verify(t, "blog.example.com");
      expect(v.json).toMatchObject({ verified: false, found: [], expected: ["203.0.113.7"] });
      expect(v.json.reason).toMatch(/doesn't resolve yet/);

      t.zone["blog.example.com"] = ["198.51.100.1"];
      v = await verify(t, "blog.example.com");
      expect(v.json.reason).toMatch(/resolves to 198\.51\.100\.1, but this server is 203\.0\.113\.7/);

      t.zone["blog.example.com"] = ["203.0.113.7", "198.51.100.1"];
      expect((await verify(t, "blog.example.com")).json.reason).toMatch(/Remove the other records/);
      expect(t.registry.pendingDomains.get("blog.example.com")?.lastError).toBeTruthy();
      expect(t.calls.some((c) => c.op === "domains.set")).toBe(false);

      t.zone["blog.example.com"] = ["203.0.113.7"];
      v = await verify(t, "blog.example.com");
      expect(v.status).toBe(202);
      await t.api.jobs.idle();
      expect(t.calls.filter((c) => c.op === "domains.set").at(-1)?.args).toEqual({
        app: "shop",
        domains: [{ hostname: "shop.example.com", service: "web", tls: "auto" }, { hostname: "blog.example.com", service: "web", tls: "auto" }],
      });
      expect(t.registry.deployments.get(v.json.id)).toMatchObject({ status: "success", releaseId: "r8" });
      expect(t.registry.pendingDomains.get("blog.example.com")).toBeUndefined();
      expect(t.registry.audit.list()[0]).toMatchObject({ action: "domain.verify", app: "shop" });
    });

    it("keeps the domain waiting, with the reason, when going live fails", async () => {
      const t = await makeApi();
      await add(t, "blog.example.com");
      t.zone["blog.example.com"] = ["203.0.113.7"];
      t.handlers["domains.set"] = () => { throw new AgentError("deploy_failed", "deploy of r9 failed:\nweb: no healthy response\nrolled back to r7", { releaseId: "r9", rolledBackTo: "r7", historyAt: "t" }); };
      const v = await verify(t, "blog.example.com");
      await t.api.jobs.idle();
      expect(t.registry.deployments.get(v.json.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/no healthy response/) });
      expect(t.registry.pendingDomains.get("blog.example.com")?.lastError).toMatch(/going live failed/);
    });

    it(".localhost names need no DNS; without a known server address nothing else can be verified", async () => {
      const t = await makeApi();
      await add(t, "demo.localhost");
      expect((await verify(t, "demo.localhost")).status).toBe(202);
      const bare = await makeApi({ publicIps: [] });
      await add(bare, "blog.example.com");
      bare.zone["blog.example.com"] = ["203.0.113.7"];
      expect((await verify(bare, "blog.example.com")).json.reason).toMatch(/api\.publicIps/);
    });

    it("removes waiting domains directly and live ones through a deployment", async () => {
      const t = await makeApi();
      await add(t, "blog.example.com");
      expect((await t.request("/v1/apps/shop/domains/blog.example.com", { method: "DELETE", token: t.tokens.admin })).json).toEqual({ ok: true });
      expect(t.registry.pendingDomains.list()).toEqual([]);
      const live = await t.request("/v1/apps/shop/domains/shop.example.com", { method: "DELETE", token: t.tokens.admin });
      expect(live.status).toBe(202);
      await t.api.jobs.idle();
      expect(t.calls.filter((c) => c.op === "domains.set").at(-1)?.args).toEqual({ app: "shop", domains: [] });
      expect((await t.request("/v1/apps/shop/domains/nope.example.com", { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
    });

    it("refuses bad hostnames, duplicates, other apps' hostnames, and non-admins", async () => {
      const t = await makeApi();
      for (const bad of ["Not A Host", "*.example.com", "localhost", "a_b.example.com"]) expect((await add(t, bad)).status).toBe(400);
      expect((await add(t, "shop.example.com")).status).toBe(409); // already live on this app
      expect((await add(t, "x.example.com")).status).toBe(201);
      expect((await add(t, "x.example.com")).status).toBe(409); // already waiting
      expect((await add(t, "y.example.com", {}, t.tokens.deployer)).status).toBe(403);
      expect((await t.request("/v1/apps/other/domains", { method: "POST", token: t.tokens.admin, json: { hostname: "x.example.com", service: "web" } })).status).toBe(409); // waiting on shop
      expect((await verify(t, "unknown.example.com")).status).toBe(404);
    });
  });

  it("sets env without ever storing or returning the value", async () => {
    const t = await makeApi();
    const r = await t.request("/v1/apps/shop/env/TOKEN", { method: "PUT", token: t.tokens.admin, json: { value: "s3cret-value" } });
    expect(r.status).toBe(200);
    expect(t.calls.at(-1)).toEqual({ op: "env.set", args: { app: "shop", key: "TOKEN", value: "s3cret-value" } });
    expect(JSON.stringify(t.registry.audit.list())).not.toContain("s3cret-value");
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "env.set", app: "shop", detail: { key: "TOKEN" } });
    expect((await t.request("/v1/apps/shop/env/lower", { method: "PUT", token: t.tokens.admin, json: { value: "x" } })).status).toBe(400);
    expect((await t.request("/v1/apps/shop/env", { token: t.tokens.viewer })).json).toEqual({ names: ["TOKEN"] });
  });

  it("maps agent failures to HTTP statuses", async () => {
    const t = await makeApi();
    t.handlers["env.list"] = () => {
      throw new AgentError("not_found", "app \"shop\" is not deployed");
    };
    expect((await t.request("/v1/apps/shop/env", { token: t.tokens.viewer })).status).toBe(404);
    t.handlers["env.list"] = () => {
      throw new AgentError("unavailable", "cannot reach agent at /run/x");
    };
    const r = await t.request("/v1/apps/shop/env", { token: t.tokens.viewer });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("agent_unavailable");
    t.handlers["env.list"] = () => {
      throw new Error("kaboom");
    };
    const e = await t.request("/v1/apps/shop/env", { token: t.tokens.viewer });
    expect(e.status).toBe(500);
    expect(e.json.error.message).toBe("internal error"); // no leakage
  });
});

describe("registry sync and tokens", () => {
  it("syncs apps, services and host-side history", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).status).toBe(404);
    const s = await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(s.json).toEqual({ apps: 1, errors: {}, servers: { local: "online" } });
    const apps = await t.request("/v1/apps", { token: t.tokens.viewer });
    expect(apps.json.apps[0]).toMatchObject({ name: "shop", currentRelease: "r2", status: "deployed" });
    expect(apps.json.apps[0].manifestText).toBeUndefined();
    const detail = await t.request("/v1/apps/shop", { token: t.tokens.viewer });
    expect(detail.json.manifestText).toBe(APP_YAML);
    const hist = await t.request("/v1/apps/shop/deployments", { token: t.tokens.viewer });
    expect(hist.json.deployments).toHaveLength(1);
    expect(hist.json.deployments[0]).toMatchObject({ source: "host", releaseId: "r1", status: "success" });
    await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} }); // idempotent
    expect((await t.request("/v1/apps/shop/deployments", { token: t.tokens.viewer })).json.deployments).toHaveLength(1);

    t.handlers["apps.list"] = () => ({ apps: [] });
    await t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
    expect(t.registry.apps.get("shop")?.status).toBe("missing");
  });

  it("creates, lists and revokes tokens", async () => {
    const t = await makeApi();
    const made = await t.request("/v1/tokens", { method: "POST", token: t.tokens.admin, json: { name: "ci", role: "deployer" } });
    expect(made.status).toBe(201);
    expect(made.json.token).toMatch(/^fr_/);
    expect((await t.request("/v1/apps", { token: made.json.token })).status).toBe(200);

    const list = await t.request("/v1/tokens", { token: t.tokens.admin });
    expect(JSON.stringify(list.json)).not.toContain(made.json.token);
    expect((await t.request("/v1/tokens", { method: "POST", token: t.tokens.admin, json: { name: "x", role: "root" } })).status).toBe(400);

    expect((await t.request(`/v1/tokens/${made.json.id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(200);
    expect((await t.request("/v1/apps", { token: made.json.token })).status).toBe(401);
    expect((await t.request(`/v1/tokens/${made.json.id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
  });
});
