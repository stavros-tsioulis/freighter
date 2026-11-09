import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { startAgent, type RunningAgent } from "@freighter/agent";
import { makeDeps } from "@freighter/core/testing";
import { APP_YAML, makeRepo } from "@freighter/core/testing/git";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";
import { toWebHandler } from "h3";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentDirectory, createApi } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => agent?.close());

describe("end to end: push webhook -> API -> agent -> fetch, sandboxed build, deploy", () => {
  it("deploys on push, keeps the old release when a build breaks, and logs both", async () => {
    const host = await makeDeps();
    host.deps.dev = true; // builds run directly; the sandbox arguments are covered in the core tests
    host.deps.config.agent.artifactsDir = `${host.root}/spool`;
    agent = await startAgent(host.deps, { socketPath: `${host.root}/run/agent.sock` });

    const registry = openRegistry(":memory:");
    const pki = new PkiStore(`${host.root}/pki`);
    const agents = await createAgentDirectory({ registry, localSocket: agent.socketPath, pki, timeoutMs: 30_000 });
    const api = createApi({ registry, pki, agents, artifactsDir: host.deps.config.agent.artifactsDir, maxUploadBytes: 1_000_000, trustProxy: false, gitAllowLocal: true });
    const handler = toWebHandler(api.app);
    const admin = { authorization: `Bearer ${registry.tokens.create({ name: "admin", role: "admin" }).token}`, "content-type": "application/json" };
    const call = async (path: string, init: RequestInit = {}) => {
      const res = await handler(new Request(`http://x${path}`, init));
      return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
    };

    const build = (cmd: string) => `build:\n  commands:\n    - ${cmd}\n`;
    // the build is part of the app's configuration (taken from app.yaml at the first deploy); what it does depends on files
    const repo = await makeRepo({ "app.yaml": APP_YAML("shop", "") + build("echo compiling && grep -q ok flag.txt && cp version.txt VERSION"), "flag.txt": "ok\n", "version.txt": "v1\n", "server.mjs": "//\n" });

    // admin links the repository
    const linked = await call("/v1/apps/shop/git", { method: "PUT", headers: admin, body: JSON.stringify({ repository: repo.url, branch: "main", provider: "github" }) });
    expect(linked.status).toBe(201);
    expect(linked.json.link.publicKey).toMatch(/^ssh-ed25519 /); // a real key from the real agent
    const secret = linked.json.webhookSecret as string;
    expect(await call("/v1/apps/shop/git/check", { method: "POST", headers: admin, body: "{}" })).toMatchObject({ status: 200, json: { sha: repo.first } });

    const push = async (sha: string) => {
      const body = JSON.stringify({ ref: "refs/heads/main", after: sha });
      return call("/v1/hooks/shop", {
        method: "POST", body,
        headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
      });
    };

    // first push: built and deployed
    const p1 = await push(repo.first);
    expect(p1.status).toBe(202);
    await api.jobs.idle();
    const d1 = (await call(`/v1/deployments/${p1.json.id}`, { headers: admin })).json;
    expect(d1).toMatchObject({ status: "success", trigger: "webhook", commitSha: repo.first, commitSubject: "initial commit", commitAuthor: "Ada Dev" });
    expect(readFileSync(`${host.deps.layout.appsRoot}/shop/current/VERSION`, "utf8")).toBe("v1\n");
    const log1 = (await call(`/v1/deployments/${p1.json.id}/log`, { headers: admin })).json;
    expect(log1.done).toBe(true);
    expect(log1.text).toContain("build finished");

    // the same push delivered again is a no-op
    const again = await push(repo.first);
    await api.jobs.idle();
    expect(registry.deployments.get(again.json.id)).toMatchObject({ status: "success", releaseId: null });
    expect(registry.apps.get("shop")?.currentRelease).toBe(d1.releaseId);

    // a commit whose build fails: the running release is untouched, the log says why
    const bad = await repo.commit({ "flag.txt": "nope\n" }, "break the build");
    const p2 = await push(bad);
    await api.jobs.idle();
    const d2 = registry.deployments.get(p2.json.id)!;
    expect(d2).toMatchObject({ status: "failed", error: "build failed with exit code 1", releaseId: null });
    expect((await call(`/v1/deployments/${p2.json.id}/log`, { headers: admin })).json.text).toContain("compiling");
    expect(registry.apps.get("shop")?.currentRelease).toBe(d1.releaseId);
    expect(readFileSync(`${host.deps.layout.appsRoot}/shop/current/VERSION`, "utf8")).toBe("v1\n");

    // fix it: deploys again, with the new commit recorded
    const fixed = await repo.commit({ "flag.txt": "ok\n", "version.txt": "v2\n" }, "fix the build");
    const p3 = await push(fixed);
    await api.jobs.idle();
    expect(registry.deployments.get(p3.json.id)).toMatchObject({ status: "success", commitSha: fixed, commitSubject: "fix the build", previousRelease: d1.releaseId });
    expect(readFileSync(`${host.deps.layout.appsRoot}/shop/current/VERSION`, "utf8")).toBe("v2\n");
    expect(existsSync(`${host.deps.config.git.buildDir}/${p3.json.id}`)).toBe(false); // build dir cleaned
    expect(registry.gitLinks.get("shop")?.lastDeliveryResult).toBe(`deployed ${fixed.slice(0, 7)}`);

    // the listing shows the story, newest first
    const list = (await call("/v1/apps/shop/deployments?limit=10", { headers: admin })).json.deployments as { status: string; commitSubject: string | null; source: string }[];
    expect(list.filter((d) => d.source === "api").map((d) => [d.status, d.commitSubject])).toEqual([
      ["success", "fix the build"],
      ["failed", null], // the failed build never reported a commit
      ["success", "initial commit"], // the redelivery: nothing new to deploy
      ["success", "initial commit"],
    ]);
  });
});
