import { describe, expect, it } from "vitest";
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
