import { describe, expect, it } from "vitest";
import { deploy, resolveEnvironment, type AppFacts } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

const facts = (over: Partial<AppFacts> & { name: string }): AppFacts => ({ services: ["web", "api"], domains: [], ports: {}, environment: {}, ...over });

describe("resolveEnvironment", () => {
  const self = facts({
    name: "shop",
    server: "s1",
    domains: [{ hostname: "api.example.com", service: "api", tls: "auto" }, { hostname: "plain.example.com", service: "web", tls: "off" }],
    ports: { api: 20000, web: 20001 },
    environment: { API_URL: "@api.url/v1", API_HOST: "@api.domain", WEB_URL: "@web.url", INT: "@api.internal", P: "@api.port", BASE: "@api.MODE", MODE: "prod", MAIL: "a@@b.c" },
  });
  it("resolves domain, url, internal, port and environment values", () => {
    expect(resolveEnvironment(self)).toMatchObject({
      API_URL: "https://api.example.com/v1",
      API_HOST: "api.example.com",
      WEB_URL: "http://plain.example.com",
      INT: "http://127.0.0.1:20000",
      P: "20000",
      BASE: "prod",
      MAIL: "a@b.c",
    });
  });
  it("fails clearly on a missing domain, port or service", () => {
    const bare = facts({ name: "a", domains: [], environment: { X: "@api.url" } });
    expect(() => resolveEnvironment(bare)).toThrow(/X: @api.url: service "api" has no domain yet/);
    expect(() => resolveEnvironment({ ...bare, environment: { X: "@api.port" } })).toThrow(/has no port/);
    expect(() => resolveEnvironment({ ...bare, environment: { X: "@nope.port" } })).toThrow(/no service "nope"/);
  });
  it("resolves other apps, in their own context", () => {
    const peer = facts({ name: "billing", server: "s1", services: ["api"], domains: [{ hostname: "b.example.com", service: "api", tls: "auto" }], ports: { api: 21000 }, environment: { SELF: "@api.url", REGION: "eu" } });
    const me = facts({ name: "web", server: "s1", environment: { B: "@billing/api.url", R: "@billing/api.REGION", S: "@billing/api.SELF", I: "@billing/api.internal" } });
    expect(resolveEnvironment(me, { billing: peer })).toEqual({ B: "https://b.example.com", R: "eu", S: "https://b.example.com", I: "http://127.0.0.1:21000" });
    expect(() => resolveEnvironment(me, {})).toThrow(/no app "billing"/);
    expect(() => resolveEnvironment(me, { billing: { ...peer, server: "s2" } })).toThrow(/use .url instead/);
  });
  it("detects loops", () => {
    expect(() => resolveEnvironment(facts({ name: "a", environment: { A: "@web.B", B: "@api.A" } }))).toThrow(/loop: a\/A -> a\/B -> a\/A/);
  });
});

describe("deploy with connections", () => {
  const manifest = `name: shop
services:
  web:
    command: node server.mjs
    healthcheck: { path: /health, timeout: 5s }
  api:
    command: node api.mjs
    healthcheck: { path: /health, timeout: 5s }
environment:
  API_URL: "@api.url"
  API_INTERNAL: "@api.internal"
`;
  it("writes resolved values into the units, using the ports allocated in the same deploy", async () => {
    const h = await makeDeps();
    const domains = [{ hostname: "api.example.com", service: "api", tls: "auto" as const }, { hostname: "shop.example.com", service: "web", tls: "auto" as const }];
    const r = await deploy(h.deps, { manifestText: manifest, domains, source: await artifact() });
    const unit = h.unitText(r.units.find((u) => u.includes("--web"))!);
    expect(unit).toContain('Environment="API_URL=https://api.example.com"');
    expect(unit).toMatch(/Environment="API_INTERNAL=http:\/\/127\.0\.0\.1:2000\d"/);
  });
  it("fails the deploy before touching anything when a connection can't be resolved", async () => {
    const h = await makeDeps();
    await expect(deploy(h.deps, { manifestText: manifest, source: await artifact() })).rejects.toThrow(/@api.url: service "api" has no domain yet/);
    expect(h.unitFiles()).toEqual([]);
  });
});
