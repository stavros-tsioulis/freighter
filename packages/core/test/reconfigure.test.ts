import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DeployFailedError, deploy, fastEnough, getConfig, readState, rollback, setConfig } from "../src/index.ts";
import { parseManifest } from "@freighter/manifest";
import { artifact, makeDeps, routed } from "./helpers.ts";

const yaml = (worker = "", extra = "") => `name: shop
services:
  web:
    command: node server.mjs
    healthcheck:
      path: /health
      timeout: 5s
  worker:
    command: node worker.mjs
${worker}${extra}`;
const sysctl = (h: Awaited<ReturnType<typeof makeDeps>>) => h.mutating().filter((c) => c[0] === "systemctl").map((c) => c.slice(1).join(" "));

async function running() {
  const h = await makeDeps();
  const first = await deploy(h.deps, { ...routed(), source: await artifact({ "big.bin": "x".repeat(50_000) }) });
  return { h, first };
}

describe("changing services without a deploy", () => {
  it("restarts only the service whose environment changed, from a release made of links", async () => {
    const { h, first } = await running();
    const webUnit = `freighter-shop--web--${first.releaseId}.service`;
    const before = h.unitText(webUnit);
    h.calls.length = 0;
    h.probed.length = 0;

    const r = (await setConfig(h.deps, "shop", yaml("    environment:\n      MODE: fast\n")))!.deploy!;
    expect(r.releaseId).not.toBe(first.releaseId);
    expect(r.previous).toBe(first.releaseId);

    // web is not touched: same unit file, no start/stop/restart of it, its HAProxy backend as before
    expect(h.unitText(webUnit)).toBe(before);
    const calls = sysctl(h);
    expect(calls).toContain("restart freighter-shop--worker.service");
    expect(calls.filter((c) => c.includes("web"))).toEqual([]);
    expect(calls.some((c) => c.startsWith("stop"))).toBe(false);
    expect(h.unitText("freighter-shop--worker.service")).toContain('Environment="MODE=fast"');
    expect(h.probed).toEqual([]); // web is not checked again, and the worker has no health check

    // the new release has the new app.yaml, the old one keeps its own, and the files are shared, not copied
    const dir = (id: string) => `${h.deps.layout.appsRoot}/shop/releases/${id}`;
    expect(await readFile(`${dir(r.releaseId)}/app.yaml`, "utf8")).toContain("MODE: fast");
    expect(await readFile(`${dir(first.releaseId)}/app.yaml`, "utf8")).not.toContain("MODE");
    expect(await readFile(`${dir(r.releaseId)}/big.bin`, "utf8")).toHaveLength(50_000);
    const a = await stat(`${dir(first.releaseId)}/big.bin`);
    const b = await stat(`${dir(r.releaseId)}/big.bin`);
    if (a.nlink > 1) expect(b.ino).toBe(a.ino); // where hard links are possible, they were used

    // web still runs from the release it started in, which is kept; the worker moved to the new one
    const state = await readState(h.deps, "shop");
    expect(state.routed.web!.release).toBe(first.releaseId);
    expect(state.at).toEqual({ worker: r.releaseId });
    expect(await readdir(`${h.deps.layout.appsRoot}/shop/releases`)).toContain(first.releaseId);
    expect(await getConfig(h.deps, "shop")).toContain("MODE: fast");
  });

  it("starts just the new service when one is added", async () => {
    const { h, first } = await running();
    h.calls.length = 0;
    const r = (await setConfig(h.deps, "shop", yaml("", "  cron:\n    command: node cron.mjs\n")))!.deploy!;
    expect(sysctl(h)).toEqual(expect.arrayContaining(["enable freighter-shop--cron.service", "restart freighter-shop--cron.service"]));
    expect(sysctl(h).filter((c) => /web|worker/.test(c))).toEqual([]);
    expect(r.units).toContain("freighter-shop--cron.service");
    expect(h.unitFiles()).toContain("freighter-shop--cron.service");
    expect((await readState(h.deps, "shop")).routed.web!.release).toBe(first.releaseId);
  });

  it("replaces a routed service that changed as a new instance and leaves the others alone", async () => {
    const { h, first } = await running();
    h.calls.length = 0;
    const r = (await setConfig(h.deps, "shop", yaml("").replace("command: node server.mjs", "command: node server.mjs --fast")))!.deploy!;
    const newWeb = `freighter-shop--web--${r.releaseId}.service`;
    const oldWeb = `freighter-shop--web--${first.releaseId}.service`;
    const calls = sysctl(h);
    expect(calls).toContain(`start ${newWeb}`);
    expect(calls.indexOf("reload haproxy")).toBeGreaterThan(calls.indexOf(`start ${newWeb}`));
    expect(calls.indexOf(`stop ${oldWeb}`)).toBeGreaterThan(calls.indexOf("reload haproxy"));
    expect(h.unitFiles()).not.toContain(oldWeb);
    expect(calls.filter((c) => c.includes("worker"))).toEqual([]);
    const state = await readState(h.deps, "shop");
    expect(state.routed.web).toMatchObject({ unit: newWeb, release: r.releaseId });
    expect(h.probed.some((u) => u.includes(`:${state.routed.web!.port}/health`))).toBe(true);
  });

  it("removes a service and keeps the rest running", async () => {
    const { h } = await running();
    h.calls.length = 0;
    const r = (await setConfig(h.deps, "shop", yaml("", "").replace("  worker:\n    command: node worker.mjs\n", "")))!.deploy!;
    expect(r.removed).toEqual(["freighter-shop--worker.service"]);
    expect(h.unitFiles()).not.toContain("freighter-shop--worker.service");
    expect(sysctl(h).filter((c) => c.includes("web"))).toEqual([]);
  });

  it("puts back only what changed when a changed service does not come up, and leaves nothing of the release", async () => {
    const { h, first } = await running();
    await writeFile(`${h.deps.layout.appsRoot}/shop/releases/${first.releaseId}/CRASH`, ""); // everything made from this release crashes
    const workerBefore = h.unitText("freighter-shop--worker.service");
    h.calls.length = 0;
    const err = await setConfig(h.deps, "shop", yaml("", "  cron:\n    command: node cron.mjs\n")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeployFailedError);
    expect((err as Error).message).toMatch(/cron: service is not stable/);
    expect((err as Error).message).toMatch(/the others were not touched/);
    expect(h.unitFiles()).not.toContain("freighter-shop--cron.service");
    expect(h.unitText("freighter-shop--worker.service")).toBe(workerBefore);
    expect(sysctl(h).filter((c) => /web|worker/.test(c))).toEqual([]);
    expect(await readdir(`${h.deps.layout.appsRoot}/shop/releases`)).toEqual([first.releaseId]);
    expect((await readState(h.deps, "shop")).routed.web!.release).toBe(first.releaseId);
    expect(await getConfig(h.deps, "shop")).toContain("cron"); // what was entered is kept
  });

  it("does a full deploy when an image has to be pulled or remote volumes change", async () => {
    const { h } = await running();
    const img = (text: string) => parseManifest(text);
    expect(fastEnough(img(yaml()), img(yaml("", "  cache:\n    image: redis:7\n")))).toBe(false);
    expect(fastEnough(img(yaml()), img(yaml("    environment:\n      A: b\n")))).toBe(true);
    expect(fastEnough(img(yaml()), img(`${yaml()}volumes:\n  media:\n    type: nfs\n    host: nas\n    export: /m\n`))).toBe(false);
    // and setConfig takes the full path for it: a release made by deploy() has every service restarted
    h.calls.length = 0;
    await setConfig(h.deps, "shop", yaml("", "  cache:\n    image: redis:7\n"));
    expect(sysctl(h).some((c) => /worker/.test(c))).toBe(true);
  });

  it("restarts a service that reads the port of one that moved", async () => {
    const { h } = await running();
    await setConfig(h.deps, "shop", yaml('    environment:\n      WEB: "@web.internal"\n'));
    expect(h.unitText("freighter-shop--worker.service")).toMatch(/Environment="WEB=http:\/\/127\.0\.0\.1:20000"/);
    h.calls.length = 0;
    // web changes, gets a new instance on a new port, and the worker is told
    const r = (await setConfig(h.deps, "shop", yaml('    environment:\n      WEB: "@web.internal"\n').replace("command: node server.mjs", "command: node server.mjs --v2")))!.deploy!;
    const port = (await readState(h.deps, "shop")).routed.web!.port;
    expect(port).not.toBe(20000);
    expect(h.unitText("freighter-shop--worker.service")).toContain(`Environment="WEB=http://127.0.0.1:${port}"`);
    expect(sysctl(h)).toContain("restart freighter-shop--worker.service");
    expect(r.units).toHaveLength(2);
  });

  it("keeps the release a service still runs from when old releases are pruned, and rolls back like any release", async () => {
    const { h, first } = await running();
    const keep2 = (extra: string) => `${yaml(extra)}releases:\n  keep: 2\n`;
    await setConfig(h.deps, "shop", keep2("    environment:\n      N: '1'\n"));
    await setConfig(h.deps, "shop", keep2("    environment:\n      N: '2'\n"));
    const r3 = (await setConfig(h.deps, "shop", keep2("    environment:\n      N: '3'\n")))!.deploy!;
    const releases = await readdir(`${h.deps.layout.appsRoot}/shop/releases`);
    expect(releases).toContain(first.releaseId); // web still runs from it
    expect(releases).toContain(r3.releaseId);
    expect(releases.length).toBe(3); // the first, the one before the last, and the last

    // a full deploy afterwards moves everything and the old release can go
    const full = await deploy(h.deps, { manifestText: keep2("    environment:\n      N: '3'\n"), source: await artifact(), config: "replace" });
    expect(await readdir(`${h.deps.layout.appsRoot}/shop/releases`)).not.toContain(first.releaseId);
    expect((await readState(h.deps, "shop")).routed.web!.release).toBe(full.releaseId);
    expect((await readState(h.deps, "shop")).at).toEqual({ worker: full.releaseId });

    const back = await rollback(h.deps, "shop");
    expect(back.to).not.toBe(full.releaseId);
    expect((await readState(h.deps, "shop")).at).toEqual({ worker: back.to });
  });

  it("gives every service the app's environment, with a service's own value winning, and restarts all of them when it changes", async () => {
    const { h } = await running();
    const withApp = (region: string) => `name: shop
environment:
  REGION: ${region}
  LOG: info
services:
  web:
    command: node server.mjs
    healthcheck:
      path: /health
      timeout: 5s
    environment:
      LOG: debug
  worker:
    command: node worker.mjs
`;
    await setConfig(h.deps, "shop", withApp("eu"));
    const state = await readState(h.deps, "shop");
    expect(h.unitText(state.routed.web!.unit)).toContain('Environment="REGION=eu"');
    expect(h.unitText(state.routed.web!.unit)).toContain('Environment="LOG=debug"'); // its own
    expect(h.unitText("freighter-shop--worker.service")).toContain('Environment="LOG=info"'); // the app's
    expect(await getConfig(h.deps, "shop")).toMatch(/^environment:\n {2}REGION: eu/m);
    h.calls.length = 0;
    await setConfig(h.deps, "shop", withApp("us"));
    expect(sysctl(h)).toContain("restart freighter-shop--worker.service");
    expect(h.unitText("freighter-shop--worker.service")).toContain('Environment="REGION=us"');
    expect(h.unitText((await readState(h.deps, "shop")).routed.web!.unit)).toContain('Environment="REGION=us"');
  });
});
