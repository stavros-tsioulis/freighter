import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { deploy, readConnections, rollback, writeConnections } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

const manifest = (v: string) => `name: web
services:
  web:
    command: node server.mjs
    port: 3000
environment:
  BILLING: "@billing/api.url"
  V: "${v}"
`;
const peer = { name: "billing", server: "s1", services: ["api"], domains: [{ hostname: "pay.example.com", service: "api", tls: "auto" as const }], ports: {}, environment: {} };

describe("stored connections", () => {
  it("round-trips, and an empty set removes the file", async () => {
    const h = await makeDeps();
    expect(await readConnections(h.deps, "web")).toEqual({ peers: {} });
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: peer } });
    expect((await readConnections(h.deps, "web")).peers.billing?.domains[0]?.hostname).toBe("pay.example.com");
    await writeConnections(h.deps, "web", { peers: {} });
    expect(await readConnections(h.deps, "web")).toEqual({ peers: {} });
  });

  it("deploys and rollbacks resolve against them", async () => {
    const h = await makeDeps();
    await expect(deploy(h.deps, { manifestText: manifest("1"), source: await artifact() })).rejects.toThrow(/no app "billing"/);
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: peer } });
    await deploy(h.deps, { manifestText: manifest("1"), source: await artifact() });
    await deploy(h.deps, { manifestText: manifest("2"), source: await artifact({ v: "2" }) });
    // the peer moved before the rollback: the old release comes back with the current address
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: { ...peer, domains: [{ hostname: "pay2.example.com", service: "api", tls: "auto" }] } } });
    await rollback(h.deps, "web", {});
    expect(h.unitFiles().map((u) => h.unitText(u)).join("\n")).toContain('Environment="BILLING=https://pay2.example.com"');
  });
});

describe("reapply", () => {
  const units = (h: Awaited<ReturnType<typeof makeDeps>>) => h.unitFiles().map((u) => h.unitText(u)).join("\n");
  it("redeploys only when something the app connects to has changed", async () => {
    const { reapply } = await import("../src/index.ts");
    const h = await makeDeps();
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: peer } });
    await deploy(h.deps, { manifestText: manifest("1"), source: await artifact() });
    expect(units(h)).toContain("BILLING=https://pay.example.com");

    // nothing changed: nothing happens
    h.calls.length = 0;
    expect(await reapply(h.deps, "web")).toEqual({ changed: false, deploy: null });
    expect(h.mutating().some((c) => c[0] === "systemctl" && c[1] === "start")).toBe(false);

    // an unrelated peer appearing does not matter either
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: peer, other: { ...peer, name: "other" } } });
    expect((await reapply(h.deps, "web")).changed).toBe(false);

    // the peer moved: the live release is redeployed with the new address, and settles
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: { ...peer, domains: [{ hostname: "pay2.example.com", service: "api", tls: "auto" }] } } });
    const r = await reapply(h.deps, "web");
    expect(r.changed).toBe(true);
    expect(r.deploy?.releaseId).toBeTruthy();
    expect(units(h)).toContain("BILLING=https://pay2.example.com");
    expect(units(h)).not.toContain("BILLING=https://pay.example.com");
    expect((await reapply(h.deps, "web")).changed).toBe(false);
  });

  it("notices a storage's key pair changing, and records the state of an app it has not tracked yet", async () => {
    const { reapply } = await import("../src/index.ts");
    const { rm } = await import("node:fs/promises");
    const h = await makeDeps();
    const text = 'name: web\nservices:\n  web:\n    command: node server.mjs\n    port: 3000\nenvironment:\n  S3_SECRET: "@storage:up.secretKey"\n';
    const st = (secretKey: string) => ({ up: { name: "up", hostname: "s3.example.com", tls: "auto" as const, port: 20100, accessKey: "AK", secretKey } });
    await writeConnections(h.deps, "web", { peers: {}, storages: st("old-secret") });
    await deploy(h.deps, { manifestText: text, source: await artifact() });
    expect(await readFile(`${h.deps.layout.envDir}/web.refs.env`, "utf8")).toContain("old-secret");

    await writeConnections(h.deps, "web", { peers: {}, storages: st("new-secret") });
    expect((await reapply(h.deps, "web")).changed).toBe(true);
    expect(await readFile(`${h.deps.layout.envDir}/web.refs.env`, "utf8")).toContain("new-secret");

    await rm(`${h.deps.layout.appsRoot}/web/resolved.json`);
    await writeConnections(h.deps, "web", { peers: {}, storages: st("newer-secret") });
    expect((await reapply(h.deps, "web")).changed).toBe(false); // untracked: record, don't guess
  });

  it("fails clearly when a connection can no longer be resolved, and leaves the app running", async () => {
    const { reapply } = await import("../src/index.ts");
    const h = await makeDeps();
    await writeConnections(h.deps, "web", { server: "s1", peers: { billing: peer } });
    await deploy(h.deps, { manifestText: manifest("1"), source: await artifact() });
    await writeConnections(h.deps, "web", { server: "s1", peers: {} });
    await expect(reapply(h.deps, "web")).rejects.toThrow(/no app "billing"/);
    expect(units(h)).toContain("BILLING=https://pay.example.com");
  });
});
