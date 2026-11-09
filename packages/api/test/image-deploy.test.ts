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
    expect(t.registry.registryCredentials.secret("ghcr.io", "me")).toEqual({ username: "me", password: "pw2" });
    // deployers may see which logins exist (to choose one), never a secret
    const asDeployer = await t.request("/v1/registries", { token: t.tokens.deployer });
    expect(asDeployer.status).toBe(200);
    expect(JSON.stringify(asDeployer.json)).not.toMatch(/pw[12]/);
    expect((await t.request("/v1/registries", { token: t.tokens.viewer })).status).toBe(403);

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

describe("images in the app view, and changing them", () => {
  const seed = (t: Awaited<ReturnType<typeof makeApi>>, text = `${IMAGE_YAML}environment:\n  A: b\n`) =>
    t.registry.apps.upsert({ name: "shop", server: "local", manifestText: text, currentRelease: "r1", previousRelease: null, status: "deployed" });

  it("lists the image of each service on GET /apps/:app", async () => {
    const t = await makeApi();
    seed(t);
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).json.images).toEqual({ web: "ghcr.io/org/shop:1" });
    t.registry.apps.upsert({ name: "blog", server: "local", manifestText: "name: blog\nservices:\n  web:\n    command: x\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    expect((await t.request("/v1/apps/blog", { token: t.tokens.viewer })).json.images).toEqual({});
  });

  it("deploys the current app.yaml with a new image, leaving the rest alone", async () => {
    const t = await makeApi();
    seed(t);
    const r = await t.request("/v1/apps/shop/images", { method: "POST", token: t.tokens.deployer, json: { images: { web: "ghcr.io/org/shop:2" } } });
    expect(r.status).toBe(202);
    await t.api.jobs.idle();
    const sent = (t.calls.find((c) => c.op === "app.deploy")!.args as { manifestText: string }).manifestText;
    expect(sent).toContain("image: ghcr.io/org/shop:2");
    expect(sent).toContain("port: 3000");
    expect(sent).toContain("A: b");
    expect(sent).not.toContain("shop:1");
  });

  it("rejects unknown services, command services and bad references", async () => {
    const t = await makeApi();
    seed(t);
    const post = (images: Record<string, string>, token = t.tokens.deployer) => t.request("/v1/apps/shop/images", { method: "POST", token, json: { images } });
    expect((await post({ api: "nginx" })).status).toBe(400);
    expect((await post({ web: "Bad Image" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ web: "nginx" }, t.tokens.viewer)).status).toBe(403);
    expect((await t.request("/v1/apps/ghost/images", { method: "POST", token: t.tokens.deployer, json: { images: { web: "nginx" } } })).status).toBe(404);
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false);
  });
});

describe("several logins for one registry", () => {
  const two = (t: Awaited<ReturnType<typeof makeApi>>) => {
    t.registry.registryCredentials.set({ host: "ghcr.io", username: "alice", password: "pa" });
    t.registry.registryCredentials.set({ host: "ghcr.io", username: "bob", password: "pb" });
  };
  const deploy = (t: Awaited<ReturnType<typeof makeApi>>, json: Record<string, unknown> = {}) =>
    t.request("/v1/apps/shop/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: IMAGE_YAML, ...json } });

  it("refuses to guess: a deploy has to say which login the app pulls with", async () => {
    const t = await makeApi();
    two(t);
    const r = await deploy(t);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("login_required");
    expect(r.json.error.message).toMatch(/alice, bob/);
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false);
  });

  it("uses the chosen login, remembers it for the app, and keeps it for redeploys", async () => {
    const t = await makeApi();
    two(t);
    const r = await deploy(t, { logins: { "ghcr.io": "bob" } });
    expect(r.status).toBe(202);
    await t.api.jobs.idle();
    expect((t.calls.find((c) => c.op === "app.deploy")!.args as { registryAuth: unknown }).registryAuth).toEqual([{ host: "ghcr.io", username: "bob", password: "pb" }]);
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).json.registryLogins).toEqual({ "ghcr.io": "bob" });

    t.registry.apps.upsert({ name: "shop", server: "local", manifestText: IMAGE_YAML, currentRelease: "r1", previousRelease: null, status: "deployed" });
    expect((await t.request("/v1/apps/shop/redeploy", { method: "POST", token: t.tokens.deployer })).status).toBe(202);
    await t.api.jobs.idle();
    expect((t.calls.filter((c) => c.op === "app.deploy").at(-1)!.args as { registryAuth: { username: string }[] }).registryAuth[0]!.username).toBe("bob");
  });

  it("changes the choice for an app, and rejects a login that doesn't exist", async () => {
    const t = await makeApi();
    two(t);
    const put = (username: string | null, token = t.tokens.deployer) => t.request("/v1/apps/shop/registry-logins/ghcr.io", { method: "PUT", token, json: { username } });
    expect((await put("alice")).json.registryLogins).toEqual({ "ghcr.io": "alice" });
    expect((await put("nobody")).status).toBe(404);
    expect((await put("alice", t.tokens.viewer)).status).toBe(403);
    expect((await put(null)).json.registryLogins).toEqual({});
    expect((await deploy(t, { logins: { "ghcr.io": "mallory" } })).status).toBe(400);
  });

  it("deletes one login by user name, and asks which when there are several", async () => {
    const t = await makeApi();
    two(t);
    const del = (q = "") => t.request(`/v1/registries/ghcr.io${q}`, { method: "DELETE", token: t.tokens.admin });
    const ask = await del();
    expect(ask.status).toBe(400);
    expect(ask.json.error.message).toMatch(/alice, bob/);
    expect((await del("?username=nobody")).status).toBe(404);
    expect((await del("?username=bob")).status).toBe(200);
    expect(t.registry.registryCredentials.list().map((c) => c.username)).toEqual(["alice"]);
    expect((await del()).status).toBe(200); // the only one left needs no name
  });
});
