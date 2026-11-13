import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApi } from "@freighter/api";
import { openRegistry } from "@freighter/registry";
import { createApp, toNodeListener, useBase } from "h3";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../dist/cli.js");
const hello = join(import.meta.dirname, "../../../examples/hello");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: join(import.meta.dirname, "..") });
const runAsync = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

describe("freighter cli", () => {
  it("validates and renders units", () => {
    expect(run("validate", "-f", `${hello}/app.yaml`).stdout).toContain("ok: hello (web)");
    expect(run("unit", "web", "-f", `${hello}/app.yaml`).stdout).toContain("ExecStart=/usr/bin/env node server.mjs");
  });
  it("deploys into a prefix and reports status", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const d = run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix);
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/deployed hello as r\d{8}-\d{6}/);
    expect(readlinkSync(`${prefix}/srv/apps/hello/current`)).toMatch(/^releases\/r/);
    expect(run("status", "hello", "--prefix", prefix).stdout).toContain("web");
    expect(run("env", "set", "hello", "web", "A=1", "--prefix", prefix).status).toBe(0);
    expect(run("env", "list", "hello", "web", "--prefix", prefix).stdout).toBe("A\n");
  });
  it("keeps the configuration from the first deploy, and changes it with `config set`", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    expect(run("config", "show", "hello", "--prefix", prefix).stderr).toMatch(/no configuration yet/);
    expect(run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix).status).toBe(0);
    expect(run("config", "show", "hello", "--prefix", prefix).stdout).toContain("GREETING: hello");
    const other = join(mkdtempSync(join(tmpdir(), "freighter-cli-")), "app.yaml");
    writeFileSync(other, readFileSync(`${hello}/app.yaml`, "utf8").replace("GREETING: hello", "GREETING: changed"));
    const again = run("deploy", hello, "-f", other, "--prefix", prefix);
    expect(again.status).toBe(0);
    expect(run("config", "show", "hello", "--prefix", prefix).stdout).toContain("GREETING: hello");
    const set = run("config", "set", "hello", "-f", other, "--prefix", prefix);
    expect(set.status).toBe(0);
    expect(set.stdout).toMatch(/configured hello; release r\d{8}-\d{6}/);
    expect(run("config", "show", "hello", "--prefix", prefix).stdout).toContain("GREETING: changed");
  });
  it("lists releases and rolls back", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const deploy = () => run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix);
    expect(deploy().status).toBe(0);
    expect(run("rollback", "hello", "--prefix", prefix).stderr).toContain("no release to roll back to");
    expect(deploy().status).toBe(0);
    const list = run("releases", "hello", "--prefix", prefix).stdout.trim().split("\n");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatch(/^\* r\d{8}-\d{6}(-2)?\s+success/);
    const rb = run("rollback", "hello", "--prefix", prefix);
    expect(rb.status).toBe(0);
    expect(rb.stdout).toContain("rolled back hello:");
    expect(run("releases", "hello", "--prefix", prefix).stdout.trim().split("\n")[1]).toMatch(/^\*/);
  });
  it("routes through haproxy files and switches ports between deploys", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const deploy = () => run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix);
    expect(run("domain", "add", "hello", "hello.example.com=web", "--prefix", prefix).stdout).toContain("saved"); // before the first deploy
    expect(deploy().stdout).toContain("route   hello.example.com");
    const dir = `${prefix}/etc/haproxy/freighter`;
    expect(readFileSync(`${dir}/hostnames.map`, "utf8")).toContain("hello.example.com be_hello_web");
    // Ports are picked at random in the range, so read them back.
    const backend = () => /server app 127\.0\.0\.1:(\d+) /.exec(readFileSync(`${dir}/backends.cfg`, "utf8"))![1]!;
    const first = backend();
    expect(Number(first)).toBeGreaterThanOrEqual(20000);
    expect(deploy().status).toBe(0);
    const second = backend();
    expect(second).not.toBe(first); // a new instance listens on a new port
    expect(run("status", "hello", "--prefix", prefix).stdout).toMatch(new RegExp(`:${second} hello\\.example\\.com`));
    expect(run("haproxy", "sync", "--prefix", prefix).stdout).toContain("1 route(s)");
    expect(run("certs", "status", "--prefix", prefix).stdout).toContain("hello.example.com");
  });
  it("manages domains on a deployed app", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    expect(run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix).status).toBe(0);
    expect(run("domain", "list", "hello", "--prefix", prefix).stdout).toContain("no domains");
    const add = run("domain", "add", "hello", "hello.example.com=web:off", "--prefix", prefix);
    expect(add.stdout).toMatch(/applied to hello as r\d{8}-\d{6}/);
    expect(run("domain", "list", "hello", "--prefix", prefix).stdout).toContain("hello.example.com -> web  tls off");
    expect(readFileSync(`${prefix}/etc/haproxy/freighter/hostnames.map`, "utf8")).toContain("hello.example.com be_hello_web");
    expect(run("domain", "add", "hello", "x.example.com", "--prefix", prefix).stderr).toContain("say which service");
    expect(run("domain", "add", "hello", "x.example.com=nope", "--prefix", prefix).stderr).toContain('service "nope"');
    const releases = run("releases", "hello", "--prefix", prefix).stdout.trim().split("\n").length;
    const removed = run("domain", "remove", "hello", "hello.example.com", "--prefix", prefix);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain("routing updated; the app was not redeployed");
    expect(run("releases", "hello", "--prefix", prefix).stdout.trim().split("\n")).toHaveLength(releases); // no new release
    expect(run("domain", "list", "hello", "--prefix", prefix).stdout).toContain("no domains");
    expect(readFileSync(`${prefix}/etc/haproxy/freighter/hostnames.map`, "utf8")).not.toContain("hello.example.com");
  });
  it("deletes an app from this server, and won't without --yes when there is nobody to ask", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    expect(run("deploy", hello, "-f", `${hello}/app.yaml`, "--prefix", prefix).status).toBe(0);
    expect(run("domain", "add", "hello", "hello.example.com=web:off", "--prefix", prefix).status).toBe(0);
    const refused = run("app", "delete", "hello", "--local", "--prefix", prefix); // no terminal to ask on
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    expect(existsSync(`${prefix}/srv/apps/hello`)).toBe(true);

    const gone = run("app", "delete", "hello", "--local", "--yes", "--prefix", prefix);
    expect(gone.status).toBe(0);
    expect(gone.stdout).toContain("deleted hello");
    expect(gone.stdout).toContain("hello.example.com");
    expect(existsSync(`${prefix}/srv/apps/hello`)).toBe(false);
    expect(readFileSync(`${prefix}/etc/haproxy/freighter/hostnames.map`, "utf8")).not.toContain("hello.example.com");
    expect(run("app", "delete", "hello", "--local", "--yes", "--prefix", prefix).stderr).toContain('unknown app "hello"');
    expect(run("app", "delete", "Bad Name", "--local", "--yes", "--prefix", prefix).stderr).toContain("invalid app name");
  });
  it("deploys an image-only app into a prefix without an artifact, and prints its unit", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const dir = mkdtempSync(join(tmpdir(), "freighter-img-"));
    const file = join(dir, "app.yaml");
    writeFileSync(file, "name: shop\nservices:\n  web:\n    image: ghcr.io/org/shop:1\n    port: 3000\n    containerPort: 8080\n");
    const unit = run("unit", "web", "-f", file).stdout;
    expect(unit).toContain("ExecStart=/usr/bin/podman --cgroup-manager=cgroupfs run --rm --replace --name freighter-shop--web");
    expect(unit).toContain("-p 127.0.0.1:3000:8080");
    const d = run("deploy", "-f", file, "--prefix", prefix);
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/deployed shop as r\d{8}-\d{6}/);
    expect(readFileSync(`${prefix}/srv/apps/shop/current/.freighter-images.json`, "utf8")).toContain("ghcr.io/org/shop:1");
    expect(run("deploy", "-f", `${hello}/app.yaml`, "--prefix", prefix).stderr).toContain("an artifact is required");
  });
  it("prints the haproxy setup snippet", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const out = run("haproxy", "setup", "--prefix", prefix).stdout;
    expect(out).toContain("use_backend freighter_acme if freighter_acme");
    expect(out).toContain(`bind :443 ssl crt ${prefix}/etc/haproxy/freighter/certs/`);
  });
  it("fails cleanly", () => {
    const r = run("validate", "-f", "/nonexistent.yaml");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read manifest");
    expect(run("rollback", "ghost", "--prefix", mkdtempSync(join(tmpdir(), "freighter-cli-"))).stderr).toContain("not deployed");
    expect(run("deploy", hello, "-f", `${hello}/app.yaml`).stderr).toContain("must run as root");
  });
});

describe("api tokens", () => {
  it("creates, lists and revokes tokens in the prefix registry", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const made = run("token", "create", "--name", "ci", "--role", "deployer", "--prefix", prefix);
    expect(made.status).toBe(0);
    const token = /fr_[A-Za-z0-9_-]{43}/.exec(made.stdout)?.[0];
    const id = /tok_[0-9a-f]{12}/.exec(made.stdout)?.[0];
    expect(token && id).toBeTruthy();
    const list = run("token", "list", "--prefix", prefix).stdout;
    expect(list).toContain(id!);
    expect(list).not.toContain(token!);
    expect(run("token", "create", "--name", "x", "--role", "root", "--prefix", prefix).stderr).toContain("invalid role");
    expect(run("token", "revoke", id!, "--prefix", prefix).status).toBe(0);
    expect(run("token", "revoke", id!, "--prefix", prefix).status).toBe(1);
  });
});

describe("freighter push", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function startApi(deploy: () => unknown, role: "admin" | "deployer" = "deployer") {
    const registry = openRegistry(":memory:");
    const spool = mkdtempSync(join(tmpdir(), "freighter-spool-"));
    const agent = {
      async call(op: string) {
        if (op === "ping") return { version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images"] };
        if (op === "app.deploy") return deploy();
        if (op === "app.info") return { app: "hello", release: "r1", previous: null, manifestText: "", services: {}, releases: [] };
        if (op === "app.history") return { entries: [] };
        if (op === "app.delete") return { app: "hello", units: ["freighter-hello--web.service"], hostnames: ["hello.example.com"] };
        if (op === "git.keygen") return { publicKey: "ssh-ed25519 AAAAcli freighter:hello", fingerprint: "SHA256:cli" };
        if (op === "git.check") return { sha: "a".repeat(40) };
        if (op === "build.log") return { text: "==> building\nbuilt ok\n", next: 22, done: true };
        if (op === "git.deploy")
          return { skipped: false, commit: { sha: "b".repeat(40), subject: "ship", author: "Ada" }, buildSeconds: 1, deploy: { ...(deploy() as object) } };
        throw new Error(`unexpected ${op}`);
      },
    };
    const api = createApi({ registry, agents: { forServer: () => agent as never }, pki: { ensureCa: async () => { throw new Error("not used"); } }, artifactsDir: spool, maxUploadBytes: 10_000_000, trustProxy: false });
    const outer = createApp();
    outer.use(useBase("/api", api.app.handler));
    server = createServer(toNodeListener(outer));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, token: registry.tokens.create({ name: "ci", role }).token, registry };
  }

  const ok = () => ({ app: "hello", releaseId: "r1", previous: null, units: [], removed: [], pruned: [], hostnames: [], warnings: ["careful"], verified: true, historyAt: "2026-11-06T10:00:00.000Z" });

  it("uploads a directory and waits for success", async () => {
    const { url, token, registry } = await startApi(ok);
    const r = await runAsync(["push", hello, "--url", url], { FREIGHTER_TOKEN: token });
    expect(r.stderr).toContain("warning: careful");
    expect(r.stdout).toContain("deployed hello as r1");
    expect(r.status).toBe(0);
    expect(registry.deployments.list({ app: "hello" })[0]).toMatchObject({ status: "success", source: "api" });
  });

  it("deploys an image without uploading anything, from flags or from an app.yaml", async () => {
    let n = 0; // every real deploy writes its own history entry
    const { url, token, registry } = await startApi(() => ({ ...ok(), historyAt: `2026-11-06T10:00:0${++n}.000Z` }));
    const env = { FREIGHTER_TOKEN: token };
    const byFlag = await runAsync(["push", "--image", "ghcr.io/org/hello:1", "--name", "hello", "--port", "3000", "--url", url], env);
    expect(byFlag.stdout).toContain("deployed hello as r1");
    expect(byFlag.status).toBe(0);
    expect(registry.deployments.list({ app: "hello" })[0]).toMatchObject({ status: "success" });

    const dir = mkdtempSync(join(tmpdir(), "freighter-img-"));
    const file = join(dir, "app.yaml");
    writeFileSync(file, "name: hello\nservices:\n  web:\n    image: nginx\n");
    const viaFile = await runAsync(["push", file, "--url", url], env);
    expect(viaFile.stdout).toContain("deployed hello as r1");

    expect((await runAsync(["push", "--image", "ghcr.io/org/hello:1", "--url", url], env)).stderr).toContain("--image needs --name");
    expect((await runAsync(["push", "--image", "Bad Image", "--name", "hello", "--url", url], env)).status).toBe(1);
    expect((await runAsync(["push", "--image", "nginx", "--name", "hello", "--port", "99999", "--url", url], env)).stderr).toContain("invalid --port");
  });

  it("redeploys an app and manages registry logins (admin only)", async () => {
    let n = 0; // every real deploy writes its own history entry
    const { url, token, registry } = await startApi(() => ({ ...ok(), historyAt: `2026-11-06T10:00:0${++n}.000Z` }), "admin");
    const env = { FREIGHTER_TOKEN: token };
    registry.apps.upsert({ name: "hello", server: "local", manifestText: "name: hello\nservices:\n  web:\n    image: nginx\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    expect((await runAsync(["redeploy", "hello", "--url", url], env)).stdout).toContain("deployed hello as r1");

    const add = await runAsync(["registry", "add", "ghcr.io", "--username", "me", "--password", "s3cret", "--url", url], env);
    expect(add.stdout).toContain("saved the login for ghcr.io");
    const list = await runAsync(["registry", "list", "--url", url], env);
    expect(list.stdout).toContain("ghcr.io  me");
    expect(list.stdout).not.toContain("s3cret");
    expect(registry.registryCredentials.secret("ghcr.io", "me")?.password).toBe("s3cret");

    // a second account on the same registry: the app is told which one to pull with, and removal has to say which
    await runAsync(["registry", "add", "ghcr.io", "--username", "you", "--password", "pw2", "--url", url], env);
    expect((await runAsync(["registry", "list", "--url", url], env)).stdout).toMatch(/ghcr\.io {2}me[\s\S]*ghcr\.io {2}you/);
    const dir = mkdtempSync(join(tmpdir(), "freighter-img-"));
    const file = join(dir, "app.yaml");
    writeFileSync(file, "name: hello\nservices:\n  web:\n    image: ghcr.io/acme/hello:1\n");
    const ambiguous = await runAsync(["push", file, "--url", url], env);
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toMatch(/several logins \(me, you\)/);
    expect((await runAsync(["push", file, "--login", "ghcr.io=you", "--url", url], env)).stdout).toContain("deployed hello as r1");
    expect(registry.registryCredentials.appChoices("hello")).toEqual({ "ghcr.io": "you" });
    expect((await runAsync(["push", file, "--login", "ghcr.io", "--url", url], env)).stderr).toContain("--login takes host=username");
    expect((await runAsync(["registry", "remove", "ghcr.io", "--url", url], env)).stderr).toMatch(/several logins/);
    expect((await runAsync(["registry", "remove", "ghcr.io", "--username", "you", "--url", url], env)).stdout).toContain("removed the login for ghcr.io (you)");
    expect((await runAsync(["registry", "remove", "ghcr.io", "--url", url], env)).stdout).toContain("removed the login for ghcr.io");
  });

  it("deletes an app through the API, and only for an admin who types --yes", async () => {
    const { url, token, registry } = await startApi(() => ({}), "admin");
    registry.apps.upsert({ name: "hello", server: "local", manifestText: "name: hello\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
    const noTty = await runAsync(["app", "delete", "hello", "--url", url, "--token", token]);
    expect(noTty.status).toBe(1);
    expect(noTty.stderr).toContain("pass --yes");
    expect(registry.apps.get("hello")).toBeDefined();

    const ok = await runAsync(["app", "delete", "hello", "--yes", "--url", url, "--token", token]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("deleted hello from local: 1 unit(s) removed, no longer routing hello.example.com");
    expect(registry.apps.get("hello")).toBeUndefined();

    const again = await runAsync(["app", "delete", "hello", "--yes", "--url", url, "--token", token]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("404");
  });
  it("exits 1 with the failure reason when the deployment fails", async () => {
    const { url, token } = await startApi(() => {
      throw new Error("boom");
    });
    const r = await runAsync(["push", hello, "--url", url, "--token", token]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("boom");
  });

  it("reports bad credentials and missing config", async () => {
    const { url } = await startApi(ok);
    expect((await runAsync(["push", hello, "--url", url, "--token", "fr_nope"])).stderr).toMatch(/upload failed \(401\)/);
    expect((await runAsync(["push", hello], { FREIGHTER_URL: "", FREIGHTER_TOKEN: "" })).stderr).toContain("no API URL");
  });

  it("links a repository, prints the setup, checks it, deploys from it and unlinks", async () => {
    const { url, token, registry } = await startApi(ok, "admin");
    const env = { FREIGHTER_TOKEN: token };
    const linked = await runAsync(["git", "link", "hello", "--repo", "git@github.com:acme/hello.git", "--branch", "main", "--url", url], env);
    expect(linked.status).toBe(0);
    expect(linked.stdout).toContain("ssh-ed25519 AAAAcli freighter:hello");
    expect(linked.stdout).toMatch(/Secret [0-9a-f]{64}/);
    expect(linked.stdout).toContain("/api/v1/hooks/hello");

    expect((await runAsync(["git", "show", "hello", "--url", url], env)).stdout).toContain("repository   git@github.com:acme/hello.git");
    expect((await runAsync(["git", "check", "hello", "--url", url], env)).stdout).toContain(`ok: branch head ${"a".repeat(40)}`);

    const deployed = await runAsync(["git", "deploy", "hello", "--url", url], env);
    expect(deployed.stdout).toContain("built ok");
    expect(deployed.stdout).toContain("deployed hello as r1");
    expect(registry.deployments.list({ app: "hello" })[0]).toMatchObject({ trigger: "manual", commitSubject: "ship", status: "success" });

    expect((await runAsync(["git", "rotate-secret", "hello", "--url", url], env)).stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect((await runAsync(["git", "unlink", "hello", "--url", url], env)).stdout).toContain("unlinked hello");
    expect((await runAsync(["git", "show", "hello", "--url", url], env)).status).toBe(1);
  });

  it("explains missing configuration and rejects unsafe repositories", async () => {
    const { url, token } = await startApi(ok, "admin");
    expect((await runAsync(["git", "show", "hello"], { FREIGHTER_URL: "", FREIGHTER_TOKEN: "" })).stderr).toContain("no API URL");
    const bad = await runAsync(["git", "link", "hello", "--repo", "--upload-pack=x", "--url", url], { FREIGHTER_TOKEN: token });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/400/);
  });
});

describe("freighter server", () => {
  it("adds, lists, re-tokens and removes a remote server", () => {
    const prefix = mkdtempSync(join(tmpdir(), "freighter-cli-"));
    const added = run("server", "add", "vps-1", "--address", "vps1.example.com", "--control", "https://fr.example.com", "--prefix", prefix);
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/freighter-agent enroll --control https:\/\/fr\.example\.com --token fre_[A-Za-z0-9_-]+ --ca-fingerprint SHA256:([0-9A-F]{2}:){31}[0-9A-F]{2}/);

    const list = run("server", "list", "--prefix", prefix).stdout;
    expect(list).toMatch(/^local\s+online/m);
    expect(list).toMatch(/^vps-1\s+pending\s+vps1\.example\.com/m);
    expect(run("server", "add", "vps-1", "--address", "x.example.com", "--prefix", prefix).stderr).toContain("already exists");
    expect(run("server", "add", "local", "--address", "x.example.com", "--prefix", prefix).stderr).toContain("invalid server name");
    expect(run("server", "token", "vps-1", "--prefix", prefix).stdout).toContain("fre_");
    expect(run("server", "token", "ghost", "--prefix", prefix).status).toBe(1);
    expect(run("server", "remove", "local", "--prefix", prefix).stderr).toContain("cannot be removed");
    expect(run("server", "remove", "vps-1", "--prefix", prefix).status).toBe(0);
    expect(run("server", "list", "--prefix", prefix).stdout).not.toContain("vps-1");
  });
});
