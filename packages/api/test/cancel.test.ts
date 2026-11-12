import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const manifest = (name: string) => JSON.stringify({ name, services: { web: { image: "nginx:1" } } });
const deployResult = (app: string) => ({ app, releaseId: "r1", previous: null, units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: "2026-11-06T11:00:00.000Z" });

describe("canceling a deployment", () => {
  it("stops one that is waiting before it starts, and asks the server to stop one that is running", async () => {
    const t = await makeApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    t.handlers["app.deploy"] = async (a: { manifestText: string }) => {
      started++;
      await gate;
      if (canceled) throw new Error("canceled");
      return deployResult(JSON.parse(a.manifestText).name);
    };
    let canceled = false;
    t.handlers["deploy.cancel"] = () => {
      canceled = true;
      release();
      return { canceled: true };
    };
    const post = (app: string) => t.request(`/v1/apps/${app}/image-deployments`, { method: "POST", token: t.tokens.deployer, json: { manifest: manifest(app) } });
    const first = (await post("first")).json.id as string;
    const second = (await post("second")).json.id as string;
    const cancel = (id: string, token = t.tokens.deployer) => t.request(`/v1/deployments/${id}/cancel`, { method: "POST", token });

    expect((await cancel(first, t.tokens.viewer)).status).toBe(403);
    expect((await cancel("nope")).status).toBe(404);

    // the second one has not started: it never will
    const queued = await cancel(second);
    expect(queued.status).toBe(202);
    expect(queued.json.status).toBe("canceled");
    expect(t.registry.deployments.get(second)).toMatchObject({ status: "failed", error: "Canceled by deployer" });

    // the first one is running: the server is asked to stop it, and it ends as canceled
    for (let i = 0; i < 100 && t.registry.deployments.get(first)?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
    const running = await cancel(first);
    expect(running.json.status).toBe("stopping");
    expect(t.calls.find((c) => c.op === "deploy.cancel")!.args).toEqual({ id: first });
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(first)).toMatchObject({ status: "failed", error: "Canceled by deployer" });
    expect(started).toBe(1); // the canceled second one never reached the server
    expect((await cancel(first)).status).toBe(409); // over
    expect(t.registry.audit.list().filter((a) => a.action === "deploy.cancel")).toHaveLength(2);
  });

  it("says so when the server's agent is too old to cancel", async () => {
    const t = await makeApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.handlers["app.deploy"] = async () => {
      await gate;
      return deployResult("old");
    };
    t.handlers["deploy.cancel"] = () => {
      throw new t.AgentError("bad_request", 'unknown operation "deploy.cancel"');
    };
    const id = (await t.request("/v1/apps/old/image-deployments", { method: "POST", token: t.tokens.deployer, json: { manifest: manifest("old") } })).json.id as string;
    for (let i = 0; i < 100 && t.registry.deployments.get(id)?.status !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
    const r = await t.request(`/v1/deployments/${id}/cancel`, { method: "POST", token: t.tokens.deployer });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/predates canceling/);
    release();
    await t.api.jobs.idle();
    expect(t.registry.deployments.get(id)?.status).toBe("success"); // it was left alone
  });
});
