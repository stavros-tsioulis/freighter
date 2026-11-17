import { describe, expect, it } from "vitest";
import { makeApi, sleepMs } from "./helpers.ts";

const WEB = "name: web\nservices:\n  web:\n    image: ghcr.io/org/web:1\n    port: 3000\n    dependsOn: [billing]\n";
const BILLING = "name: billing\nservices:\n  api:\n    image: ghcr.io/org/billing:1\n";

type T = Awaited<ReturnType<typeof makeApi>>;

const infoFor = (state: () => string, release: string | null = "r1") => ({ app }: { app: string }) => ({
  app,
  release,
  previous: null,
  manifestText: BILLING,
  services: { api: { unit: "u", port: 21000, hostnames: [], activeState: state(), subState: "running", mainPid: 1, memoryCurrent: 1, restarts: 0 } },
  releases: [],
});

async function setup(billing: { state?: () => string; release?: string | null; inProject?: boolean } = {}) {
  const t = await makeApi();
  t.ctx.dependencyWait = { timeoutMs: 400, pollMs: 5 };
  const p = (await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "Shop" } })).json;
  t.registry.apps.upsert({ name: "billing", server: "local", manifestText: BILLING, currentRelease: billing.release === undefined ? "r1" : billing.release, previousRelease: null, status: "deployed" });
  t.registry.apps.ensure("web", "local");
  t.registry.apps.setProject("web", p.id);
  if (billing.inProject !== false) t.registry.apps.setProject("billing", p.id);
  t.handlers["app.info"] = infoFor(billing.state ?? (() => "active"), billing.release);
  t.handlers["domains.get"] = () => ({ domains: [] });
  return t;
}

const deployWeb = (t: T) => t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB } });
const deployed = (t: T) => t.calls.some((c) => c.op === "app.deploy");

describe("dependsOn", () => {
  it("deploys straight away when everything it depends on is running", async () => {
    const t = await setup();
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success" });
    expect(deployed(t)).toBe(true);
  });

  it("waits for a dependency that comes up, and says so in the log", async () => {
    let state = "activating";
    const t = await setup({ state: () => state });
    const r = await deployWeb(t);
    await sleepMs(30);
    expect(deployed(t)).toBe(false);
    state = "active";
    await t.api.jobs.idle();
    expect(deployed(t)).toBe(true);
    const log = t.registry.deployments.getLog(r.json.id)!;
    expect(log).toContain("==> waiting for billing to be ready");
    expect(log).toContain("billing: not ready, api is activating");
    expect(log).toContain("billing: ready");
  });

  it("fails, leaving the running release alone, when the dependency does not come up in time", async () => {
    const t = await setup({ state: () => "failed" });
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    const row = t.registry.deployments.get(r.json.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/gave up waiting after .*billing \(api is failed\)/);
    expect(deployed(t)).toBe(false);
    expect(t.calls.some((c) => c.op === "connections.set")).toBe(false);
  });

  it("treats a dependency that was never deployed as not ready", async () => {
    const t = await setup({ release: null });
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/billing \(it has not been deployed yet\)/);
  });

  it("refuses a dependency that is not an app of the same project", async () => {
    const t = await setup({ inProject: false });
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/billing, which is not an app of its project/);
    expect(deployed(t)).toBe(false);
  });

  it("can be canceled while it waits", async () => {
    const t = await setup({ state: () => "activating" });
    t.ctx.dependencyWait = { timeoutMs: 60_000, pollMs: 5 };
    const r = await deployWeb(t);
    await sleepMs(30);
    expect(await t.api.jobs.cancel(r.json.id, "ada")).toBe("stopping");
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Canceled by ada") });
    expect(deployed(t)).toBe(false);
  });

  it("fails at once when the dependency is queued behind this deployment on the same server", async () => {
    const t = await setup({ state: () => "activating" });
    t.ctx.dependencyWait = { timeoutMs: 60_000, pollMs: 5 };
    t.registry.deployments.create({ id: "b1", app: "billing", server: "local", action: "deploy", trigger: "manual", requestedBy: null });
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/billing is not ready, and its deployment is queued behind this one on local/);
  });

  it("fails at once when two apps wait for each other", async () => {
    const t = await setup({ state: () => "activating" });
    t.ctx.dependencyWait = { timeoutMs: 60_000, pollMs: 5 };
    t.registry.apps.upsert({ name: "billing", server: "local", manifestText: "name: billing\nservices:\n  api:\n    image: ghcr.io/org/billing:1\n    dependsOn: [web]\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    const r = await deployWeb(t);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/web and billing depend on each other/);
  });

  it("does not wait for anything when no service depends on another app", async () => {
    const t = await setup({ state: () => "failed" });
    const r = await t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB.replace("    dependsOn: [billing]\n", "") } });
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success" });
  });
});
