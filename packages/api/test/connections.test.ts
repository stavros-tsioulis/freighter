import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const WEB = "name: web\nservices:\n  web:\n    image: ghcr.io/org/web:1\n    port: 3000\nenvironment:\n  BILLING_URL: \"@billing/api.url\"\n";
const BILLING = "name: billing\nservices:\n  api:\n    image: ghcr.io/org/billing:1\nenvironment:\n  REGION: eu\n";

async function project(t: Awaited<ReturnType<typeof makeApi>>) {
  const p = (await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "Shop" } })).json;
  t.registry.apps.upsert({ name: "billing", server: "local", manifestText: BILLING, currentRelease: "r1", previousRelease: null, status: "deployed" });
  t.registry.services.replace("billing", [{ name: "api", unit: "u", port: 21000, hostnames: ["pay.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: null }]);
  t.registry.apps.ensure("web", "local");
  for (const app of ["web", "billing"]) t.registry.apps.setProject(app, p.id);
  t.handlers["domains.get"] = ({ app }: { app: string }) => ({ domains: app === "billing" ? [{ hostname: "pay.example.com", service: "api", tls: "auto" }] : [] });
}

describe("connections", () => {
  it("tells the agent about the other apps in the project before a deploy", async () => {
    const t = await makeApi();
    await project(t);
    const r = await t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB } });
    await t.api.jobs.idle();

    const set = t.calls.filter((c) => c.op === "connections.set");
    expect(set).toHaveLength(1);
    expect(set[0]!.args).toMatchObject({
      app: "web",
      server: "local",
      peers: { billing: { name: "billing", server: "local", services: ["api"], domains: [{ hostname: "pay.example.com", service: "api", tls: "auto" }], ports: { api: 21000 }, environment: { REGION: "eu" } } },
    });
    expect(t.calls.findIndex((c) => c.op === "connections.set")).toBeLessThan(t.calls.findIndex((c) => c.op === "app.deploy"));
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success" });
  });

  it("sends no peers for an app outside a project, and ignores an agent that predates connections", async () => {
    const t = await makeApi();
    t.handlers["connections.set"] = () => {
      throw new Error("unknown op");
    };
    const r = await t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB } });
    await t.api.jobs.idle();
    expect(t.calls.find((c) => c.op === "connections.set")!.args).toMatchObject({ peers: {} });
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "success" });
  });

  it("fails the deployment with a clear reason when peers exist but the agent can't take them", async () => {
    const t = await makeApi();
    await project(t);
    t.handlers["connections.set"] = () => {
      throw new Error("unknown op");
    };
    const r = await t.request("/v1/apps/web/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: WEB } });
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(r.json.id)).toMatchObject({ status: "failed" });
    expect(t.registry.deployments.get(r.json.id)?.error).toMatch(/upgrade it/);
    expect(t.calls.some((c) => c.op === "app.deploy")).toBe(false);
  });
});
