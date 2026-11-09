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
    environment: { web: { API_URL: "@api.url/v1", API_HOST: "@api.domain", WEB_URL: "@web.url", INT: "@api.internal", P: "@api.port", BASE: "@api.MODE", MAIL: "a@@b.c" }, api: { MODE: "prod" } },
  });
  it("resolves domain, url, internal, port and environment values", () => {
    expect(resolveEnvironment(self, "web")).toMatchObject({
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
    const bare = facts({ name: "a", domains: [], environment: { web: { X: "@api.url" } } });
    expect(() => resolveEnvironment(bare, "web")).toThrow(/X: @api.url: service "api" has no domain yet/);
    expect(() => resolveEnvironment({ ...bare, environment: { web: { X: "@api.port" } } }, "web")).toThrow(/has no port/);
    expect(() => resolveEnvironment({ ...bare, environment: { web: { X: "@nope.port" } } }, "web")).toThrow(/no service "nope"/);
  });
  it("resolves other apps, in their own context", () => {
    const peer = facts({ name: "billing", server: "s1", services: ["api"], domains: [{ hostname: "b.example.com", service: "api", tls: "auto" }], ports: { api: 21000 }, environment: { api: { SELF: "@api.url", REGION: "eu" } } });
    const me = facts({ name: "web", server: "s1", environment: { web: { B: "@billing/api.url", R: "@billing/api.REGION", S: "@billing/api.SELF", I: "@billing/api.internal" } } });
    expect(resolveEnvironment(me, "web", { billing: peer })).toEqual({ B: "https://b.example.com", R: "eu", S: "https://b.example.com", I: "http://127.0.0.1:21000" });
    expect(() => resolveEnvironment(me, "web", {})).toThrow(/no app "billing"/);
    expect(() => resolveEnvironment(me, "web", { billing: { ...peer, server: "s2" } })).toThrow(/use .url instead/);
  });
  it("detects loops", () => {
    expect(() => resolveEnvironment(facts({ name: "a", environment: { web: { A: "@api.B" }, api: { B: "@web.A" } } }), "web")).toThrow(/loop: a\/web\.A -> a\/api\.B -> a\/web\.A/);
  });
});

describe("deploy with connections", () => {
  const manifest = `name: shop
services:
  web:
    command: node server.mjs
    healthcheck: { path: /health, timeout: 5s }
    environment:
      API_URL: "@api.url"
      API_INTERNAL: "@api.internal"
  api:
    command: node api.mjs
    healthcheck: { path: /health, timeout: 5s }
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

describe("resolveEnvironmentEach", () => {
  it("returns a result per entry instead of stopping at the first broken one", async () => {
    const { resolveEnvironmentEach } = await import("../src/index.ts");
    const r = resolveEnvironmentEach(facts({ name: "a", domains: [{ hostname: "h.example.com", service: "web", tls: "auto" }], environment: { web: { GOOD: "@web.domain", BAD: "@api.url", PLAIN: "x" } } }), "web");
    expect(r).toEqual({ GOOD: { value: "h.example.com", secret: false }, BAD: { error: expect.stringMatching(/^BAD: @api.url: .*no domain/) }, PLAIN: { value: "x", secret: false } });
  });
});

describe("storage references", () => {
  const st = { name: "up", server: "s1", hostname: "s3.example.com", tls: "auto" as const, port: 20100, accessKey: "AK", secretKey: "SK" };
  const me = facts({ name: "a", server: "s1", environment: { web: { URL: "@storage:up.url", DOM: "@storage:up.domain", INT: "@storage:up.internal", REG: "@storage:up.region", AK: "@storage:up.accessKey", SK: "@storage:up.secretKey", VIA: "@web.SK2", SK2: "k=@storage:up.secretKey" } } });
  it("resolves attributes and marks credentials as secret, also through another value", async () => {
    const { resolveEnvironmentEach } = await import("../src/index.ts");
    const r = resolveEnvironmentEach(me, "web", {}, { up: st });
    expect(r.URL).toEqual({ value: "https://s3.example.com", secret: false });
    expect(r.INT).toEqual({ value: "http://127.0.0.1:20100", secret: false });
    expect(r.REG).toEqual({ value: "us-east-1", secret: false });
    expect(r.AK).toEqual({ value: "AK", secret: true });
    expect(r.VIA).toEqual({ value: "k=SK", secret: true });
  });
  it("falls back to the internal address without a domain, and says why when it can't", async () => {
    const { resolveEnvironmentEach } = await import("../src/index.ts");
    expect(resolveEnvironmentEach(me, "web", {}, { up: { ...st, hostname: undefined } }).URL).toEqual({ value: "http://127.0.0.1:20100", secret: false });
    expect(resolveEnvironmentEach(me, "web", {}, { up: { ...st, hostname: undefined, server: "s2" } }).URL).toMatchObject({ error: expect.stringMatching(/give it a domain/) });
    expect(resolveEnvironmentEach(me, "web", {}, { up: { ...st, server: "s2" } }).INT).toMatchObject({ error: expect.stringMatching(/use .url instead/) });
    expect(resolveEnvironmentEach(me, "web", {}, {}).URL).toMatchObject({ error: expect.stringMatching(/no storage "up"/) });
  });
});

describe("deploy with storage references", () => {
  it("keeps the key pair out of the unit and in a root-only file the unit loads", async () => {
    const { stat, readFile } = await import("node:fs/promises");
    const h = await makeDeps();
    const manifest = `name: web
services:
  web:
    command: node server.mjs
    port: 3000
    environment:
      S3_URL: "@storage:up.url"
      S3_SECRET: "@storage:up.secretKey"
`;
    const { writeConnections } = await import("../src/index.ts");
    await writeConnections(h.deps, "web", { peers: {}, storages: { up: { name: "up", hostname: "s3.example.com", tls: "auto", port: 20100, accessKey: "AK", secretKey: "SK-top-secret" } } });
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    const unit = h.unitFiles().map((u) => h.unitText(u)).join("\n");
    expect(unit).toContain('Environment="S3_URL=https://s3.example.com"');
    expect(unit).not.toContain("SK-top-secret");
    expect(unit).not.toContain("S3_SECRET=");
    expect(unit).toContain(".refs.env");
    const file = `${h.deps.layout.envDir}/web/web.refs.env`;
    expect(await readFile(file, "utf8")).toBe('S3_SECRET="SK-top-secret"\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
