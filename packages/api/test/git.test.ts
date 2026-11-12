import { createHmac } from "node:crypto";
import { AgentError } from "@freighter/protocol";
import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof makeApi>>;
const REPO = "git@github.com:acme/shop.git";
const SHA = "c".repeat(40);

async function link(t: Api, over: Record<string, unknown> = {}, app = "shop") {
  return t.request(`/v1/apps/${app}/git`, {
    method: "PUT", token: t.tokens.admin,
    json: { repository: REPO, branch: "main", provider: "github", autoDeploy: true, ...over },
    headers: { host: "freighter.example.com", "x-forwarded-proto": "https" },
  });
}
const pushBody = (o: Record<string, unknown> = {}) => JSON.stringify({ ref: "refs/heads/main", after: SHA, deleted: false, head_commit: { message: "x" }, ...o });
const gh = (secret: string, body: string, event = "push") => ({ "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` });
async function hook(t: Api, body: string, headers: Record<string, string>, app = "shop", ip?: string) {
  return t.request(`/v1/hooks/${app}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers }, ip });
}
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("linking a repository", () => {
  it("creates the link once, pins the app, creates the deploy key, and shows the secret only at creation", async () => {
    const t = await makeApi();
    const r = await link(t);
    expect(r.status).toBe(201);
    expect(r.json.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.link).toMatchObject({
      app: "shop", provider: "github", repository: REPO, branch: "main", autoDeploy: true,
      publicKey: "ssh-ed25519 AAAAfakekey freighter:app", keyFingerprint: "SHA256:fakefingerprint",
      webhookUrl: "https://freighter.example.com/api/v1/hooks/shop",
    });
    expect(t.calls.find((c) => c.op === "git.keygen")?.args).toEqual({ app: "shop" });
    expect(t.registry.apps.get("shop")?.server).toBe("local");

    const again = await link(t, { branch: "release" });
    expect(again.status).toBe(200);
    expect(again.json.webhookSecret).toBeUndefined();
    expect(again.json.link.branch).toBe("release");

    const got = await t.request("/v1/apps/shop/git", { token: t.tokens.viewer });
    expect(JSON.stringify(got.json)).not.toContain(r.json.webhookSecret);
    expect(JSON.stringify(t.registry.audit.list())).not.toContain(r.json.webhookSecret);
    expect((await t.request("/v1/apps/ghost/git", { token: t.tokens.viewer })).status).toBe(404);
  });

  it("enforces roles", async () => {
    const t = await makeApi();
    expect((await t.request("/v1/apps/shop/git", { method: "PUT", token: t.tokens.deployer, json: { repository: REPO } })).status).toBe(403);
    await link(t);
    expect((await t.request("/v1/apps/shop/git", { token: t.tokens.viewer })).status).toBe(200);
    for (const [method, path] of [["PATCH", "/v1/apps/shop/git"], ["DELETE", "/v1/apps/shop/git"], ["POST", "/v1/apps/shop/git/rotate-secret"], ["POST", "/v1/apps/shop/git/rotate-key"]] as const) {
      expect((await t.request(path, { method, token: t.tokens.deployer, json: {} })).status, `${method} ${path}`).toBe(403);
    }
    expect((await t.request("/v1/apps/shop/git/check", { method: "POST", token: t.tokens.viewer, json: {} })).status).toBe(403);
    expect((await t.request("/v1/apps/shop/git/deploy", { method: "POST", token: t.tokens.viewer, json: {} })).status).toBe(403);
    expect((await t.request("/v1/apps/shop/git/check", { method: "POST", token: t.tokens.deployer, json: {} })).json).toEqual({ sha: "a".repeat(40) });
    await t.api.jobs.idle();
  });

  it("rejects unsafe or malformed repository settings", async () => {
    const t = await makeApi();
    for (const repository of ["--upload-pack=x", "ext::sh -c id", "file:///etc", "/srv/repo.git", "http://github.com/a/b", ""]) {
      expect((await link(t, { repository })).status, repository).toBe(400);
    }
    expect((await link(t, { branch: "-x" })).status).toBe(400);
    expect((await link(t, { subpath: "../x" })).status).toBe(400);
    expect((await link(t, { provider: "bitbucket" })).status).toBe(400);
    expect((await link(t, {}, "Bad_App")).status).toBe(400);
    expect(t.calls.some((c) => c.op === "git.keygen")).toBe(false); // nothing reached the agent
    t.ctx.gitAllowLocal = true;
    expect((await link(t, { repository: "/srv/git/demo.git" })).status).toBe(201); // lab setting
  });

  it("links to a chosen server, and refuses to move a pinned app", async () => {
    const t = await makeApi();
    await t.request("/v1/servers", { method: "POST", token: t.tokens.admin, json: { name: "vps-1", address: "v.example.com" } });
    expect((await link(t, { server: "vps-1" })).status).toBe(409); // not enrolled yet
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    expect((await link(t, { server: "vps-1" })).status).toBe(201);
    expect(t.registry.apps.get("shop")?.server).toBe("vps-1");
    expect(t.remote("vps-1").calls.some((c) => c.op === "git.keygen")).toBe(true);
    expect((await link(t, { server: "local" })).json.error.code).toBe("pinned_to_other_server");
    expect((await link(t, { server: "ghost" }, "blog")).status).toBe(404);
  });

  it("updates, rotates and unlinks", async () => {
    const t = await makeApi();
    const created = await link(t);
    const patch = await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { branch: "release", autoDeploy: false } });
    expect(patch.json).toMatchObject({ branch: "release", autoDeploy: false, repository: REPO });
    expect((await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { repository: "--evil" } })).status).toBe(400);

    const rot = await t.request("/v1/apps/shop/git/rotate-secret", { method: "POST", token: t.tokens.admin, json: {} });
    expect(rot.json.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(rot.json.webhookSecret).not.toBe(created.json.webhookSecret);

    t.handlers["git.keygen"] = () => ({ publicKey: "ssh-ed25519 AAAAnewkey", fingerprint: "SHA256:new" });
    const key = await t.request("/v1/apps/shop/git/rotate-key", { method: "POST", token: t.tokens.admin, json: {} });
    expect(key.json).toMatchObject({ publicKey: "ssh-ed25519 AAAAnewkey", keyFingerprint: "SHA256:new" });
    expect(t.calls.filter((c) => c.op === "git.keygen").at(-1)?.args).toEqual({ app: "shop", rotate: true });

    expect((await t.request("/v1/apps/shop/git", { method: "DELETE", token: t.tokens.admin })).json).toEqual({ ok: true });
    expect((await t.request("/v1/apps/shop/git", { method: "DELETE", token: t.tokens.admin })).status).toBe(404);
  });
});

describe("GitHub webhooks", () => {
  async function linked(over: Record<string, unknown> = {}) {
    const t = await makeApi();
    const r = await link(t, over);
    return { t, secret: r.json.webhookSecret as string };
  }

  it("a signed push to the linked branch deploys it, recording the commit", async () => {
    const { t, secret } = await linked();
    const body = pushBody();
    const r = await hook(t, body, gh(secret, body));
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ok: true, status: "queued", coalesced: false });
    await t.api.jobs.idle();

    const row = t.registry.deployments.get(r.json.id)!;
    expect(row).toMatchObject({
      status: "success", trigger: "webhook", requestedBy: null, releaseId: "r7", previousRelease: "r6",
      commitSha: "b".repeat(40), commitSubject: "fix the bug", commitAuthor: "Ada", historyAt: expect.stringMatching(/^2026-11-06T14:00:\d\d\.000Z$/),
    });
    const call = t.calls.find((c) => c.op === "git.deploy")!;
    expect(call.args).toEqual({ app: "shop", buildId: r.json.id, repository: REPO, branch: "main", subpath: undefined, skipIfUnchanged: true });
    expect(t.registry.gitLinks.get("shop")?.lastDeliveryResult).toBe("deployed bbbbbbb");
    expect(t.registry.deployments.getLog(r.json.id)).toBe("==> building\nbuilt ok\n"); // kept with the deployment
  });

  it("rejects missing, wrong and mismatched signatures, and rate-limits the repeat offenders", async () => {
    const { t, secret } = await linked();
    const body = pushBody();
    expect((await hook(t, body, {})).status).toBe(401);
    expect((await hook(t, body, gh("wrong-secret", body))).status).toBe(401);
    expect((await hook(t, body, gh(secret, pushBody({ after: "d".repeat(40) })))).status).toBe(401); // signed a different body
    expect((await hook(t, body, { "x-github-event": "push", "x-hub-signature-256": "sha256=" })).status).toBe(401);
    expect(t.calls.some((c) => c.op === "git.deploy")).toBe(false);
    for (let i = 0; i < 10; i++) await hook(t, body, gh("nope", body), "shop", "5.5.5.5");
    expect((await hook(t, body, gh(secret, body), "shop", "5.5.5.5")).status).toBe(429);
    expect((await hook(t, body, gh(secret, body), "shop", "6.6.6.6")).status).toBe(202); // other addresses are unaffected
    await t.api.jobs.idle();
  });

  it("acknowledges but ignores everything that should not deploy", async () => {
    const { t, secret } = await linked();
    const cases: [string, string, string, string][] = [
      ["ping", "{}", "ping", "ping"],
      ["a pull request event", "{}", "pull_request", 'event "pull_request" is not a push'],
      ["another branch", pushBody({ ref: "refs/heads/dev" }), "push", "branch dev is not main"],
      ["a tag", pushBody({ ref: "refs/tags/v1" }), "push", "not a branch push"],
      ["a deleted branch", pushBody({ deleted: true, after: "0".repeat(40) }), "push", "branch deleted"],
    ];
    for (const [name, body, event, reason] of cases) {
      const r = await hook(t, body, gh(secret, body, event));
      expect([r.status, r.json.ignored], name).toEqual([200, reason]);
    }
    expect(t.calls.some((c) => c.op === "git.deploy")).toBe(false);
    expect(t.registry.gitLinks.get("shop")?.lastDeliveryResult).toBe("ignored: branch deleted");
    expect(t.registry.deployments.list()).toEqual([]);
  });

  it("honours auto-deploy being off, bad JSON, unknown apps and unsupported providers", async () => {
    const off = await linked({ autoDeploy: false });
    const body = pushBody();
    expect((await hook(off.t, body, gh(off.secret, body))).json.ignored).toBe("auto-deploy is off");

    const { t, secret } = await linked();
    const bad = "{not json";
    expect((await hook(t, bad, gh(secret, bad))).status).toBe(400);
    expect((await hook(t, body, gh(secret, body), "ghost")).status).toBe(404);
    expect((await hook(t, body, gh(secret, body), "Bad_Name")).status).toBe(404);

    const other = await makeApi();
    await link(other, { provider: "other" });
    expect((await hook(other, body, gh("x", body))).status).toBe(400);
  });

  it("only deploys the branch it is linked to, and follows PATCH", async () => {
    const { t, secret } = await linked();
    await t.request("/v1/apps/shop/git", { method: "PATCH", token: t.tokens.admin, json: { branch: "release" } });
    const old = pushBody();
    expect((await hook(t, old, gh(secret, old))).json.ignored).toBe("branch main is not release");
    const fresh = pushBody({ ref: "refs/heads/release" });
    expect((await hook(t, fresh, gh(secret, fresh))).status).toBe(202);
    await t.api.jobs.idle();
    expect((t.calls.find((c) => c.op === "git.deploy")!.args as { branch: string }).branch).toBe("release");
  });

  it("a rotated secret replaces the old one; unlinking removes the hook", async () => {
    const { t, secret } = await linked();
    const fresh = (await t.request("/v1/apps/shop/git/rotate-secret", { method: "POST", token: t.tokens.admin, json: {} })).json.webhookSecret as string;
    const body = pushBody();
    expect((await hook(t, body, gh(secret, body))).status).toBe(401);
    expect((await hook(t, body, gh(fresh, body))).status).toBe(202);
    await t.api.jobs.idle();
    await t.request("/v1/apps/shop/git", { method: "DELETE", token: t.tokens.admin });
    expect((await hook(t, body, gh(fresh, body))).status).toBe(404);
  });
});

describe("GitLab webhooks", () => {
  it("authenticates with the secret token and understands Push Hook payloads", async () => {
    const t = await makeApi();
    const secret = (await link(t, { provider: "gitlab", repository: "git@gitlab.com:acme/shop.git" })).json.webhookSecret as string;
    const body = JSON.stringify({ ref: "refs/heads/main", after: SHA, checkout_sha: SHA });
    const headers = { "x-gitlab-event": "Push Hook" };

    expect((await hook(t, body, { ...headers, "x-gitlab-token": "wrong" })).status).toBe(401);
    expect((await hook(t, body, headers)).status).toBe(401);
    expect((await hook(t, body, { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret })).json.ignored).toMatch(/not a push/);
    const gone = JSON.stringify({ ref: "refs/heads/main", after: "0".repeat(40), checkout_sha: null });
    expect((await hook(t, gone, { ...headers, "x-gitlab-token": secret })).json.ignored).toBe("branch deleted");

    const ok = await hook(t, body, { ...headers, "x-gitlab-token": secret });
    expect(ok.status).toBe(202);
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(ok.json.id)?.status).toBe("success");
    // a GitHub-style signature is not accepted for a GitLab link
    expect((await hook(t, body, gh(secret, body))).status).toBe(401);
  });
});

describe("deployment jobs", () => {
  it("folds triggers into the deployment that is already waiting", async () => {
    const t = await makeApi();
    const secret = (await link(t)).json.webhookSecret as string;
    const g = gate();
    t.handlers["git.deploy"] = async () => {
      await g.p;
      return { skipped: false, commit: { sha: "b".repeat(40), subject: "s", author: "a" }, buildSeconds: 1, deploy: { app: "shop", releaseId: "r9", previous: null, units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: "t1" } };
    };
    const send = () => hook(t, pushBody(), gh(secret, pushBody()));

    const first = await send(); // starts running (blocked on the gate)
    await new Promise((r) => setTimeout(r, 20));
    const second = await send(); // nothing is waiting, so this one queues behind the running build
    const third = await send(); // ...and this one joins it
    const fourth = await t.request("/v1/apps/shop/git/deploy", { method: "POST", token: t.tokens.deployer, json: {} }); // so does a manual deploy
    expect([first.json.coalesced, second.json.coalesced, third.json.coalesced, fourth.json.coalesced]).toEqual([false, false, true, true]);
    expect(third.json.id).toBe(second.json.id);
    expect(fourth.json.id).toBe(second.json.id);
    expect(second.json.id).not.toBe(first.json.id);

    g.open();
    await t.api.jobs.idle();
    expect(t.registry.deployments.list({ app: "shop" }).filter((d) => d.source === "api")).toHaveLength(2); // the sync also imports host history
    expect(t.calls.filter((c) => c.op === "git.deploy")).toHaveLength(2);
    // once nothing is waiting a new push starts a fresh deployment again
    expect((await send()).json.coalesced).toBe(false);
    await t.api.jobs.idle();
  });

  it("records an unchanged head as a successful no-op", async () => {
    const t = await makeApi();
    const secret = (await link(t)).json.webhookSecret as string;
    t.handlers["git.deploy"] = () => ({ skipped: true, commit: { sha: "b".repeat(40), subject: "same", author: "Ada" }, buildSeconds: 0 });
    const r = await hook(t, pushBody(), gh(secret, pushBody()));
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success", releaseId: null, commitSha: "b".repeat(40), warnings: ["already deployed: the branch has no new commits"] });
    expect(t.registry.gitLinks.get("shop")?.lastDeliveryResult).toBe("up to date at bbbbbbb");
  });

  it("records build failures with their log, and keeps the previous deployment intact", async () => {
    const t = await makeApi();
    const secret = (await link(t)).json.webhookSecret as string;
    t.handlers["git.deploy"] = () => {
      throw new AgentError("build_failed", "build failed with exit code 3", { logTail: "boom" });
    };
    t.handlers["build.log"] = () => ({ text: "==> building\nerror: boom\n==> build failed with exit code 3\n", next: 60, done: true });
    const r = await hook(t, pushBody(), gh(secret, pushBody()));
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "failed", error: "build failed with exit code 3", releaseId: null });
    expect(t.registry.gitLinks.get("shop")?.lastDeliveryResult).toBe("failed: build failed with exit code 3");

    const log = await t.request(`/v1/deployments/${r.json.id}/log`, { token: t.tokens.deployer });
    expect(log.json).toMatchObject({ done: true });
    expect(log.json.text).toContain("error: boom");
    expect((await t.request(`/v1/deployments/${r.json.id}/log?from=5`, { token: t.tokens.deployer })).json.text.startsWith("uilding")).toBe(true); // offsets are honoured
  });

  it("serves the log live while a build runs, then from storage", async () => {
    const t = await makeApi();
    await link(t);
    const g = gate();
    t.handlers["git.deploy"] = async () => {
      await g.p;
      throw new AgentError("build_failed", "build failed with exit code 1");
    };
    let served = "line one\n";
    t.handlers["build.log"] = ({ from }: { from: number }) => ({ text: served.slice(from), next: served.length, done: false });
    const r = await t.request("/v1/apps/shop/git/deploy", { method: "POST", token: t.tokens.deployer, json: {} });
    await new Promise((x) => setTimeout(x, 20));

    const first = await t.request(`/v1/deployments/${r.json.id}/log`, { token: t.tokens.deployer });
    expect(first.json).toEqual({ text: "line one\n", next: 9, done: false });
    served += "line two\n";
    const next = await t.request(`/v1/deployments/${r.json.id}/log?from=9`, { token: t.tokens.deployer });
    expect(next.json).toEqual({ text: "line two\n", next: 18, done: false });

    g.open();
    await t.api.jobs.idle();
    const done = await t.request(`/v1/deployments/${r.json.id}/log`, { token: t.tokens.deployer });
    expect(done.json).toMatchObject({ done: true, text: "line one\nline two\n" });
    expect((await t.request(`/v1/deployments/${r.json.id}/log`, { token: t.tokens.viewer })).status).toBe(403);
    expect((await t.request("/v1/deployments/nope/log", { token: t.tokens.deployer })).status).toBe(404);
  });

  it("a slow build on one server does not hold up another", async () => {
    const t = await makeApi();
    await t.request("/v1/servers", { method: "POST", token: t.tokens.admin, json: { name: "vps-1", address: "v.example.com" } });
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    await link(t, { server: "vps-1" }, "slowapp");
    const g = gate();
    t.remote("vps-1").handlers["git.deploy"] = async () => {
      await g.p;
      return { skipped: true, commit: { sha: "b".repeat(40), subject: "s", author: "a" }, buildSeconds: 0 };
    };
    const slow = await t.request("/v1/apps/slowapp/git/deploy", { method: "POST", token: t.tokens.deployer, json: {} });

    const upload = await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() });
    for (let i = 0; i < 100 && t.registry.deployments.get(upload.json.id)?.status !== "success"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(t.registry.deployments.get(upload.json.id)?.status).toBe("success"); // finished while vps-1 is still building
    expect(t.registry.deployments.get(slow.json.id)?.status).toBe("running");
    g.open();
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(slow.json.id)?.status).toBe("success");
  });

  it("runs the build on the app's own server", async () => {
    const t = await makeApi();
    await t.request("/v1/servers", { method: "POST", token: t.tokens.admin, json: { name: "vps-1", address: "v.example.com" } });
    t.registry.servers.setCert("vps-1", "SHA256:AA", "2027-01-01T00:00:00.000Z");
    await link(t, { server: "vps-1" });
    const r = await t.request("/v1/apps/shop/git/deploy", { method: "POST", token: t.tokens.deployer, json: {} });
    await t.api.jobs.idle();
    expect(t.remote("vps-1").calls.some((c) => c.op === "git.deploy")).toBe(true);
    expect(t.calls.some((c) => c.op === "git.deploy")).toBe(false);
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ server: "vps-1", trigger: "manual", requestedBy: expect.stringMatching(/^tok_/) });
  });
});

describe("saving settings of an app built from Git", () => {
  const withBuild = (cmd: string) => ({ build: { commands: [cmd] }, services: { web: { command: "node server.mjs" } } });
  it("builds again with new build commands, saving the configuration first, and only redeploys for anything else", async () => {
    const t = await makeApi();
    t.registry.apps.upsert({ name: "shop", server: "local", manifestText: "name: shop\nbuild:\n  commands:\n    - npm ci\nservices:\n    web:\n      command: node server.mjs\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    t.handlers["app.config.get"] = () => ({ manifestText: "name: shop\nbuild:\n  commands:\n    - npm ci\nservices:\n  web:\n    command: node server.mjs\n" });
    expect((await link(t)).status).toBe(201);
    const put = (settings: unknown) => t.request("/v1/apps/shop/config", { method: "PUT", token: t.tokens.admin, json: { settings } });

    const rebuilt = await put(withBuild("npm ci && npm run build"));
    expect(rebuilt.status).toBe(202);
    expect(rebuilt.json.rebuild).toBe(true);
    await t.api.jobs.idle();
    const deploy = t.calls.find((c) => c.op === "git.deploy")!.args as { configText: string; skipIfUnchanged?: boolean };
    expect(deploy.configText).toContain("npm run build");
    expect(deploy.skipIfUnchanged).toBeFalsy();
    expect(t.calls.some((c) => c.op === "app.config.set")).toBe(false);

    t.calls.length = 0;
    const same = await put({ build: { commands: ["npm ci"] }, services: { web: { command: "node other.mjs" } } });
    expect(same.json.rebuild).toBe(false);
    await t.api.jobs.idle();
    expect(t.calls.some((c) => c.op === "git.deploy")).toBe(false);
    expect(t.calls.some((c) => c.op === "app.config.set")).toBe(true);
  });
});
