import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const sftp = { kind: "sftp", host: "files.example.com", user: "me", path: "s3", auth: "password", hostKey: "files.example.com ssh-ed25519 AAAA" };

async function create(t: Awaited<ReturnType<typeof makeApi>>, over: Record<string, unknown> = {}) {
  const r = await t.request("/v1/storages", { method: "POST", token: t.tokens.admin, json: { name: "up", backend: { kind: "local" }, ...over } });
  await t.api.jobs.idle();
  return r;
}

describe("storages", () => {
  it("creates one, shows the key pair once, deploys its endpoint and hides the app that serves it", async () => {
    const t = await makeApi();
    const r = await create(t);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "queued", storage: { name: "up", server: "local", app: "storage-up" } });
    expect(r.json.accessKey).toMatch(/^FR[0-9A-F]{20}$/);
    expect(r.json.secretKey.length).toBeGreaterThanOrEqual(30);

    const call = t.calls.find((c) => c.op === "storage.apply")!.args as Record<string, unknown>;
    expect(call).toMatchObject({ name: "up", backend: { kind: "local" }, accessKey: r.json.accessKey, secretKey: r.json.secretKey, logId: r.json.id });
    expect(call.secrets).toBeUndefined();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success", app: "storage-up" });
    expect(t.registry.storages.get("up")?.port).toBe(20100);

    const list = (await t.request("/v1/storages", { token: t.tokens.viewer })).json.storages;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(r.json.secretKey);
    expect((await t.request("/v1/apps", { token: t.tokens.viewer })).json.apps.map((a: { name: string }) => a.name)).not.toContain("storage-up");
  });

  it("is admin-only and refuses duplicates, unusable backends and servers that can't serve storages", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/storages", { method: "POST", token: t.tokens.deployer, json: { name: "up", backend: { kind: "local" } } })).status).toBe(403);
    expect((await create(t)).status).toBe(202);
    expect((await create(t)).status).toBe(409);
    expect((await create(t, { name: "other", backend: { ...sftp, hostKey: undefined }, secrets: { password: "x" } })).status).toBe(400);
    expect((await create(t, { name: "other", backend: sftp })).status).toBe(400); // no password
    expect((await create(t, { name: "other", backend: { kind: "smb", host: "nas", share: "m", user: "me" } })).status).toBe(400);
    expect((await create(t, { name: "Bad Name", backend: { kind: "local" } })).status).toBe(400);
    t.handlers.ping = () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["artifact.put"] });
    const r = await create(t, { name: "nope" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/cannot serve storages/);
    expect(t.registry.storages.get("nope")).toBeUndefined();
  });

  it("seals remote credentials, sends them to the agent only, and keeps them when the backend is edited", async () => {
    const t = await makeApi();
    const r = await create(t, { name: "nas", backend: sftp, secrets: { password: "hunter2" } });
    expect(r.status).toBe(202);
    expect(JSON.stringify(r.json)).not.toContain("hunter2");
    expect(t.calls.find((c) => c.op === "storage.apply")!.args).toMatchObject({ secrets: { password: "hunter2" } });

    t.calls.length = 0;
    const p = await t.request("/v1/storages/nas", { method: "PATCH", token: t.tokens.admin, json: { backend: { ...sftp, path: "other" } } });
    await t.api.jobs.idle();
    expect(p.status).toBe(202);
    expect(t.calls.find((c) => c.op === "storage.apply")!.args).toMatchObject({ backend: { path: "other" }, secrets: { password: "hunter2" } });
  });

  it("tests a backend on the chosen server, and rotates the secret key keeping the access key", async () => {
    const t = await makeApi();
    t.handlers["storage.test"] = () => ({ ok: true, hostKey: { line: "h ssh-ed25519 AAAA", fingerprint: "SHA256:x", type: "ssh-ed25519" } });
    const tested = await t.request("/v1/storages/test", { method: "POST", token: t.tokens.admin, json: { backend: { ...sftp, hostKey: undefined } } });
    expect(tested.json).toMatchObject({ ok: true, hostKey: { fingerprint: "SHA256:x" } });

    const made = await create(t);
    t.calls.length = 0;
    const rot = await t.request("/v1/storages/up/rotate-keys", { method: "POST", token: t.tokens.admin });
    await t.api.jobs.idle();
    expect(rot.json.accessKey).toBe(made.json.accessKey);
    expect(rot.json.secretKey).not.toBe(made.json.secretKey);
    expect(t.calls.find((c) => c.op === "storage.apply")!.args).toMatchObject({ accessKey: made.json.accessKey, secretKey: rot.json.secretKey });
  });

  it("is managed through the storage, not the app that serves it, but its domains work like an app's", async () => {
    const t = await makeApi();
    await create(t);
    const img = await t.request("/v1/apps/storage-up/image-deployments", { method: "POST", token: t.tokens.admin, json: { manifest: "name: storage-up\nservices:\n  s3:\n    image: x\n" } });
    expect(img.status).toBe(409);
    expect(img.json.error.code).toBe("managed_by_storage");
    expect((await t.request("/v1/apps/storage-up", { method: "DELETE", token: t.tokens.admin, json: { confirm: "storage-up" } })).status).toBe(409);
    expect((await t.request("/v1/apps/storage-up/domains", { token: t.tokens.viewer })).status).toBe(200);
  });

  it("deletes after typing its name, and not while an app uses it", async () => {
    const t = await makeApi();
    await create(t);
    t.registry.apps.upsert({ name: "web", server: "local", manifestText: 'name: web\nservices:\n  web:\n    command: x\n    environment:\n      S3: "@storage:up.url"\n', currentRelease: "r1", previousRelease: null, status: "deployed" });
    const del = (json: unknown) => t.request("/v1/storages/up", { method: "DELETE", token: t.tokens.admin, json });
    expect((await del({ confirm: "nope" })).status).toBe(400);
    const busy = await del({ confirm: "up" });
    expect(busy.status).toBe(409);
    expect(busy.json.error.message).toMatch(/used by web/);
    t.registry.apps.remove("web");
    expect((await del({ confirm: "up" })).json).toMatchObject({ ok: true, storage: "up" });
    expect(t.calls.some((c) => c.op === "app.delete" && (c.args as { app: string }).app === "storage-up")).toBe(true);
    expect(t.registry.storages.get("up")).toBeUndefined();
    expect(t.registry.apps.get("storage-up")).toBeUndefined();
  });

  it("describes the storages to an app's agent with the key pair, and keeps the credentials out of the Variables tab", async () => {
    const t = await makeApi();
    const made = await create(t);
    t.handlers["domains.get"] = ({ app }: { app: string }) => ({ domains: app === "storage-up" ? [{ hostname: "s3.example.com", service: "s3", tls: "auto" }] : [] });
    const WEB = 'name: web\nservices:\n  web:\n    command: x\n    environment:\n      URL: "@storage:up.url"\n      SECRET: "@storage:up.secretKey"\n';
    t.registry.apps.upsert({ name: "web", server: "local", manifestText: WEB, currentRelease: "r1", previousRelease: null, status: "deployed" });

    const vars = (await t.request("/v1/apps/web/variables", { token: t.tokens.viewer })).json.variables;
    const byKey = Object.fromEntries(vars.map((v: { key: string }) => [v.key, v]));
    expect(byKey.URL).toMatchObject({ resolved: "https://s3.example.com", secret: false });
    expect(byKey.SECRET).toMatchObject({ resolved: null, secret: true, error: null });
    expect(JSON.stringify(vars)).not.toContain(made.json.secretKey);

    const deploy = await t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB.replace("command: x", "image: ghcr.io/org/web:1") } });
    await t.api.jobs.idle();
    expect(deploy.status).toBe(202);
    const sent = t.calls.filter((c) => c.op === "connections.set").at(-1)!.args as { storages: Record<string, unknown> };
    expect(sent.storages.up).toMatchObject({ name: "up", hostname: "s3.example.com", port: 20100, accessKey: made.json.accessKey, secretKey: made.json.secretKey });
  });
});

describe("storages on the project canvas", () => {
  it("shows the storages a project's apps use, with an arrow from each service, and flags what can't resolve", async () => {
    const t = await makeApi();
    await create(t);
    const p = (await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "Shop" } })).json;
    const WEB = 'name: web\nservices:\n  web:\n    command: x\n    environment:\n      A: "@storage:up.url"\n      B: "@storage:ghost.url"\n';
    t.registry.apps.upsert({ name: "web", server: "local", manifestText: WEB, currentRelease: "r1", previousRelease: null, status: "deployed" });
    t.registry.apps.setProject("web", p.id);
    const g = (await t.request(`/v1/projects/${p.id}/graph`, { token: t.tokens.viewer })).json;
    expect(g.storages).toEqual([expect.objectContaining({ name: "up", kind: "local", server: "local" })]);
    const byKey = Object.fromEntries(g.storageEdges.map((e: { key: string }) => [e.key, e]));
    expect(byKey.A).toMatchObject({ from: { app: "web", service: "web" }, storage: "up", attr: "url", broken: null });
    expect(byKey.B.broken).toMatch(/no storage "ghost"/);
    expect(g.apps.map((a: { name: string }) => a.name)).not.toContain("storage-up");
  });
});

describe("dependants follow", () => {
  const WEB = 'name: web\nservices:\n  web:\n    command: x\n    environment:\n      S3: "@storage:up.url"\n';
  const BILLING = 'name: billing\nservices:\n  api:\n    command: y\n';
  const WORKER = 'name: worker\nservices:\n  w:\n    command: z\n    environment:\n      PAY: "@billing/api.url"\n';
  const deployed = (t: Awaited<ReturnType<typeof makeApi>>, name: string, manifestText: string) => t.registry.apps.upsert({ name, server: "local", manifestText, currentRelease: "r1", previousRelease: null, status: "deployed" });
  const reapplies = (t: Awaited<ReturnType<typeof makeApi>>) => t.calls.filter((c) => c.op === "app.reapply").map((c) => (c.args as { app: string }).app);

  it("reapplies the apps that use a storage after its key rotates, and records only the ones that changed", async () => {
    const t = await makeApi();
    await create(t);
    deployed(t, "web", WEB);
    deployed(t, "billing", BILLING); // does not use it
    t.handlers["app.reapply"] = ({ app }: { app: string }) =>
      app === "web"
        ? { changed: true, deploy: { app, releaseId: "r9", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: "2026-11-06T12:30:00.000Z" } }
        : { changed: false, deploy: null };
    t.calls.length = 0;
    await t.request("/v1/storages/up/rotate-keys", { method: "POST", token: t.tokens.admin });
    await t.api.jobs.idle();
    expect(reapplies(t)).toEqual(["web"]);
    expect(t.registry.deployments.list({ app: "web" })[0]).toMatchObject({ status: "success", releaseId: "r9", warnings: ["restarted because storage up changed"] });
  });

  it("leaves no deployment behind when nothing the dependant reads changed, and does not chase it further", async () => {
    const t = await makeApi();
    deployed(t, "billing", BILLING);
    deployed(t, "worker", WORKER);
    t.handlers["app.reapply"] = () => ({ changed: false, deploy: null });
    await t.api.jobs.cascade({ app: "billing" });
    await t.api.jobs.idle();
    expect(reapplies(t)).toEqual(["worker"]);
    expect(t.registry.deployments.list({ app: "worker" }).filter((d) => d.source === "api")).toEqual([]); // only what syncing imported is there
  });

  it("follows a chain a few steps and then stops, so apps that read each other can't loop", async () => {
    const t = await makeApi();
    const manifests: Record<string, string> = {
      a: 'name: a\nservices:\n  s:\n    command: x\n    environment:\n      B: "@b/s.url"\n',
      b: 'name: b\nservices:\n  s:\n    command: x\n    environment:\n      A: "@a/s.url"\n',
    };
    for (const [name, text] of Object.entries(manifests)) deployed(t, name, text);
    // syncing after each job re-reads the app from its (fake) agent, so the agent has to know these manifests
    const info = t.handlers["app.info"] as (a: { app: string }) => Record<string, unknown>;
    t.handlers["app.info"] = (a: { app: string }) => ({ ...info(a), manifestText: manifests[a.app] });
    let n = 0;
    t.handlers["app.reapply"] = ({ app }: { app: string }) => ({ changed: true, deploy: { app, releaseId: "r9", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: new Date(Date.UTC(2026, 10, 7, 0, 0, ++n)).toISOString() } });
    await t.api.jobs.cascade({ app: "a" });
    await t.api.jobs.idle();
    expect(reapplies(t).length).toBe(3); // b, a, b - and no more
  });

  it("sees references in variables added in the dashboard", async () => {
    const t = await makeApi();
    await create(t);
    deployed(t, "web", BILLING);
    t.handlers["variables.get"] = ({ app }: { app: string }) => ({ variables: app === "web" ? { api: { S3: "@storage:up.url" } } : {} });
    t.handlers["app.reapply"] = () => ({ changed: false, deploy: null });
    t.calls.length = 0;
    await t.request("/v1/storages/up/rotate-keys", { method: "POST", token: t.tokens.admin });
    await t.api.jobs.idle();
    expect(reapplies(t)).toEqual(["web"]);
  });
});
