import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DeployFailedError,
  allocatePort,
  certStatus,
  deploy,
  haproxySync,
  readState,
  renewCerts,
  rollback,
  setEnv,
} from "../src/index.ts";
import { artifact, makeDeps, routed, routedManifest } from "./helpers.ts";

const idx = (calls: string[][], ...needle: string[]) =>
  calls.findIndex((c) => needle.every((n, i) => c[i] === n));

describe("routed deploys (blue/green)", () => {
  it("first deploy: instance unit on an allocated port, haproxy files, state", async () => {
    const h = await makeDeps();
    const r = await deploy(h.deps, { ...routed(), source: await artifact() });

    const webUnit = `freighter-shop--web--${r.releaseId}.service`;
    expect(r.units).toEqual([webUnit, "freighter-shop--worker.service"]);
    expect(r.hostnames).toEqual(["shop.example.com"]);
    const unit = h.unitText(webUnit);
    expect(unit).toContain("Environment=PORT=20000\n");
    expect(unit).toContain(`WorkingDirectory=${h.deps.layout.appsRoot}/shop/releases/${r.releaseId}\n`);

    expect((await readState(h.deps, "shop")).routed.web).toMatchObject({ unit: webUnit, port: 20000, release: r.releaseId });
    expect(h.haproxyFile("hostnames.map")).toContain("shop.example.com be_shop_web\n");
    expect(h.haproxyFile("https.map")).toContain("shop.example.com 1\n");
    expect(h.haproxyFile("backends.cfg")).toContain("server app 127.0.0.1:20000 check");
    expect(h.calls).toContainEqual(["systemctl", "reload", "haproxy"]);
    expect(h.ctl.issued).toEqual(["shop.example.com"]);
    expect(h.probed).toContain("http://127.0.0.1:20000/health");
  });

  it("second deploy: new instance on a new port; haproxy switches before the old one stops", async () => {
    const h = await makeDeps();
    const a = await deploy(h.deps, { ...routed(), source: await artifact() });
    h.calls.length = 0;
    const b = await deploy(h.deps, { ...routed(), source: await artifact({ v: "2" }) });

    const oldUnit = `freighter-shop--web--${a.releaseId}.service`;
    const newUnit = `freighter-shop--web--${b.releaseId}.service`;
    expect((await readState(h.deps, "shop")).routed.web).toMatchObject({ unit: newUnit, port: 20001 });
    expect(h.haproxyFile("backends.cfg")).toContain("127.0.0.1:20001");
    expect(h.haproxyFile("backends.cfg")).not.toContain("127.0.0.1:20000");

    const calls = h.mutating();
    const started = idx(calls, "systemctl", "start", newUnit);
    const reloaded = idx(calls, "systemctl", "reload", "haproxy");
    const stopped = idx(calls, "systemctl", "stop", oldUnit);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(reloaded).toBeGreaterThan(started);
    expect(stopped).toBeGreaterThan(reloaded);
    expect(h.unitFiles()).not.toContain(oldUnit);
    expect(b.removed).toContain(oldUnit);
  });

  it("unhealthy new release: old instance keeps serving and is never stopped", async () => {
    const h = await makeDeps();
    const a = await deploy(h.deps, { ...routed(), source: await artifact() });
    const backends = h.haproxyFile("backends.cfg");
    h.calls.length = 0;

    const err = await deploy(h.deps, { ...routed(), source: await artifact({ BAD: "" }) }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployFailedError);
    expect(err.message).toMatch(/no healthy response/);
    expect(err.message).toContain(`rolled back to ${a.releaseId}`);

    const oldUnit = `freighter-shop--web--${a.releaseId}.service`;
    expect(h.calls).not.toContainEqual(["systemctl", "stop", oldUnit]);
    expect(h.calls.some((c) => c[1] === "reload")).toBe(false);
    expect(h.haproxyFile("backends.cfg")).toBe(backends);
    expect((await readState(h.deps, "shop")).routed.web?.unit).toBe(oldUnit);
    // only the old instance + the in-place worker remain
    expect(h.unitFiles().sort()).toEqual([oldUnit, "freighter-shop--worker.service"].sort());
  });

  it("a failing haproxy config check aborts like an unhealthy deploy", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed(), source: await artifact() });
    const before = h.haproxyFile("backends.cfg");
    h.ctl.haproxyCheckCode = 1;
    const err = await deploy(h.deps, { ...routed(), source: await artifact() }).catch((e) => e);
    expect(err).toBeInstanceOf(DeployFailedError);
    expect(err.message).toMatch(/haproxy: haproxy config check failed.*invalid config/);
    expect(h.haproxyFile("backends.cfg")).toBe(before);
  });

  it("rolls back a routed app through a fresh instance", async () => {
    const h = await makeDeps();
    const a = await deploy(h.deps, { ...routed(), source: await artifact({ v: "1" }) });
    const b = await deploy(h.deps, { ...routed(), source: await artifact({ v: "2" }) });
    const r = await rollback(h.deps, "shop");
    expect(r).toMatchObject({ from: b.releaseId, to: a.releaseId });
    const st = (await readState(h.deps, "shop")).routed.web!;
    expect(st.release).toBe(a.releaseId);
    expect(st.unit).toBe(`freighter-shop--web--${a.releaseId}.service`);
    expect(h.unitFiles()).not.toContain(`freighter-shop--web--${b.releaseId}.service`);
    expect(await readFile(`${h.deps.layout.appsRoot}/shop/current/v`, "utf8")).toBe("1");
  });
});

describe("host-level checks", () => {
  it("rejects a hostname owned by another app before touching anything", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop"), source: await artifact() });
    h.calls.length = 0;
    await expect(deploy(h.deps, { ...routed("other"), source: await artifact() })).rejects.toThrow(
      /hostname shop\.example\.com is already used by app "shop"/,
    );
    expect(h.mutating().filter((c) => c[0] === "systemctl")).toEqual([]);
    expect(await readdir(`${h.deps.layout.appsRoot}/other`)).toContain("config.yaml"); // its configuration was kept
  });

  it("two apps get different ports", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("a", "a.example.com"), source: await artifact() });
    await deploy(h.deps, { ...routed("b", "b.example.com"), source: await artifact() });
    expect((await readState(h.deps, "a")).routed.web?.port).toBe(20000);
    expect((await readState(h.deps, "b")).routed.web?.port).toBe(20001);
    expect(h.haproxyFile("hostnames.map")).toContain("a.example.com be_a_web");
    expect(h.haproxyFile("hostnames.map")).toContain("b.example.com be_b_web");
  });

  it("port allocation skips bound ports and reports exhaustion", async () => {
    const h = await makeDeps();
    h.ctl.busyPorts = new Set([20000, 20001]);
    expect(await allocatePort(h.deps, new Set())).toBe(20002);
    expect(await allocatePort(h.deps, new Set([20002, 20003]))).toBe(20004);
    h.ctl.busyPorts = new Set(Array.from({ length: 10 }, (_, i) => 20000 + i));
    await expect(allocatePort(h.deps, new Set())).rejects.toThrow(/no free port in 20000-20009/);
  });

  it("tls: off and dev mode skip certificate issuance; a certificate failure aborts cleanly", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("a", "a.example.com", "off"), source: await artifact() });
    expect(h.ctl.issued).toEqual([]);
    expect(h.haproxyFile("https.map")).not.toContain("a.example.com");

    const dev = await makeDeps();
    dev.deps.dev = true;
    await deploy(dev.deps, { ...routed(), source: await artifact() });
    expect(dev.ctl.issued).toEqual([]);

    const bad = await makeDeps();
    bad.ctl.failIssue = true;
    await expect(deploy(bad.deps, { ...routed(), source: await artifact() })).rejects.toThrow(/certbot failed/);
    expect(bad.unitFiles()).toEqual([]);
  });

  it("worker-only apps never touch haproxy", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: "name: jobs\nservices:\n  w:\n    command: node w.mjs\n", source: await artifact() });
    expect(h.calls.some((c) => c[0] === "haproxy" || c[1] === "reload")).toBe(false);
    expect(h.haproxyFile("backends.cfg")).toBeNull();
  });

  it("retires a dropped in-place service only after the new release is live", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed(), source: await artifact() });
    const noWorker = routedManifest().replace("  worker:\n    command: node worker.mjs\n", "");
    const r = await deploy(h.deps, { manifestText: noWorker, config: "replace", source: await artifact() });
    expect(r.removed).toContain("freighter-shop--worker.service");
    expect(h.unitFiles()).not.toContain("freighter-shop--worker.service");
  });

  it("renews certificates once and reloads haproxy once; haproxySync rebuilds from state", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("a", "a.example.com"), source: await artifact() });
    await deploy(h.deps, { ...routed("b", "b.example.com", "off"), source: await artifact() });
    h.ctl.issued.length = 0;
    h.calls.length = 0;
    const out = await renewCerts(h.deps, { force: true });
    expect(out.map((o) => o.hostname)).toEqual(["a.example.com"]);
    expect(h.calls.filter((c) => c[1] === "reload")).toHaveLength(1);
    expect((await certStatus(h.deps)).map((c) => c.hostname)).toEqual(["a.example.com"]);

    const before = h.haproxyFile("hostnames.map");
    await import("node:fs/promises").then((fs) => fs.rm(`${h.deps.config.haproxy.dir}/hostnames.map`));
    expect((await haproxySync(h.deps)).changed).toBe(true);
    expect(h.haproxyFile("hostnames.map")).toBe(before);
  });

  it("missing acme email is reported by the cert layer, not swallowed", async () => {
    const h = await makeDeps();
    await setEnv(h.deps, "shop", "web", "X", "1");
    h.deps.issueCert = async () => {
      throw new Error("acme.email is not set in /etc/freighter/config.yaml (required for tls: auto)");
    };
    await expect(deploy(h.deps, { ...routed(), source: await artifact() })).rejects.toThrow(/acme\.email/);
    expect(h.unitFiles()).toEqual([]);
  });
});
