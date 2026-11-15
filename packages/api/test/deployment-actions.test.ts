import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const imagesManifest = (name: string) => JSON.stringify({ name, services: { web: { image: "nginx:1" } } });
const deployed = (app: string) => ({ app, releaseId: "r2", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: "2026-11-06T11:00:00.000Z" });

async function deployImages(t: Awaited<ReturnType<typeof makeApi>>, name = "shop") {
  const r = await t.request(`/v1/apps/${name}/image-deployments`, { method: "POST", token: t.tokens.deployer, json: { manifest: imagesManifest(name) } });
  await t.api.jobs.idle();
  return r.json.id as string;
}

describe("deployment actions", () => {
  it("deletes a finished deployment and refuses one still in progress", async () => {
    const t = await makeApi();
    const id = await deployImages(t);
    expect(t.registry.deployments.get(id)?.status).toBe("success");

    expect((await t.request(`/v1/deployments/${id}`, { method: "DELETE", token: t.tokens.viewer })).status).toBe(403);
    expect((await t.request("/v1/deployments/nope", { method: "DELETE", token: t.tokens.deployer })).status).toBe(404);

    const removed = await t.request(`/v1/deployments/${id}`, { method: "DELETE", token: t.tokens.deployer });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ ok: true, id });
    expect(t.registry.deployments.get(id)).toBeUndefined();
    expect(t.registry.audit.list().some((a) => a.action === "deploy.delete" && a.detail.deployment === id)).toBe(true);

    // One that is still running is not a row to forget: cancel it first.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.handlers["app.deploy"] = async (a: { manifestText: string }) => {
      await gate;
      return deployed(JSON.parse(a.manifestText).name);
    };
    const running = (await t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: imagesManifest("shop") } })).json.id as string;
    for (let i = 0; i < 100 && t.registry.deployments.get(running)?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await t.request(`/v1/deployments/${running}`, { method: "DELETE", token: t.tokens.deployer })).status).toBe(409);
    release();
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(running)?.status).toBe("success");
  });

  it("retries the live deployment only", async () => {
    const t = await makeApi();
    let done = 0;
    t.handlers["app.deploy"] = (a: { manifestText: string }) => ({ ...deployed(JSON.parse(a.manifestText).name), historyAt: `2026-11-06T15:00:0${++done}.000Z` });
    // The agent reports what it runs; this one runs images, so a retry pulls them again.
    t.handlers["app.info"] = () => ({
      app: "shop",
      release: "r2",
      previous: "r1",
      manifestText: imagesManifest("shop"),
      services: { web: { unit: "freighter-shop--web--r2.service", port: 20001, hostnames: [], activeState: "active", subState: "running", mainPid: 7, memoryCurrent: 1024, restarts: 0 } },
      releases: [{ id: "r1", current: false, result: "success" }, { id: "r2", current: true, result: "success" }],
    });
    const first = await deployImages(t);

    expect((await t.request(`/v1/deployments/${first}/retry`, { method: "POST", token: t.tokens.viewer })).status).toBe(403);
    const retried = await t.request(`/v1/deployments/${first}/retry`, { method: "POST", token: t.tokens.deployer });
    expect(retried.status).toBe(202);
    expect(retried.json.id).not.toBe(first);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(retried.json.id)?.status).toBe("success");
    expect(t.registry.audit.list().some((a) => a.action === "deploy.retry" && a.detail.retried === first)).toBe(true);

    // A newer deployment is the live one now: the first is history, and history is rolled back to, not retried.
    const second = await deployImages(t);
    expect((await t.request(`/v1/deployments/${first}/retry`, { method: "POST", token: t.tokens.deployer })).status).toBe(409);
    expect((await t.request(`/v1/deployments/${second}/retry`, { method: "POST", token: t.tokens.deployer })).status).toBe(202);
    await t.api.jobs.idle();
  });

  it("cannot retry a failed deployment or one built from an uploaded archive", async () => {
    const t = await makeApi();
    t.handlers["app.deploy"] = () => {
      throw new Error("the build broke");
    };
    const failed = (await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() })).json.id as string;
    await t.api.jobs.idle();
    expect((await t.request(`/v1/deployments/${failed}/retry`, { method: "POST", token: t.tokens.deployer })).status).toBe(409);

    // An app uploaded as an archive has no branch head or image tag to pull again.
    t.handlers["app.deploy"] = () => ({ ...deployed("shop"), historyAt: "2026-11-06T15:00:00.000Z" });
    const uploaded = (await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() })).json.id as string;
    await t.api.jobs.idle();
    const r = await t.request(`/v1/deployments/${uploaded}/retry`, { method: "POST", token: t.tokens.deployer });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/uploaded archive/);
  });
});
