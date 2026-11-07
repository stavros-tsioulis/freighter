import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError, createAgentClient, type AgentClient } from "@freighter/protocol";
import { HC_MANIFEST, makeDeps, routed } from "@freighter/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { startAgent, type RunningAgent } from "../src/index.ts";

let agent: RunningAgent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

async function setup() {
  const h = await makeDeps();
  const spool = `${h.root}/spool`;
  h.deps.config.agent.artifactsDir = spool;
  h.deps.dev = true; // skip chgrp; certs are stubbed in the fake host anyway
  agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });
  const client: AgentClient = createAgentClient(agent.socketPath, { timeoutMs: 10_000 });
  let n = 0;
  /** Build a tarball in the spool dir containing the given files. */
  const tarball = async (files: Record<string, string> = { "server.mjs": "// web\n" }) => {
    const src = await mkdtemp(join(tmpdir(), "freighter-src-"));
    for (const [name, text] of Object.entries(files)) await writeFile(join(src, name), text);
    const out = join(spool, `a${n++}.tar.gz`);
    await mkdir(spool, { recursive: true });
    execFileSync("tar", ["-czf", out, "-C", src, "."]);
    return out;
  };
  return { ...h, client, tarball, spool };
}

describe("agent", () => {
  it("answers ping and lists no apps on a fresh host", async () => {
    const { client } = await setup();
    expect((await client.call("ping", {})).version).toBeTruthy();
    expect(await client.call("apps.list", {})).toEqual({ apps: [] });
  });

  it("reads and changes an app's domains, redeploying the current release", async () => {
    const { client, tarball } = await setup();
    expect(await client.call("domains.get", { app: "shop" })).toEqual({ domains: [] });
    const first = await client.call("app.deploy", { artifact: await tarball(), manifestText: routed().manifestText });
    expect(first.hostnames).toEqual([]);
    const r = await client.call("domains.set", { app: "shop", domains: [{ hostname: "shop.example.com", service: "web", tls: "off" }] });
    expect(r.deploy).toMatchObject({ hostnames: ["shop.example.com"], previous: first.releaseId });
    expect((await client.call("domains.get", { app: "shop" })).domains).toEqual([{ hostname: "shop.example.com", service: "web", tls: "off" }]);
    await expect(client.call("domains.set", { app: "shop", domains: [{ hostname: "x.example.com", service: "nope", tls: "off" }] })).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("deploys, reports info and history, controls and rolls back", async () => {
    const { client, tarball, deps } = await setup();
    // skipVerify is forced in dev mode, so nothing needs to be healthy here
    const a = await client.call("app.deploy", { artifact: await tarball({ v: "1" }), ...routed() });
    expect(a).toMatchObject({ app: "shop", hostnames: ["shop.example.com"], previous: null });
    expect(a.historyAt).toMatch(/^\d{4}-/);
    const b = await client.call("app.deploy", { artifact: await tarball({ v: "2" }), ...routed() });
    expect(b.previous).toBe(a.releaseId);

    expect(await client.call("apps.list", {})).toEqual({ apps: ["shop"] });
    const info = await client.call("app.info", { app: "shop" });
    expect(info.release).toBe(b.releaseId);
    expect(info.previous).toBe(a.releaseId);
    expect(info.services.web).toMatchObject({ port: 20001, hostnames: ["shop.example.com"] });
    expect(info.manifestText).toContain("name: shop");
    expect(info.releases.map((r) => r.id)).toEqual([a.releaseId, b.releaseId]);

    const hist = await client.call("app.history", { app: "shop", limit: 1 });
    expect(hist.entries).toHaveLength(1);
    expect(hist.entries[0]).toMatchObject({ release: b.releaseId, action: "deploy", result: "success" });

    expect((await client.call("app.control", { app: "shop", verb: "restart", service: "web" })).units).toEqual([
      `freighter-shop--web--${b.releaseId}.service`,
    ]);
    expect((await client.call("app.logs", { app: "shop", service: "web", lines: 5 })).text).toContain("boom");
    const rb = await client.call("app.rollback", { app: "shop" });
    expect(rb).toMatchObject({ from: b.releaseId, to: a.releaseId });
    expect(deps.layout.appsRoot).toBeTruthy();
  });

  it("returns a metrics snapshot", async () => {
    const { client, tarball } = await setup();
    expect(await client.call("metrics.snapshot", {})).toEqual({ samples: [] });
    await client.call("app.deploy", { artifact: await tarball(), ...routed() });
    const { samples } = await client.call("metrics.snapshot", {});
    expect(samples.map((x) => x.service)).toEqual(["web", "worker"]);
    expect(samples[0]).toMatchObject({ app: "shop", activeState: "active", memoryBytes: 1024, cpuNanos: 2_000_000_000 });
  });

  it("sets and lists secret names, never values", async () => {
    const { client } = await setup();
    await client.call("env.set", { app: "shop", key: "TOKEN", value: "s3cret" });
    const out = await client.call("env.list", { app: "shop" });
    expect(out).toEqual({ names: ["TOKEN"] });
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("rejects artifacts outside the spool and unknown paths", async () => {
    const { client, root } = await setup();
    const outside = join(root, "evil.tar.gz");
    await writeFile(outside, "x");
    await expect(client.call("app.deploy", { artifact: outside, ...routed() })).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/inside the artifacts directory/),
    });
    await expect(client.call("app.deploy", { artifact: "/etc/passwd", ...routed() })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.call("app.deploy", { artifact: join(root, "spool", "nope.tar.gz"), manifestText: "x" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("classifies errors", async () => {
    const { client } = await setup();
    await expect(client.call("app.info", { app: "BAD" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(client.call("app.control", { app: "ghost", verb: "stop" })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.call("app.rollback", { app: "ghost" })).rejects.toMatchObject({ code: "not_found" });
    const raw = client as unknown as { call: (op: string, args: unknown) => Promise<unknown> };
    const err = (await raw.call("rm.rf", {}).catch((e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("bad_request");
  });

  it("reports a failed deploy with rollback details when verification is on", async () => {
    const { client, tarball, deps } = await setup();
    deps.dev = false; // enable verification (the fake host drives health via BAD/CRASH files)
    deps.config.agent.group = "x";
    const a = await client.call("app.deploy", { artifact: await tarball(), manifestText: HC_MANIFEST });
    const err = await client.call("app.deploy", { artifact: await tarball({ BAD: "" }), manifestText: HC_MANIFEST }).catch((e) => e);
    expect(err).toMatchObject({ code: "deploy_failed", extra: { rolledBackTo: a.releaseId } });
    expect(err.extra.historyAt).toBeTruthy();
    expect(err.extra.releaseId).not.toBe(a.releaseId);
  });
});

describe("dispatcher", () => {
  it("refuses artifact.put when it arrives as a plain request", async () => {
    const { dispatch, createHandlers } = await import("../src/index.ts");
    const h = await makeDeps();
    const r = await dispatch(createHandlers(h.deps), JSON.stringify({ id: "1", op: "artifact.put", args: {} }));
    expect(r).toMatchObject({ ok: false, error: { code: "bad_request", message: expect.stringMatching(/sent as an upload/) } });
  });
});
