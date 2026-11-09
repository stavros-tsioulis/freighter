import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

describe("projects", () => {
  it("creates, lists, renames and deletes; only admins change them, anyone signed in lists them", async () => {
    const t = await makeApi();
    const mk = (name: string, token = t.tokens.admin) => t.request("/v1/projects", { method: "POST", token, json: { name, description: "d" } });
    expect((await mk("Storefront", t.tokens.deployer)).status).toBe(403);
    const made = await mk("Storefront");
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ name: "Storefront", description: "d", appCount: 0 });
    expect((await mk("storefront")).status).toBe(409);
    expect((await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "  " } })).status).toBe(400);
    expect((await t.request("/v1/projects", { token: t.tokens.viewer })).json.projects).toHaveLength(1);

    const id = made.json.id as string;
    const other = await mk("Internal");
    expect((await t.request(`/v1/projects/${id}`, { method: "PATCH", token: t.tokens.admin, json: { name: "internal" } })).status).toBe(409);
    const renamed = await t.request(`/v1/projects/${id}`, { method: "PATCH", token: t.tokens.admin, json: { name: "Shop" } });
    expect(renamed.json).toMatchObject({ name: "Shop", description: "d" });
    expect((await t.request("/v1/projects/prj_nope", { method: "PATCH", token: t.tokens.admin, json: { name: "x" } })).status).toBe(404);

    expect((await t.request(`/v1/projects/${other.json.id}`, { method: "DELETE", token: t.tokens.deployer })).status).toBe(403);
    expect((await t.request(`/v1/projects/${other.json.id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(200);
    expect((await t.request("/v1/projects", { token: t.tokens.viewer })).json.projects.map((p: { name: string }) => p.name)).toEqual(["Shop"]);
  });

  it("moves apps in and out of projects (deployers can), and deleting a project ungroups its apps", async () => {
    const t = await makeApi();
    t.registry.apps.ensure("shop", "local");
    const p = (await t.request("/v1/projects", { method: "POST", token: t.tokens.admin, json: { name: "Shop" } })).json;
    const put = (projectId: string | null, app = "shop", token = t.tokens.deployer) => t.request(`/v1/apps/${app}/project`, { method: "PUT", token, json: { projectId } });
    expect((await put(p.id, "shop", t.tokens.viewer)).status).toBe(403);
    expect((await put(p.id)).status).toBe(200);
    expect((await put("prj_nope")).status).toBe(404);
    expect((await put(p.id, "ghost")).status).toBe(404);
    expect((await t.request("/v1/apps", { token: t.tokens.viewer })).json.apps[0].projectId).toBe(p.id);
    expect((await t.request("/v1/apps/shop", { token: t.tokens.viewer })).json.projectId).toBe(p.id);
    expect((await t.request("/v1/projects", { token: t.tokens.viewer })).json.projects[0].appCount).toBe(1);

    await t.request(`/v1/projects/${p.id}`, { method: "DELETE", token: t.tokens.admin });
    expect(t.registry.apps.get("shop")?.projectId).toBeNull();
    expect((await put(null)).status).toBe(200);
  });
});
