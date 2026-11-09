import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof makeApi>>;
const PEM = (n: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${n}\n-----END OPENSSH PRIVATE KEY-----`;
const REPO = "git@git.example.com:acme/shop.git";

const importKey = (t: Api, name: string, privateKey = PEM(name), token = t.tokens.admin) =>
  t.request("/v1/ssh-keys", { method: "POST", token, json: { name, privateKey } });

describe("ssh keys", () => {
  it("imports a key through the local agent and never returns the private half", async () => {
    const t = await makeApi();
    const r = await importKey(t, "work");
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "work", keyType: "ed25519", comment: "me@laptop", appCount: 0 });
    expect(JSON.stringify(r.json)).not.toContain("PRIVATE KEY");
    expect(t.calls.find((c) => c.op === "ssh.import")?.args).toMatchObject({ privateKey: PEM("work") });
    const list = await t.request("/v1/ssh-keys", { token: t.tokens.admin });
    expect(list.json.keys).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain("PRIVATE KEY");
    expect(t.registry.sshKeys.privateKey(r.json.id)).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("is admin-only, and rejects duplicate names and duplicate keys", async () => {
    const t = await makeApi();
    expect((await importKey(t, "a", undefined, t.tokens.deployer)).status).toBe(403);
    expect((await t.request("/v1/ssh-keys", { token: t.tokens.deployer })).status).toBe(403);
    expect((await importKey(t, "a")).status).toBe(201);
    expect((await importKey(t, "a", PEM("other"))).status).toBe(409);
    expect((await importKey(t, "b", PEM("a"))).status).toBe(409);
    expect((await t.request("/v1/ssh-keys", { method: "POST", token: t.tokens.admin, json: { name: "../x", privateKey: "k" } })).status).toBe(400);
  });

  it("surfaces agent validation errors (bad key, wrong passphrase)", async () => {
    const t = await makeApi();
    t.handlers["ssh.import"] = () => { throw new t.AgentError("bad_request", "not a valid SSH private key"); };
    const r = await importKey(t, "x");
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not a valid SSH private key/);
    expect(t.registry.sshKeys.list()).toEqual([]);
  });

  it("refuses to delete a key that apps use, then deletes it once they switch", async () => {
    const t = await makeApi();
    const k = (await importKey(t, "work")).json;
    const l = await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.admin, json: { repository: REPO, branch: "main", sshKeyId: k.id } });
    expect(l.status).toBe(201);
    expect(l.json.link).toMatchObject({ sshKeyId: k.id, sshKey: { id: k.id, name: "work" }, publicKey: "" });
    expect(t.calls.some((c) => c.op === "git.keygen")).toBe(false); // an imported key needs no generated one
    expect((await t.request(`/v1/ssh-keys/${k.id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(409);
    expect((await t.request("/v1/ssh-keys", { token: t.tokens.admin })).json.keys[0].appCount).toBe(1);

    const back = await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { sshKeyId: null } });
    expect(back.status).toBe(200);
    expect(back.json.publicKey).toMatch(/^ssh-ed25519/); // fell back to a generated deploy key
    expect((await t.request(`/v1/ssh-keys/${k.id}`, { method: "DELETE", token: t.tokens.admin })).json).toEqual({ ok: true });
    expect((await t.request(`/v1/ssh-keys/${k.id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
  });

  it("sends the decrypted key to the agent for check and deploy, and records its use", async () => {
    const t = await makeApi();
    const k = (await importKey(t, "work")).json;
    await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.admin, json: { repository: REPO, branch: "main", sshKeyId: k.id } });
    await t.request("/v1/apps/shop/git/check", { method: "POST", token: t.tokens.deployer });
    expect(t.calls.find((c) => c.op === "git.check")?.args).toMatchObject({ auth: { sshKey: expect.stringContaining("BEGIN OPENSSH PRIVATE KEY") } });
    const d = await t.request("/v1/apps/shop/git/deploy", { method: "POST", token: t.tokens.deployer });
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(d.json.id)?.status).toBe("success");
    expect(t.calls.find((c) => c.op === "git.deploy")?.args).toMatchObject({ auth: { sshKey: expect.stringContaining("BEGIN OPENSSH PRIVATE KEY") } });
    expect(t.registry.sshKeys.get(k.id)?.lastUsedAt).not.toBeNull();
  });

  it("refuses to rotate the generated key of a link that uses an imported one", async () => {
    const t = await makeApi();
    const k = (await importKey(t, "work")).json;
    await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.admin, json: { repository: REPO, branch: "main", sshKeyId: k.id } });
    expect((await t.request("/v1/apps/shop/git/rotate-key", { method: "POST", token: t.tokens.admin })).status).toBe(400);
  });

  it("rejects linking with an unknown key", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.admin, json: { repository: REPO, sshKeyId: "key_nope" } })).status).toBe(404);
  });
});

describe("generating keys", () => {
  it("creates a key pair on the server, stores the private half, and returns only the public key", async () => {
    const t = await makeApi();
    const r = await t.request("/v1/ssh-keys/generate", { method: "POST", token: t.tokens.admin, json: { name: "fresh" } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "fresh", keyType: "ed25519", publicKey: expect.stringMatching(/^ssh-ed25519 /) });
    expect(JSON.stringify(r.json)).not.toContain("PRIVATE KEY");
    expect(t.registry.sshKeys.privateKey(r.json.id)).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect((await t.request("/v1/ssh-keys/generate", { method: "POST", token: t.tokens.admin, json: { name: "fresh" } })).status).toBe(409);
    expect((await t.request("/v1/ssh-keys/generate", { method: "POST", token: t.tokens.deployer, json: { name: "x" } })).status).toBe(403);
  });
});

describe("branches, inspect and one-step deployments", () => {
  it("lists branches and inspects a branch using the chosen key", async () => {
    const t = await makeApi();
    const k = (await importKey(t, "work")).json;
    const b = await t.request("/v1/git/branches", { method: "POST", token: t.tokens.deployer, json: { repository: REPO, sshKeyId: k.id } });
    expect(b.json).toMatchObject({ defaultBranch: "main", branches: [{ name: "main", default: true }, { name: "dev" }] });
    expect(t.calls.find((c) => c.op === "git.branches")?.args).toMatchObject({ repository: REPO, auth: { sshKey: expect.any(String) } });
    const i = await t.request("/v1/git/inspect", { method: "POST", token: t.tokens.deployer, json: { repository: REPO, branch: "main" } });
    expect(i.json).toMatchObject({ appName: "shop", valid: true });
    expect(t.calls.find((c) => c.op === "git.inspect")?.args).toMatchObject({ auth: undefined });
    expect((await t.request("/v1/git/branches", { method: "POST", token: t.tokens.viewer, json: { repository: REPO } })).status).toBe(403);
    expect((await t.request("/v1/git/branches", { method: "POST", token: t.tokens.deployer, json: { repository: "--upload-pack=x" } })).status).toBe(400);
  });

  it("names the app from app.yaml, links, deploys, and shows the webhook secret once", async () => {
    const t = await makeApi();
    const k = (await importKey(t, "work")).json;
    const r = await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main", sshKeyId: k.id } });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ app: "shop", deployment: { status: "queued" }, link: { sshKeyId: k.id, repository: REPO } });
    expect(r.json.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.deployment.id)).toMatchObject({ status: "success", trigger: "manual" });
    expect(t.registry.apps.get("shop")?.server).toBe("local");
    // a second attempt for the same app is refused rather than silently re-linking
    expect((await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main", sshKeyId: k.id } })).status).toBe(409);
  });

  it("refuses repositories whose app.yaml is missing or invalid, and deployers", async () => {
    const t = await makeApi();
    t.handlers["git.inspect"] = () => ({ sha: "e".repeat(40), commit: { sha: "e".repeat(40), subject: "s", author: "a" }, hasManifest: false, valid: false, appName: null, error: "app.yaml not found", buildCommands: [] });
    const r = await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main" } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/no app.yaml/);
    expect(t.registry.gitLinks.get("shop")).toBeUndefined();
    expect((await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.deployer, json: { repository: REPO, branch: "main" } })).status).toBe(403);
  });

  describe("settings for repositories without an app.yaml", () => {
    const settings = {
      build: { commands: ["npm ci"] },
      services: { web: { command: "node server.js", port: 3000, healthcheck: { path: "/up" }, secrets: ["DATABASE_URL"] } },
    };
    const noManifest = (t: Awaited<ReturnType<typeof makeApi>>) => {
      t.handlers["git.inspect"] = () => ({ sha: "e".repeat(40), commit: { sha: "e".repeat(40), subject: "s", author: "a" }, hasManifest: false, valid: false, appName: null, error: "app.yaml not found", buildCommands: [] });
    };

    it("deploys with the settings, sends them to the agent as a fallback app.yaml, and keeps them on the link", async () => {
      const t = await makeApi();
      noManifest(t);
      let sent: string | undefined;
      const original = t.handlers["git.deploy"]!;
      t.handlers["git.deploy"] = (a: any) => ((sent = a.fallbackManifest), original(a as never));
      const r = await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main", appName: "storefront", settings } });
      expect(r.status).toBe(202);
      expect(r.json.app).toBe("storefront");
      await t.api.jobs.idle();
      expect(sent).toMatch(/^name: storefront/m);
      expect(sent).toMatch(/node server.js/);
      expect(r.json.link.settings.services.web.port).toBe(3000);
      expect(t.registry.gitLinks.get("storefront")?.settings).toMatchObject({ services: { web: { secrets: ["DATABASE_URL"] } } });
    });

    it("asks for a name and at least one service when the repository has no app.yaml", async () => {
      const t = await makeApi();
      noManifest(t);
      const go = (json: object) => t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main", ...json } });
      expect((await go({ settings })).status).toBe(422);
      expect((await go({ appName: "storefront" })).status).toBe(422);
      expect((await go({ appName: "storefront", settings: { services: {} } })).status).toBe(422);
      expect((await go({ appName: "storefront", settings: { services: { web: { command: "x" } }, domains: [{ hostname: "a.example.com", service: "web" }] } })).status).toBe(400); // domains are not settings
      expect(t.registry.gitLinks.get("storefront")).toBeUndefined();
    });

    it("ignores the settings when the repository has an app.yaml", async () => {
      const t = await makeApi();
      const r = await t.request("/v1/git/deployments", { method: "POST", token: t.tokens.admin, json: { repository: REPO, branch: "main", appName: "other", settings } });
      expect(r.json.app).toBe("shop");
    });

    it("edits and clears settings on a linked app, and previews the app.yaml", async () => {
      const t = await makeApi();
      const put = await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.admin, json: { repository: REPO, branch: "main", settings } });
      expect(put.json.link.settings.build.commands).toEqual(["npm ci"]);
      const patched = await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { settings: { ...settings, services: { web: { ...settings.services.web, environment: { NODE_ENV: "production" } } } } } });
      expect(patched.json.settings.services.web.environment).toEqual({ NODE_ENV: "production" });
      expect((await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { branch: "dev" } })).json.settings).not.toBeNull(); // untouched by other edits
      expect((await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { settings: null } })).json.settings).toBeNull();
      const bad = await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { settings: { services: { web: { command: "x", secrets: ["lower"] } } } } });
      expect(bad.status).toBe(400);
      const prev = await t.request("/v1/manifest/render", { method: "POST", token: t.tokens.viewer, json: { name: "shop", settings } });
      expect(prev.json.text).toMatch(/command: node server.js/);
      expect(prev.json.text).not.toMatch(/domains/);
    });
  });
});
