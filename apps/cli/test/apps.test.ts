import { afterEach, describe, expect, it } from "vitest";
import { cli, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const YAML = "name: shop\nservices:\n  web:\n    command: node web.mjs\n  worker:\n    command: node worker.mjs\n";
const svc = (name: string, o: Partial<{ activeState: string; subState: string; restarts: number; memoryBytes: number; hostnames: string[]; port: number }> = {}) => ({ name, unit: `freighter-shop--${name}.service`, port: o.port ?? null, hostnames: o.hostnames ?? [], activeState: o.activeState ?? "active", subState: o.subState ?? "running", restarts: o.restarts ?? 0, memoryBytes: o.memoryBytes ?? 118_000_000 });

async function setup(handlers: Record<string, (a: any) => unknown> = {}) {
  api = await startApi({ handlers });
  const { registry } = api;
  registry.apps.upsert({ name: "shop", server: "local", manifestText: YAML, currentRelease: "r20261114-101502", previousRelease: "r20261113-174411", status: "deployed" });
  registry.services.replace("shop", [svc("web", { hostnames: ["shop.example.com"], port: 20001 }), svc("worker", { activeState: "activating", subState: "auto-restart", restarts: 7, memoryBytes: 64_000_000 })]);
  registry.apps.upsert({ name: "blog", server: "contabo-1", manifestText: "name: blog\nservices:\n  web:\n    command: x\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
  registry.services.replace("blog", [{ ...svc("web", { hostnames: ["blog.example.com"] }), unit: "freighter-blog--web.service" }]);
  return { env: api.env(api.admin), registry };
}

describe("apps", () => {
  it("lists them, and filters by server and project", async () => {
    const { env, registry } = await setup();
    const all = await cli(["app", "list"], { env });
    expect(all.status).toBe(0);
    expect(all.stdout).toMatch(/APP\s+SERVER\s+STATE\s+SERVICES\s+RELEASE\s+DOMAIN/);
    expect(all.stdout).toMatch(/shop\s+local\s+deployed\s+1\/2\s+r20261114-101502\s+shop\.example\.com/);
    expect(all.stdout).toMatch(/blog\s+contabo-1\s+deployed\s+1\/1/);
    expect((await cli(["app", "list", "--server", "contabo-1", "-q"], { env })).stdout).toBe("blog\n");
    const p = registry.projects.create({ name: "Shop" });
    registry.apps.setProject("shop", p.id);
    expect((await cli(["app", "list", "--project", "Shop", "-q"], { env })).stdout).toBe("shop\n");
    expect((await cli(["app", "list", "--project", "nope"], { env })).status).toBe(4);
    const json = JSON.parse((await cli(["app", "list", "--json"], { env })).stdout);
    expect(json.map((a: { name: string }) => a.name).sort()).toEqual(["blog", "shop"]);
  });

  it("shows one app, and says when there is none", async () => {
    const { env } = await setup();
    const r = await cli(["app", "show", "shop"], { env });
    expect(r.stdout).toMatch(/server\s+local/);
    expect(r.stdout).toMatch(/release\s+r20261114-101502/);
    expect(r.stdout).toMatch(/web\s+running\s+0\s+118 MB/);
    expect(r.stdout).toMatch(/worker\s+retrying\s+7\s+64\.0 MB/);
    const none = await cli(["app", "show", "ghost"], { env });
    expect(none.status).toBe(4);
    expect(none.stderr).toContain('error: unknown app "ghost"');
  });

  it("takes the app from the app.yaml in the directory", async () => {
    const { env } = await setup();
    const r = await cli(["app", "show"], { env, cwd: new URL("../../../examples/hello", import.meta.url).pathname });
    expect(r.status).toBe(4); // `hello` is not deployed here: it did look for that app, not for a missing name
    expect(r.stderr).toContain('unknown app "hello"');
    const none = await cli(["app", "show"], { env });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("which app?");
  });

  it("moves an app into a project and out again, and deletes only when sure", async () => {
    const { env, registry } = await setup({ "app.delete": () => ({ app: "blog", units: ["u1"], hostnames: ["blog.example.com"] }) });
    registry.projects.create({ name: "Site" });
    expect((await cli(["app", "move", "blog", "--project", "Site"], { env })).stdout).toContain("Moved blog to Site.");
    expect(registry.apps.get("blog")?.projectId).toBeTruthy();
    expect((await cli(["app", "move", "blog", "--project", "none"], { env })).status).toBe(0);
    expect(registry.apps.get("blog")?.projectId).toBeNull();

    const refused = await cli(["app", "delete", "blog"], { env }); // nobody to ask
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("pass --yes");
    const gone = await cli(["app", "delete", "blog", "--yes"], { env });
    expect(gone.status).toBe(0);
    expect(gone.stdout).toContain("Deleted blog from contabo-1");
    expect(registry.apps.get("blog")).toBeUndefined();
    expect((await cli(["app", "delete", "blog", "--yes"], { env })).status).toBe(4);
  });
});

describe("services", () => {
  it("shows them with the state a person reads, for one app or every app", async () => {
    const { env } = await setup();
    const r = await cli(["ps", "shop"], { env });
    expect(r.stdout).toMatch(/SERVICE\s+STATE\s+RESTARTS\s+MEMORY\s+CPU\s+ADDRESS/);
    expect(r.stdout).toMatch(/web\s+running\s+0\s+118 MB\s+-\s+shop\.example\.com/);
    expect(r.stdout).toMatch(/worker\s+retrying\s+7/);
    const every = await cli(["ps"], { env });
    expect(every.stdout).toMatch(/APP\s+SERVICE/);
    expect(every.stdout).toMatch(/blog\s+web\s+running/);
    expect((await cli(["ps", "-q"], { env })).stdout).toBe("blog/web\nshop/web\nshop/worker\n");
    expect(JSON.parse((await cli(["ps", "shop", "--json"], { env })).stdout)[1]).toMatchObject({ name: "worker", state: "retrying" });
  });

  it("starts, restarts and stops, asking before it stops", async () => {
    const { env } = await setup({ "app.control": ({ verb, service }: { verb: string; service?: string }) => ({ units: service ? [`${verb}-one`] : [`${verb}-a`, `${verb}-b`] }) });
    const calls = () => api!.calls.filter((c) => c.op === "app.control").map((c) => `${c.args.verb}:${c.args.service ?? "*"}`);
    expect((await cli(["restart", "shop/web"], { env })).stdout).toContain("Restarted shop/web (1 service).");
    expect((await cli(["start", "shop"], { env })).stdout).toContain("Started shop (2 services).");
    expect((await cli(["stop", "shop"], { env })).status).toBe(1); // asks, and there is nobody to ask
    expect((await cli(["stop", "shop/worker", "--yes"], { env })).stdout).toContain("Stopped shop/worker");
    expect(calls()).toEqual(["restart:web", "start:*", "stop:worker"]);
    expect((await cli(["restart", "a/b/c"], { env })).status).toBe(2);
  });

  it("prints a service's log, and every service's with a tag when none is named", async () => {
    const { env } = await setup({ "app.logs": ({ service, lines }: { service: string; lines: number }) => ({ text: `${service} line 1\n${service} line 2\n`, lines }) });
    const one = await cli(["logs", "shop/web", "-n", "50"], { env });
    expect(one.stdout).toBe("web line 1\nweb line 2\n");
    expect(api!.calls.find((c) => c.op === "app.logs")!.args).toMatchObject({ service: "web", lines: 50 });
    const all = await cli(["logs", "shop"], { env });
    expect(all.stdout).toMatch(/web\s+web line 1/);
    expect(all.stdout).toMatch(/worker\s+worker line 2/);
    expect((await cli(["logs", "shop/web", "-n", "0"], { env })).status).toBe(2);
    expect((await cli(["logs", "shop/web"], { env: api!.env(api!.token("viewer")) })).status).toBe(3); // logs need the deployer role
  });

  it("follows a log, printing only what is new", async () => {
    let n = 0;
    const { env } = await setup({ "app.logs": () => ({ text: Array.from({ length: ++n + 1 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" }) });
    const r = await cli(["logs", "shop/web", "-f"], { env: { ...env, FREIGHTER_POLL_MS: "100" }, killAfterMs: 1500 });
    expect(r.status).toBe(130);
    const lines = r.stdout.trim().split("\n");
    expect(lines.slice(0, 4)).toEqual(["line 1", "line 2", "line 3", "line 4"]); // each poll adds one, never repeats
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("shows memory and CPU", async () => {
    const { env, registry } = await setup();
    registry.metrics.add([{ app: "shop", service: "web", unit: "u", active: "active", memoryBytes: 118_000_000, cpuNanos: 1_000_000_000, restarts: 0 }]);
    const r = await cli(["stats", "shop", "--since", "10m"], { env });
    expect(r.stdout).toMatch(/SERVICE\s+MEMORY\s+PEAK\s+CPU\s+PEAK\s+RESTARTS/);
    expect(r.stdout).toMatch(/web\s+118 MB/);
    expect((await cli(["stats", "shop", "--since", "soon"], { env })).status).toBe(2);
  });
});

describe("releases, deployments and projects", () => {
  it("lists releases newest first", async () => {
    const { env } = await setup({ "app.info": () => ({ app: "shop", release: "r2", previous: "r1", manifestText: YAML, services: {}, releases: [{ id: "r1", current: false, result: "success" }, { id: "r2", current: true, result: "success" }] }) });
    const r = await cli(["release", "list", "shop"], { env });
    expect(r.stdout).toMatch(/RELEASE\s+CURRENT\s+WHEN\s+RESULT/);
    expect(r.stdout.split("\n")[1]).toMatch(/^r2\s+yes/);
    expect((await cli(["release", "list", "shop", "-q"], { env })).stdout).toBe("r2\nr1\n");
  });

  it("lists, shows, logs and cancels deployments, by the short id the list prints", async () => {
    const { env, registry } = await setup({ "build.log": () => ({ text: "", next: 0, done: true }) });
    const ok = registry.deployments.create({ app: "shop", action: "deploy" });
    registry.deployments.update(ok.id, { status: "success", releaseId: "r20261114-101502" });
    registry.deployments.setLog(ok.id, "==> staging release\n==> release is live\n");
    const bad = registry.deployments.create({ app: "shop", action: "deploy" });
    registry.deployments.update(bad.id, { status: "failed", error: "directus-postgres: service is not stable\n  more" });
    const list = await cli(["deployment", "list"], { env });
    expect(list.stdout).toMatch(/ID\s+APP\s+ACTION\s+STATUS\s+RELEASE\s+WHEN/);
    expect(list.stdout).toContain(ok.id.slice(0, 8));
    expect((await cli(["deployment", "list", "--failed", "-q"], { env })).stdout).toBe(`${bad.id}\n`);
    expect((await cli(["deployment", "list", "shop", "-n", "1", "-q"], { env })).stdout.trim().split("\n")).toHaveLength(1);

    const shown = await cli(["deployment", "show", bad.id.slice(0, 8)], { env });
    expect(shown.stdout).toMatch(/status\s+failed/);
    expect(shown.stdout).toContain("service is not stable");
    expect((await cli(["deployment", "logs", ok.id.slice(0, 8)], { env })).stdout).toBe("==> staging release\n==> release is live\n");
    expect((await cli(["deployment", "show", "ffffffff"], { env })).status).toBe(4);
    expect((await cli(["deployment", "show", "zz"], { env })).status).toBe(2);
    expect((await cli(["deployment", "cancel", ok.id.slice(0, 8)], { env })).stderr).toContain("already over"); // the API refuses one that ended
  });

  it("makes, renames, shows and deletes projects", async () => {
    const { env, registry } = await setup();
    expect((await cli(["project", "create", "Site", "--description", "the shop"], { env })).stdout).toContain("Created project Site.");
    registry.apps.setProject("shop", registry.projects.list()[0]!.id);
    const list = await cli(["project", "list"], { env });
    expect(list.stdout).toMatch(/Site\s+1\s+the shop/);
    const show = await cli(["project", "show", "Site"], { env });
    expect(show.stdout).toMatch(/shop\s+web, worker/);
    expect((await cli(["project", "rename", "Site", "Store"], { env })).stdout).toContain("Renamed Site to Store.");
    expect((await cli(["project", "delete", "Store"], { env })).status).toBe(1); // asks first
    expect((await cli(["project", "delete", "Store", "--yes"], { env })).stdout).toContain("Deleted project Store.");
    expect(registry.apps.get("shop")?.projectId).toBeNull(); // the app stays
  });
});
