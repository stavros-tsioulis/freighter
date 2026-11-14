import { AgentError } from "@freighter/protocol";
import { describe, expect, it, vi } from "vitest";
import type { PushPayload } from "../src/index.ts";
import { makeApi } from "./helpers.ts";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

/** An API whose pushes are collected instead of sent; `fail` makes the next ones be refused with a status. */
async function makePushApi() {
  const sent: { endpoint: string; payload: PushPayload; urgency: string }[] = [];
  const state = { status: 0 };
  const t = await makeApi({
    pushSender: async (target, payload, _vapid, urgency) => {
      if (state.status) throw Object.assign(new Error("push service said no"), { statusCode: state.status });
      sent.push({ endpoint: target.endpoint, payload, urgency });
    },
  });
  const subscribe = (token: string, extra: Record<string, unknown> = {}, endpoint = ENDPOINT) =>
    t.request("/v1/push/subscriptions", { method: "POST", token, json: { endpoint, keys, label: "Chrome on Mac", ...extra } });
  return { ...t, sent, state, subscribe };
}

describe("push subscriptions", () => {
  it("is for signed-in users only", async () => {
    const t = await makePushApi();
    expect((await t.request("/v1/push")).status).toBe(401);
    expect((await t.request("/v1/push", { token: t.tokens.viewer })).status).toBe(200);
  });

  it("hands out the public key, which stays the same", async () => {
    const t = await makePushApi();
    const a = (await t.request("/v1/push", { token: t.tokens.viewer })).json;
    const b = (await t.request("/v1/push", { token: t.tokens.admin })).json;
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.events.map((e: { kind: string }) => e.kind)).toContain("deploy.failed");
  });

  it("subscribes a browser with the default events, and never lists its keys", async () => {
    const t = await makePushApi();
    const r = await t.subscribe(t.tokens.viewer);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ label: "Chrome on Mac", events: ["deploy.failed", "service.crashed", "service.recovered", "server.offline", "server.online"] });
    const listed = (await t.request("/v1/push", { token: t.tokens.viewer })).json.subscriptions;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(keys.auth);
    expect(JSON.stringify(listed)).not.toContain("fcm.googleapis.com");
  });

  it("subscribing again from the same browser updates it instead of adding another", async () => {
    const t = await makePushApi();
    const first = (await t.subscribe(t.tokens.viewer)).json.id;
    const second = (await t.subscribe(t.tokens.viewer, { events: ["server.offline"] })).json;
    expect(second.id).toBe(first);
    expect(second.events).toEqual(["server.offline"]);
    expect(t.registry.pushSubscriptions.list()).toHaveLength(1);
  });

  it.each([
    ["an address that is not a push service", "https://internal.example.com/hook"],
    ["a metadata address", "https://169.254.169.254/latest"],
    ["plain http", "http://fcm.googleapis.com/fcm/send/x"],
    ["a look-alike host", "https://fcm.googleapis.com.evil.example/x"],
    ["a custom port", "https://fcm.googleapis.com:8443/x"],
  ])("refuses %s", async (_what, endpoint) => {
    const t = await makePushApi();
    expect((await t.subscribe(t.tokens.viewer, {}, endpoint)).status).toBe(400);
    expect(t.registry.pushSubscriptions.list()).toEqual([]);
  });

  it("refuses an unknown event", async () => {
    const t = await makePushApi();
    expect((await t.subscribe(t.tokens.viewer, { events: ["everything"] })).status).toBe(400);
  });

  it("keeps one user's subscriptions from another, except that an admin can remove them", async () => {
    const t = await makePushApi();
    const id = (await t.subscribe(t.tokens.viewer)).json.id;
    expect((await t.request("/v1/push", { token: t.tokens.deployer })).json.subscriptions).toEqual([]);
    expect((await t.request(`/v1/push/subscriptions/${id}`, { method: "PATCH", token: t.tokens.deployer, json: { events: [] } })).status).toBe(404);
    expect((await t.request(`/v1/push/subscriptions/${id}/test`, { method: "POST", token: t.tokens.admin, json: {} })).status).toBe(404);
    expect((await t.request(`/v1/push/subscriptions/${id}`, { method: "DELETE", token: t.tokens.deployer })).status).toBe(404);
    expect((await t.request(`/v1/push/subscriptions/${id}`, { method: "DELETE", token: t.tokens.admin })).status).toBe(200);
    expect(t.registry.pushSubscriptions.list()).toEqual([]);
  });

  it("changes the events of a subscription", async () => {
    const t = await makePushApi();
    const id = (await t.subscribe(t.tokens.viewer)).json.id;
    const r = await t.request(`/v1/push/subscriptions/${id}`, { method: "PATCH", token: t.tokens.viewer, json: { events: ["deploy.succeeded"] } });
    expect(r.json.events).toEqual(["deploy.succeeded"]);
    expect(t.registry.pushSubscriptions.get(id)?.events).toEqual(["deploy.succeeded"]);
  });

  it("forgets the subscriptions of a token when it is revoked", async () => {
    const t = await makePushApi();
    const { token, row } = t.registry.tokens.create({ name: "phone", role: "viewer" });
    await t.subscribe(token);
    await t.request(`/v1/tokens/${row.id}`, { method: "DELETE", token: t.tokens.admin });
    expect(t.registry.pushSubscriptions.list()).toEqual([]);
  });

  it("sends a test notification, and reports why one failed", async () => {
    const t = await makePushApi();
    const id = (await t.subscribe(t.tokens.viewer)).json.id;
    expect((await t.request(`/v1/push/subscriptions/${id}/test`, { method: "POST", token: t.tokens.viewer, json: {} })).json).toEqual({ ok: true, error: null });
    expect(t.sent).toHaveLength(1);
    t.state.status = 500;
    const failed = (await t.request(`/v1/push/subscriptions/${id}/test`, { method: "POST", token: t.tokens.viewer, json: {} })).json;
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("500") });
    expect(t.registry.pushSubscriptions.get(id)?.lastError).toContain("500");
  });

  it("drops a subscription the push service says is gone", async () => {
    const t = await makePushApi();
    const id = (await t.subscribe(t.tokens.viewer)).json.id;
    t.state.status = 410;
    await t.request(`/v1/push/subscriptions/${id}/test`, { method: "POST", token: t.tokens.viewer, json: {} });
    expect(t.registry.pushSubscriptions.get(id)).toBeUndefined();
  });
});

describe("what is pushed", () => {
  const upload = async (t: Awaited<ReturnType<typeof makePushApi>>) => {
    const res = await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() });
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await t.api.jobs.idle();
    return res.json.id as string;
  };
  const sync = (t: Awaited<ReturnType<typeof makePushApi>>) => t.request("/v1/sync", { method: "POST", token: t.tokens.admin, json: {} });
  const service = (over: Record<string, unknown>) => ({
    unit: "freighter-shop--web--r2.service", port: 20001, hostnames: [], activeState: "active", subState: "running", mainPid: 7, memoryCurrent: 1, restarts: 0, ...over,
  });
  /** Make the fake agent report this about the service from now on. */
  const report = (t: Awaited<ReturnType<typeof makePushApi>>, over: Record<string, unknown>) => {
    const info = t.handlers["app.info"] as () => Record<string, any>;
    t.handlers["app.info"] = () => ({ ...info(), services: { web: service(over) } });
  };

  it("tells about a failed deployment, with the reason", async () => {
    const t = await makePushApi();
    await t.subscribe(t.tokens.viewer);
    t.handlers["app.deploy"] = () => {
      throw new AgentError("deploy_failed", "deploy of r3 failed:\n  web: no healthy response", { rolledBackTo: "r2", releaseId: "r3", historyAt: "2026-11-06T13:00:00.000Z" });
    };
    await upload(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject({ urgency: "high", payload: { title: "Deployment of shop failed", url: "/apps/shop?tab=deployments", tag: "deploy:shop" } });
    expect(t.sent[0]!.payload.body).toContain("deploy of r3 failed");
  });

  it("is quiet about a deployment that works", async () => {
    const t = await makePushApi();
    await t.subscribe(t.tokens.viewer);
    await upload(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent).toEqual([]);
  });

  it("tells about a deployment that works when asked to", async () => {
    const t = await makePushApi();
    await t.subscribe(t.tokens.viewer, { events: ["deploy.succeeded"] });
    await upload(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject({ urgency: "normal", payload: { title: "Deployment of shop succeeded", body: "Release r2 is live." } });
  });

  it("is quiet about a deployment someone canceled", async () => {
    const t = await makePushApi();
    await t.subscribe(t.tokens.viewer, { events: ["deploy.failed", "deploy.succeeded"] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.handlers["app.deploy"] = async () => {
      await gate;
      throw new Error("canceled");
    };
    t.handlers["deploy.cancel"] = () => {
      release();
      return { canceled: true };
    };
    const id = (await t.request("/v1/apps/shop/deployments", { method: "POST", token: t.tokens.deployer, body: await t.tarball() })).json.id as string;
    await vi.waitFor(() => expect(t.registry.deployments.get(id)?.status).toBe("running"));
    expect((await t.request(`/v1/deployments/${id}/cancel`, { method: "POST", token: t.tokens.deployer })).json.status).toBe("stopping");
    await t.api.jobs.idle();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.registry.deployments.get(id)?.error).toBe("Canceled by deployer");
    expect(t.sent).toEqual([]);
  });

  it("tells once when a service goes down, and again when it is back", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer);
    report(t, { activeState: "failed", subState: "failed" });
    await sync(t);
    await sync(t); // still down: nothing new to say
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]!.payload).toMatchObject({ title: "shop: web is down", tag: "service:shop:web" });

    report(t, {});
    await sync(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    expect(t.sent[1]!.payload).toMatchObject({ title: "shop: web is running again", tag: "service:shop:web" });
  });

  it("tells when a service that is up keeps restarting, but not more than once in a while", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer);
    report(t, { restarts: 3 });
    await sync(t);
    report(t, { restarts: 9 });
    await sync(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.payload.body).toBe("It restarted 3 times since the last check.");
  });

  it("does not take the restarts of a new release for a crash", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer);
    report(t, { unit: "freighter-shop--web--r3.service", restarts: 5 });
    await sync(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent).toEqual([]);
  });

  it("leaves a service alone while the app is being deployed", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer);
    t.registry.deployments.create({ app: "shop", action: "deploy" });
    report(t, { activeState: "failed", subState: "failed" });
    await sync(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sent).toEqual([]);
  });

  it("tells when a server goes offline and when it is back", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer);
    const ping = t.handlers.ping!;
    t.handlers.ping = () => {
      throw new AgentError("unavailable", "connection refused");
    };
    await sync(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]!.payload).toMatchObject({ title: "local is offline", body: expect.stringContaining("connection refused"), url: "/servers/local" });

    t.handlers.ping = ping;
    await sync(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    expect(t.sent[1]!.payload.title).toBe("local is reachable again");
  });

  it("sends only to the subscriptions that want the event", async () => {
    const t = await makePushApi();
    await sync(t);
    await t.subscribe(t.tokens.viewer, { events: ["server.offline"] }, ENDPOINT);
    await t.subscribe(t.tokens.admin, { events: ["service.crashed"] }, "https://updates.push.services.mozilla.com/wpush/v2/xyz");
    report(t, { activeState: "failed", subState: "failed" });
    await sync(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]!.endpoint).toContain("mozilla");
  });
});
