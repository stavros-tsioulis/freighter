import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The built server over stdio, a real MCP client, and a mock Freighter API: what a host would do, without a Freighter.

const entry = resolve(import.meta.dirname, "../dist/index.js");
const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
let http: Server;
let client: Client;
let deployPolls = 0;

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      if (p === "/api/v1/apps") return json(res, 200, { apps: [{ name: "shop", server: "local", status: "ready", currentRelease: "r1", previousRelease: null, projectId: null, syncedAt: null, services: [{ name: "web", port: 3001, hostnames: ["shop.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: 1e8 }] }] });
      if (p === "/api/v1/apps/nope") return json(res, 404, { error: { code: "not_found", message: "no app called nope" } });
      if (p === "/api/v1/apps/shop/variables") return json(res, 200, { variables: [{ service: "web", key: "LOG_LEVEL", value: "info", resolved: null, error: null, source: "service", secret: false, reference: false }] });
      if (p === "/api/v1/apps/shop/services/web/env") return json(res, 200, { names: ["DB_PASSWORD"], declared: ["DB_PASSWORD", "API_KEY"] });
      if (p === "/api/v1/apps/shop/redeploy") return json(res, 202, { id: "d1d1d1d1-0000-0000-0000-000000000000" });
      if (p === "/api/v1/apps/shop/git") return json(res, 404, { error: { code: "not_found", message: "not linked" } });
      if (p === "/api/v1/deployments/d1d1d1d1-0000-0000-0000-000000000000") {
        deployPolls++;
        return json(res, 200, { id: "d1d1d1d1-0000-0000-0000-000000000000", app: "shop", server: "local", action: "redeploy", status: deployPolls < 2 ? "running" : "failed", releaseId: null, previousRelease: null, error: "port 3001 is taken", warnings: [], createdAt: new Date().toISOString(), startedAt: null, finishedAt: null });
      }
      if (p.endsWith("/jobs") || p.includes("/steps")) return json(res, 200, { jobs: [], steps: [] });
      if (p === "/api/v1/session") return json(res, 200, { id: "t1", name: "ci", role: "deployer" });
      json(res, 404, { error: { code: "not_found", message: `unexpected ${req.method} ${p}` } });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [entry],
      env: { ...getDefaultEnvironment(), FREIGHTER_URL: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, FREIGHTER_TOKEN: "fr_test", FREIGHTER_POLL_MS: "10" },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  http?.close();
});

const text = (r: { content?: unknown }) => ((r.content as { text: string }[])[0]?.text ?? "");

describe("freighter-mcp-server", () => {
  it("lists its tools, all prefixed, all described, with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
    for (const t of tools) {
      expect(t.name).toMatch(/^freighter_[a-z_]+$/);
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
      expect(t.annotations?.readOnlyHint).toBeDefined();
    }
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["freighter_list_apps", "freighter_exec", "freighter_deploy_image", "freighter_set_variables"]));
    // secrets are write-only by design: no tool takes a secret's value
    expect(tools.map((t) => t.name).filter((n) => /secret/.test(n))).toEqual(["freighter_list_secret_names"]);
  });

  it("lists apps with the bearer token, in markdown and json", async () => {
    const md = await client.callTool({ name: "freighter_list_apps", arguments: {} });
    expect(md.isError).toBeFalsy();
    expect(text(md)).toContain("shop");
    expect(seen.at(-1)?.auth).toBe("Bearer fr_test");
    const js = await client.callTool({ name: "freighter_list_apps", arguments: { response_format: "json" } });
    expect((js.structuredContent as { total: number }).total).toBe(1);
  });

  it("turns an API 404 into a message that says what to do next", async () => {
    const r = await client.callTool({ name: "freighter_get_app", arguments: { app: "nope" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/freighter_list_apps/);
  });

  it("rejects unknown arguments", async () => {
    const r = await client.callTool({ name: "freighter_list_apps", arguments: { bogus: 1 } });
    expect(r.isError).toBe(true);
  });

  it("shows secret names, never values", async () => {
    const r = await client.callTool({ name: "freighter_list_secret_names", arguments: { app: "shop", service: "web" } });
    expect(text(r)).toContain("API_KEY: NOT SET");
    expect(text(r)).toContain("DB_PASSWORD: set");
  });

  it("lists variables", async () => {
    const r = await client.callTool({ name: "freighter_list_variables", arguments: { app: "shop" } });
    expect(text(r)).toContain("LOG_LEVEL");
  });

  it("reports a failed deployment as an error with its reason", async () => {
    const r = await client.callTool({ name: "freighter_redeploy", arguments: { app: "shop", timeout_seconds: 10 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("port 3001 is taken");
  });

  it("says who it is", async () => {
    const r = await client.callTool({ name: "freighter_whoami", arguments: {} });
    expect(text(r)).toContain("deployer");
  });
});
