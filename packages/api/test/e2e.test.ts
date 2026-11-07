import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createNet, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enroll, startAgent, type RunningAgent } from "@freighter/agent";
import { makeDeps, routedManifest } from "@freighter/core/testing";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";
import { createApp, toNodeListener, toWebHandler, useBase } from "h3";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentDirectory, createApi } from "../src/index.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNet().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

describe("end to end: control plane + local agent + a real remote agent over mutual TLS", () => {
  it("enrolls a server, deploys to it, and shows the app pinned there", async () => {
    // --- control plane host: local agent, registry, PKI, API ---
    const A = await makeDeps();
    A.deps.dev = true;
    A.deps.config.agent.artifactsDir = `${A.root}/spool`;
    const localAgent: RunningAgent = await startAgent(A.deps, { socketPath: `${A.root}/run/agent.sock` });
    closers.push(() => localAgent.close());

    const registry = openRegistry(":memory:");
    const pki = new PkiStore(`${A.root}/pki`);
    const agents = await createAgentDirectory({ registry, localSocket: localAgent.socketPath, pki, timeoutMs: 15_000 });
    const api = createApi({ registry, pki, agents, artifactsDir: A.deps.config.agent.artifactsDir, maxUploadBytes: 10_000_000, trustProxy: false });
    const handler = toWebHandler(api.app);
    const admin = { authorization: `Bearer ${registry.tokens.create({ name: "admin", role: "admin" }).token}` };

    // the public enroll endpoint is reachable over plain HTTP, as it would be through HAProxy
    const outer = createApp();
    outer.use(useBase("/api", api.app.handler));
    const http: Server = createHttp(toNodeListener(outer));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => http.close(() => r())));
    const control = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    // --- admin registers the server ---
    const agentPort = await freePort();
    const added = await handler(new Request("http://x/v1/servers", { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ name: "remote", address: `127.0.0.1:${agentPort}` }) }));
    expect(added.status).toBe(201);
    const { enrollment } = (await added.json()) as { enrollment: { token: string; caFingerprint: string } };

    // --- remote host: enroll (key + CSR made locally), then start its agent with the TLS listener ---
    const B = await makeDeps();
    B.deps.dev = true;
    B.deps.config.agent.artifactsDir = `${B.root}/spool`;
    const certDir = `${B.root}/etc/agent`;
    const r = await enroll({ control, token: enrollment.token, caFingerprint: enrollment.caFingerprint, certDir, configPath: `${B.root}/etc/freighter/config.yaml` });
    expect(r).toMatchObject({ name: "remote", port: agentPort });
    expect(readFileSync(`${B.root}/etc/freighter/config.yaml`, "utf8")).toContain(`port: ${agentPort}`);
    B.deps.config.agent.remote = { enabled: true, listen: "127.0.0.1", port: agentPort, certDir, clientCn: "freighter-control-plane" };
    const remoteAgent = await startAgent(B.deps, { socketPath: `${B.root}/run/agent.sock` });
    closers.push(() => remoteAgent.close());

    // --- the control plane can now see it ---
    const sync = (await (await handler(new Request("http://x/v1/sync", { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: "{}" }))).json()) as { servers: Record<string, string> };
    expect(sync.servers).toEqual({ local: "online", remote: "online" });
    expect(registry.servers.get("remote")).toMatchObject({ status: "online", certFingerprint: expect.stringMatching(/^SHA256:/) });

    // --- deploy a tarball to the remote server ---
    const src = await mkdtemp(join(tmpdir(), "freighter-e2e-"));
    await writeFile(join(src, "app.yaml"), routedManifest());
    await writeFile(join(src, "server.mjs"), "//\n");
    const tgz = join(await mkdtemp(join(tmpdir(), "freighter-e2e-tgz-")), "a.tar.gz");
    execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
    const up = await handler(new Request("http://x/v1/apps/shop/deployments?server=remote", { method: "POST", headers: admin, body: readFileSync(tgz) }));
    expect(up.status).toBe(202);
    const { id } = (await up.json()) as { id: string };
    await api.jobs.idle();

    const dep = (await (await handler(new Request(`http://x/v1/deployments/${id}`, { headers: admin }))).json()) as Record<string, unknown>;
    expect(dep).toMatchObject({ status: "success", server: "remote", source: "api" });

    // it really ran on host B, not on host A
    expect(existsSync(`${B.deps.layout.appsRoot}/shop/current`)).toBe(true);
    expect(existsSync(`${A.deps.layout.appsRoot}/shop`)).toBe(false);
    expect(existsSync(`${B.deps.config.agent.artifactsDir}/${id}.tar.gz`)).toBe(false); // remote spool cleaned

    const app = (await (await handler(new Request("http://x/v1/apps/shop", { headers: admin }))).json()) as { server: string; status: string; currentRelease: string; services: { name: string }[] };
    expect(app).toMatchObject({ server: "remote", status: "deployed", currentRelease: dep.releaseId });
    expect(app.services.map((s) => s.name)).toEqual(["web", "worker"]);

    // a domain is added, verified (a .localhost name needs no DNS), and applied over mTLS
    const json = { ...admin, "content-type": "application/json" };
    const addedDomain = await handler(new Request("http://x/v1/apps/shop/domains", { method: "POST", headers: json, body: JSON.stringify({ hostname: "shop.localhost", service: "web", tls: "off" }) }));
    expect(addedDomain.status).toBe(201);
    const verified = await handler(new Request("http://x/v1/apps/shop/domains/shop.localhost/verify", { method: "POST", headers: admin }));
    expect(verified.status).toBe(202);
    await api.jobs.idle();
    const dom = (await (await handler(new Request("http://x/v1/apps/shop/domains", { headers: admin }))).json()) as { domains: { hostname: string; status: string }[] };
    expect(dom.domains.map((d) => [d.hostname, d.status])).toEqual([["shop.localhost", "active"]]);
    expect(readFileSync(`${B.deps.config.haproxy.dir}/hostnames.map`, "utf8")).toContain("shop.localhost be_shop_web");

    // stopping the remote agent makes the server offline without affecting local
    await remoteAgent.close();
    const after = (await (await handler(new Request("http://x/v1/sync", { method: "POST", headers: { ...admin, "content-type": "application/json" }, body: "{}" }))).json()) as { servers: Record<string, string> };
    expect(after.servers).toEqual({ local: "online", remote: "offline" });
  });
});
