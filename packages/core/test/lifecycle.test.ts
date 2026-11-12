import { mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DeployFailedError,
  deploy,
  listReleases,
  readHistory,
  rollback,
  setEnv,
  withLock,
  type Deps,
} from "../src/index.ts";
import { HC_MANIFEST, MANIFEST, artifact, makeDeps } from "./helpers.ts";

const current = (deps: Deps) => readlink(`${deps.layout.appsRoot}/hello/current`).then((l) => l.split("/").pop()!);

async function setup(manifest = HC_MANIFEST) {
  const h = await makeDeps();
  await setEnv(h.deps, "hello", "web", "TOKEN", "t");
  return { ...h, manifest };
}

describe("health-gated deploy", () => {
  it("verifies a healthy deploy and records history", async () => {
    const { deps, probed } = await setup();
    const r = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact() });
    expect(r.verified).toBe(true);
    expect(probed).toEqual(["http://127.0.0.1:3100/health"]);
    expect((await readHistory(deps, "hello")).map((h) => [h.action, h.result])).toEqual([["deploy", "success"]]);
  });

  it("rolls back to the previous release when the new one is unhealthy", async () => {
    const { deps } = await setup();
    // v1 runs web + worker; v2 drops the worker and is unhealthy.
    const v1 = await deploy(deps, { manifestText: HC_MANIFEST.replace("releases:", "  worker:\n    command: node w.mjs\nreleases:"), source: await artifact() });
    const err = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact({ BAD: "" }) }).catch((e) => e);

    expect(err).toBeInstanceOf(DeployFailedError);
    expect(err.rolledBackTo).toBe(v1.releaseId);
    expect(err.message).toMatch(/no healthy response from \/health within 5s/);
    expect(err.message).toContain("boom: something broke");
    expect(err.message).toContain(`rolled back to ${v1.releaseId}`);
    expect(await current(deps)).toBe(v1.releaseId);
    // the worker unit from the previous manifest is back
    expect(await readdir(deps.layout.unitDir)).toContain("freighter-hello--worker.service");
    expect((await readHistory(deps, "hello")).map((h) => [h.action, h.result])).toEqual([
      ["deploy", "success"],
      ["deploy", "failed"],
      ["rollback", "success"],
    ]);
  });

  it("detects a crash-looping service that has no healthcheck", async () => {
    const { deps } = await setup();
    const err = await deploy(deps, { manifestText: MANIFEST, source: await artifact({ CRASH: "" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployFailedError);
    expect(err.message).toMatch(/not stable.*restarts 1/);
  });

  it("stops the services when the very first deploy fails", async () => {
    const { deps, calls } = await setup();
    const err = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact({ BAD: "" }) }).catch((e) => e);
    expect(err.rolledBackTo).toBeNull();
    expect(err.message).toContain("first deploy: services stopped");
    expect(calls).toContainEqual(["systemctl", "stop", "freighter-hello--web.service"]);
  });

  it("skipVerify bypasses probes", async () => {
    const { deps, probed } = await setup();
    const r = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact({ BAD: "" }), skipVerify: true });
    expect(r.verified).toBe(false);
    expect(probed).toEqual([]);
  });
});

describe("retention and ids", () => {
  it("keeps the newest N plus current and previous", async () => {
    const { deps } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact() })).releaseId);
    expect((await readdir(`${deps.layout.appsRoot}/hello/releases`)).sort()).toEqual(ids.slice(-2));
  });

  it("disambiguates ids created in the same second", async () => {
    const { deps } = await setup();
    deps.now = () => new Date(Date.UTC(2026, 10, 6, 13, 45, 0));
    const a = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact() });
    const b = await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact() });
    expect([a.releaseId, b.releaseId]).toEqual(["r20261106-134500", "r20261106-134500-2"]);
  });
});

describe("lock", () => {
  it("rejects a concurrent operation and cleans up", async () => {
    const { deps } = await setup();
    await mkdir(`${deps.layout.appsRoot}/hello`, { recursive: true });
    await expect(withLock(deps, "hello", () => withLock(deps, "hello", async () => {}))).rejects.toThrow(/in progress \(needed for "hello"\): "hello" has been deploying for \d+s/);
    await withLock(deps, "hello", async () => {}); // released again
  });

  it("takes over a stale lock", async () => {
    const { deps } = await setup();
    await mkdir(`${deps.layout.appsRoot}/hello`, { recursive: true });
    await writeFile(`${deps.layout.appsRoot}/.lock`, "999999");
    expect(await withLock(deps, "hello", async () => "ok")).toBe("ok");
  });
});

describe("rollback", () => {
  async function twoReleases() {
    const h = await setup();
    const a = await deploy(h.deps, { manifestText: HC_MANIFEST, source: await artifact({ "v": "1" }) });
    const b = await deploy(h.deps, { manifestText: HC_MANIFEST, source: await artifact({ "v": "2" }) });
    return { ...h, a: a.releaseId, b: b.releaseId };
  }

  it("defaults to the previous successful release", async () => {
    const { deps, a, b } = await twoReleases();
    const r = await rollback(deps, "hello");
    expect(r).toMatchObject({ from: b, to: a, verified: true });
    expect(await current(deps)).toBe(a);
    expect(await readFile(`${deps.layout.appsRoot}/hello/current/v`, "utf8")).toBe("1");
    expect((await listReleases(deps, "hello")).find((x) => x.id === a)?.current).toBe(true);
  });

  it("accepts an explicit target and rejects bad ones", async () => {
    const { deps, a, b } = await twoReleases();
    await expect(rollback(deps, "hello", { target: b })).rejects.toThrow(/already current/);
    await expect(rollback(deps, "hello", { target: "r1" })).rejects.toThrow(/unknown release/);
    await rollback(deps, "hello", { target: a });
    expect(await current(deps)).toBe(a);
  });

  it("fails clearly when undeployed or without history", async () => {
    const { deps } = await setup();
    await expect(rollback(deps, "hello")).rejects.toThrow(/not deployed/);
    await deploy(deps, { manifestText: HC_MANIFEST, source: await artifact() });
    await expect(rollback(deps, "hello")).rejects.toThrow(/no release to roll back to/);
  });

  it("reports a rollback target that is unhealthy", async () => {
    const { deps, a } = await setup().then(async (h) => {
      const a = await deploy(h.deps, { manifestText: HC_MANIFEST, source: await artifact({ BAD: "" }), skipVerify: true });
      await deploy(h.deps, { manifestText: HC_MANIFEST, source: await artifact() });
      return { ...h, a: a.releaseId };
    });
    await expect(rollback(deps, "hello", { target: a })).rejects.toThrow(/rollback to .* failed; .* is still current/);
    expect((await readHistory(deps, "hello")).at(-1)).toMatchObject({ action: "rollback", result: "failed" });
  });
});

describe("the deploy lock", () => {
  it("waits for a deploy that is finishing instead of refusing at once, and gives up with a reason when it doesn't", async () => {
    const { deps } = await makeDeps();
    deps.lockWaitMs = 3000;
    let release!: () => void;
    const first = withLock(deps, "slow", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    let ran = false;
    const second = withLock(deps, "other", async () => void (ran = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toBe(false); // still waiting
    release();
    await first;
    await second;
    expect(ran).toBe(true);

    deps.lockWaitMs = 300;
    const hold = withLock(deps, "slow", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    await expect(withLock(deps, "other", async () => {})).rejects.toThrow(/in progress \(needed for "other"\): "slow" has been deploying for/);
    release();
    await hold;
  });
});
