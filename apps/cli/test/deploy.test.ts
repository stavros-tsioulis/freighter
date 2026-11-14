import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cli, hello, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

let n = 0;
const ok = () => ({ app: "hello", releaseId: "r20261114-101502", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: ["careful"], verified: true, historyAt: `2026-11-14T10:15:0${++n % 10}.000Z` });
const fast = { FREIGHTER_POLL_MS: "50" };

async function setup(handlers: Record<string, (a: any) => unknown> = {}) {
  api = await startApi({ handlers: { "app.deploy": ok, "app.info": () => ({ app: "hello", release: "r1", previous: null, manifestText: "", services: {}, releases: [] }), "app.history": () => ({ entries: [] }), ...handlers } });
  return { env: { ...api.env(api.admin), ...fast }, registry: api.registry };
}
const yaml = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "freighter-cli-app-")), "app.yaml");
  writeFileSync(file, text);
  return file;
};

describe("deploy", () => {
  it("packs a directory, uploads it, waits, and says how it went", async () => {
    const { env, registry } = await setup();
    const r = await cli(["deploy", hello], { env });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/Packing .*hello\s+\d[\d.]* [KM]?B, \d+ files/);
    expect(r.stderr).toMatch(/Deploying hello to 127\.0\.0\.1:\d+/);
    expect(r.stderr).toContain("warning: careful");
    expect(r.stderr).toContain("hello is live on r20261114-101502");
    expect(registry.deployments.list({ app: "hello" })[0]).toMatchObject({ status: "success", source: "api" });
  });

  it("deploys the directory it is in", async () => {
    const { env } = await setup();
    const r = await cli(["deploy"], { env, cwd: hello });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("hello is live");
  });

  it("prints just the id with --no-wait and -q, and JSON with --json", async () => {
    const { env } = await setup();
    const id = (await cli(["deploy", hello, "--no-wait", "-q"], { env })).stdout.trim();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const json = JSON.parse((await cli(["deploy", hello, "--json"], { env })).stdout);
    expect(json).toMatchObject({ app: "hello", status: "success", releaseId: "r20261114-101502" });
    expect((await cli(["deploy", hello, "--json"], { env })).stderr).toBe("warning: careful\n"); // the JSON alone on standard output; the progress is quiet, and a warning still gets through
  });

  it("exits with 5 when the deployment failed, and says why and where the log is", async () => {
    const { env } = await setup({ "app.deploy": () => { throw new Error("web: service is not stable\n  more detail"); } });
    const r = await cli(["deploy", hello], { env });
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/error: deployment [0-9a-f]{8} failed: .*service is not stable/);
    expect(r.stderr).toContain("freighter deployment logs");
    expect(r.stderr).not.toContain("more detail"); // one line; the log has the rest
  });

  it("checks before it acts: --dry-run, a name that doesn't match, a directory with no app", async () => {
    const { env, registry } = await setup();
    const dry = await cli(["deploy", hello, "--dry-run"], { env });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Would create hello .* and upload/);
    expect(registry.deployments.list().length).toBe(0); // nothing was queued
    const mismatch = await cli(["deploy", hello, "--app", "other"], { env });
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain("the app is called hello in app.yaml, not other");
    const empty = await cli(["deploy", mkdtempSync(join(tmpdir(), "freighter-empty-"))], { env });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("no app.yaml in");
    expect((await cli(["deploy", "/nonexistent"], { env })).status).toBe(4);
    expect((await cli(["deploy", hello], { env: api!.env(api!.token("viewer")) })).status).toBe(3);
  });
});

describe("deploy an image", () => {
  it("from flags, or from an app.yaml whose services all run images", async () => {
    const { env, registry } = await setup();
    const byFlag = await cli(["deploy", "--image", "ghcr.io/org/hello:1", "--app", "hello", "--port", "3000"], { env });
    expect(byFlag.status).toBe(0);
    expect(byFlag.stderr).toContain("hello is live");
    const file = yaml("name: hello\nservices:\n  web:\n    image: nginx\n");
    expect((await cli(["deploy", file], { env })).status).toBe(0);
    expect(registry.deployments.list({ app: "hello" })).toHaveLength(2);

    expect((await cli(["deploy", "--image", "ghcr.io/org/hello:1"], { env })).stderr).toContain("--image needs --app");
    expect((await cli(["deploy", "--image", "nginx", "--app", "hello", "--port", "99999"], { env })).status).toBe(2);
    expect((await cli(["deploy", "--image", "Bad Image", "--app", "hello"], { env })).status).toBe(1);
    const commands = yaml("name: hello\nservices:\n  web:\n    command: node x.mjs\n");
    expect((await cli(["deploy", commands], { env })).stderr).toContain("an app.yaml alone can only deploy images");
  });

  it("remembers which registry login to pull with", async () => {
    const { env, registry } = await setup();
    registry.registryCredentials.set({ host: "ghcr.io", username: "me", password: "pw1" });
    registry.registryCredentials.set({ host: "ghcr.io", username: "you", password: "pw2" });
    const file = yaml("name: hello\nservices:\n  web:\n    image: ghcr.io/acme/hello:1\n");
    const ambiguous = await cli(["deploy", file], { env });
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.stderr).toMatch(/several logins/);
    expect((await cli(["deploy", file, "--login", "ghcr.io=you"], { env })).status).toBe(0);
    expect(registry.registryCredentials.appChoices("hello")).toEqual({ "ghcr.io": "you" });
    expect((await cli(["deploy", file, "--login", "ghcr.io"], { env })).status).toBe(2);
  });
});

describe("deploy from Git", () => {
  it("creates the app from the repository, prints what to add to it, and follows the deployment", async () => {
    const { env } = await setup({
      "git.inspect": () => ({ sha: "b".repeat(40), commit: { sha: "b".repeat(40), subject: "ship", author: "Ada" }, hasManifest: true, valid: true, appName: "hello", error: null, buildCommands: [], settings: null }), "git.keygen": () => ({ publicKey: "ssh-ed25519 AAAAcli freighter:hello", fingerprint: "SHA256:cli" }), "git.check": () => ({ sha: "a".repeat(40) }),
      "git.deploy": () => ({ skipped: false, commit: { sha: "b".repeat(40), subject: "ship", author: "Ada" }, buildSeconds: 1, deploy: ok() }),
      "build.log": () => ({ text: "==> building\n", next: 13, done: true }),
    });
    const r = await cli(["deploy", "--git", "git@github.com:org/hello.git"], { env });
    expect(r.stderr).toMatch(/Linked \S+ to git@github\.com:org\/hello\.git/);
    expect(r.stderr).toContain("ssh-ed25519 AAAAcli");
    expect(r.stderr).toMatch(/Webhook for deploys on push/);
    expect(r.stderr).toMatch(/Secret\s+\S+\s+\(shown once\)/);
  });
});

describe("redeploy and rollback", () => {
  it("releases an image app again, and rolls back to the previous release or one named", async () => {
    const { env, registry } = await setup({ "app.rollback": () => ({ app: "hello", from: "r2", to: "r1", verified: true, historyAt: `2026-11-14T12:00:0${++n % 10}.000Z` }) });
    registry.apps.upsert({ name: "hello", server: "local", manifestText: "name: hello\nservices:\n  web:\n    image: nginx\n", currentRelease: "r2", previousRelease: "r1", status: "deployed" });
    expect((await cli(["redeploy", "hello"], { env })).stderr).toContain("hello is live");
    const rb = await cli(["rollback", "hello"], { env });
    expect(rb.status).toBe(0);
    const named = await cli(["rollback", "hello", "r1"], { env });
    expect(named.status).toBe(0);
    expect(api!.calls.filter((c) => c.op === "app.rollback").map((c) => c.args.release ?? null)).toEqual([null, "r1"]);
    const fromDir = await cli(["rollback", "r20261113-174411"], { env, cwd: hello }); // a release id alone means the app in this directory
    expect(fromDir.status).toBe(0);
    expect(api!.calls.filter((c) => c.op === "app.rollback").at(-1)!.args).toMatchObject({ app: "hello", release: "r20261113-174411" });
  });
});
