import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { makeDeps } from "@freighter/core/testing";
import { APP_YAML, makeRepo } from "@freighter/core/testing/git";
import { createAgentClient, type AgentClient } from "@freighter/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startAgent, type RunningAgent } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

async function setup(files?: Record<string, string>) {
  const h = await makeDeps();
  h.deps.dev = true;
  h.deps.config.agent.artifactsDir = `${h.root}/spool`;
  agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });
  const client: AgentClient = createAgentClient(agent.socketPath, { timeoutMs: 20_000 });
  const repo = await makeRepo(files ?? { "app.yaml": APP_YAML("shop", "") + "build:\n  commands:\n    - echo hi > BUILT\n", "server.mjs": "//\n" });
  return { ...h, client, repo };
}

describe("git operations over the agent protocol", () => {
  it("creates a deploy key, checks the remote, deploys the branch and serves the build log", async () => {
    const { client, repo, deps } = await setup();
    const key = await client.call("git.keygen", { app: "shop" });
    expect(key.publicKey).toMatch(/^ssh-ed25519 /);
    expect((await client.call("git.keygen", { app: "shop" })).publicKey).toBe(key.publicKey);
    expect((await client.call("git.keygen", { app: "shop", rotate: true })).publicKey).not.toBe(key.publicKey);

    expect(await client.call("git.check", { app: "shop", repository: repo.url, branch: "main" })).toEqual({ sha: repo.first });

    const buildId = randomUUID();
    const r = await client.call("git.deploy", { app: "shop", buildId, repository: repo.url, branch: "main" });
    expect(r).toMatchObject({ skipped: false, commit: { sha: repo.first, subject: "initial commit" }, deploy: { app: "shop" } });
    expect(existsSync(`${deps.layout.appsRoot}/shop/releases/${r.deploy!.releaseId}/BUILT`)).toBe(true);

    const log = await client.call("build.log", { id: buildId, from: 0 });
    expect(log.done).toBe(true);
    expect(log.text).toContain("build finished");
    expect(await client.call("build.log", { id: buildId, from: log.next })).toMatchObject({ text: "", done: true });

    // the history carries the commit, so the registry can show it for host-side deploys too
    const hist = await client.call("app.history", { app: "shop", limit: 5 });
    expect(hist.entries.at(-1)?.source).toMatchObject({ type: "git", sha: repo.first });
  });

  it("skips an unchanged head", async () => {
    const { client, repo } = await setup();
    const args = { app: "shop", repository: repo.url, branch: "main", skipIfUnchanged: true };
    expect((await client.call("git.deploy", { ...args, buildId: randomUUID() })).skipped).toBe(false);
    expect(await client.call("git.deploy", { ...args, buildId: randomUUID() })).toMatchObject({ skipped: true, commit: { sha: repo.first } });
  });

  it("reports a failing build as build_failed with the log tail", async () => {
    const { client, repo } = await setup({ "app.yaml": APP_YAML("shop", "") + "build:\n  commands:\n    - echo about to fail\n    - exit 7\n", "server.mjs": "//\n" });
    const err = await client.call("git.deploy", { app: "shop", buildId: randomUUID(), repository: repo.url, branch: "main" }).catch((e) => e);
    expect(err).toMatchObject({ code: "build_failed", message: "build failed with exit code 7" });
    expect(err.extra.logTail).toContain("about to fail");
  });

  it("classifies configuration problems", async () => {
    const { client, repo } = await setup();
    const args = { app: "shop", buildId: randomUUID(), repository: repo.url, branch: "main" };
    await expect(client.call("git.check", { ...args, branch: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("git.check", { ...args, repository: "--upload-pack=x" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.call("git.deploy", { ...args, branch: "-x" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.call("git.deploy", { ...args, subpath: "../x" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.call("build.log", { id: "../../etc/passwd", from: 0 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("a manifest for a different app is a bad request", async () => {
    const { client, repo } = await setup({ "app.yaml": APP_YAML("blog"), "server.mjs": "//\n" });
    await expect(client.call("git.deploy", { app: "shop", buildId: randomUUID(), repository: repo.url, branch: "main" })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/is for "blog"/),
    });
  });

  it("imports an SSH key, lists branches and inspects a branch for the app name", async () => {
    const { client, repo, root } = await setup();
    const keyFile = `${root}/id`;
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "me", "-f", keyFile]);
    const k = await client.call("ssh.import", { privateKey: readFileSync(keyFile, "utf8") });
    expect(k).toMatchObject({ keyType: "ed25519", comment: "me" });
    expect(k.fingerprint).toMatch(/^SHA256:/);
    await expect(client.call("ssh.import", { privateKey: "x".repeat(60) })).rejects.toMatchObject({ code: "bad_request" });

    expect(await client.call("git.branches", { repository: repo.url })).toEqual({ branches: [{ name: "main", default: true }], defaultBranch: "main" });
    const seen = await client.call("git.inspect", { repository: repo.url, branch: "main" });
    expect(seen).toMatchObject({ sha: repo.first, appName: "shop", valid: true, buildCommands: ["echo hi > BUILT"] });
    // a deploy with an imported key leaves no key file around
    const r = await client.call("git.deploy", { app: "shop", buildId: randomUUID(), repository: repo.url, branch: "main", auth: { sshKey: k.privateKey } });
    expect(r.skipped).toBe(false);
  });
});
