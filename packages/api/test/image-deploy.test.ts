import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const IMAGE_YAML = "name: shop\nservices:\n  web:\n    image: ghcr.io/org/shop:1\n    port: 3000\n";

describe("registry logins", () => {
  it("are admin-only, never return the password, and are replaced in place", async () => {
    const t = await makeApi();
    const put = (token: string, password = "pw1") => t.request("/v1/registries/ghcr.io", { method: "PUT", token, json: { username: "me", password } });
    expect((await put(t.tokens.deployer)).status).toBe(403);
    const r = await put(t.tokens.admin);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toContain("pw1");
    await put(t.tokens.admin, "pw2");

    const list = await t.request("/v1/registries", { token: t.tokens.admin });
    expect(list.json.registries).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toMatch(/pw[12]/);
    expect(t.registry.registryCredentials.password("ghcr.io")).toEqual({ username: "me", password: "pw2" });
    expect((await t.request("/v1/registries", { token: t.tokens.deployer })).status).toBe(403);

    expect((await t.request("/v1/registries/Not A Host!", { method: "PUT", token: t.tokens.admin, json: { username: "a", password: "b" } })).status).toBe(400);
    expect((await t.request("/v1/registries/ghcr.io", { method: "DELETE", token: t.tokens.admin })).status).toBe(200);
    expect((await t.request("/v1/registries/ghcr.io", { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
    expect(JSON.stringify(t.registry.audit.list())).not.toMatch(/pw[12]/);
  });
});

describe("POST /v1/apps/:app/image-deployments", () => {
  it("queues a deploy that sends the agent only the login for the image's registry", async () => {
    const t = await makeApi();
    t.registry.registryCredentials.set({ host: "ghcr.io", username: "me", password: "pw" });
    t.registry.registryCredentials.set({ host: "docker.io", username: "other", password: "nope" });
    const r = await t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: IMAGE_YAML } });
    expect(r.status).toBe(202);
    await t.api.jobs.idle();

    const call = t.calls.find((c) => c.op === "app.deploy")!.args as Record<string, unknown>;
    expect(call).toMatchObject({ manifestText: IMAGE_YAML, registryAuth: [{ host: "ghcr.io", username: "me", password: "pw" }], logId: r.json.id });
    expect(call.artifact).toBeUndefined();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success", releaseId: "r2" });
    expect(t.calls.some((c) => c.op === "putArtifact")).toBe(false);
  });

  it("refuses manifests that still need an upload, or are for another app", async () => {
    const t = await makeApi();
    const post = (manifest: string) => t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest } });
    expect((await post("name: shop\nservices:\n  web:\n    command: node x.js\n")).status).toBe(400);
    expect((await post(IMAGE_YAML.replace("name: shop", "name: blog"))).status).toBe(400);
    expect((await post("name: shop\nservices:\n  web:\n    image: a\n    command: b\n")).status).toBe(400);
    expect((await t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.viewer, json: { manifest: IMAGE_YAML } })).status).toBe(403);
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false);
  });

  it("fails the deployment, with a reason, when the agent predates images", async () => {
    const t = await makeApi();
    t.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["artifact.put"] });
    const r = await t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: IMAGE_YAML } });
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "failed" });
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/too old to run images/);
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false);
  });
});

describe("POST /v1/apps/:app/redeploy", () => {
  it("deploys the app's current manifest again", async () => {
    const t = await makeApi();
    t.registry.apps.upsert({ name: "shop", server: "local", manifestText: IMAGE_YAML, currentRelease: "r1", previousRelease: null, status: "deployed" });
    const r = await t.request("/v1/apps/shop/redeploy", { method: "POST", token: t.tokens.deployer });
    expect(r.status).toBe(202);
    await t.api.jobs.idle();
    expect(t.calls.find((c) => c.op === "app.deploy")?.args).toMatchObject({ manifestText: IMAGE_YAML });
  });
  it("is a 404 for an app that was never deployed", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/apps/ghost/redeploy", { method: "POST", token: t.tokens.deployer })).status).toBe(404);
  });
});
