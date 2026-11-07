import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HC_MANIFEST, makeDeps, routed } from "@freighter/core/testing";
import { createCa, createCsr, fingerprint, issueClientCert, issueServerCert } from "@freighter/pki";
import { createAgentClient, type AgentClient } from "@freighter/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { enroll } from "../src/enroll.ts";
import { startAgent, type RunningAgent } from "../src/index.ts";

let agent: RunningAgent | undefined;
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await agent?.close();
  agent = undefined;
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function setupRemote(opts: { clientCn?: string } = {}) {
  const h = await makeDeps();
  const ca = await createCa();
  const { csrPem, keyPem } = await createCsr("agent");
  const serverCert = await issueServerCert({ ca, csrPem, name: "vps-1", hosts: ["127.0.0.1"] });
  const certDir = `${h.root}/etc/agent`;
  await mkdir(certDir, { recursive: true });
  await writeFile(`${certDir}/server.key`, keyPem);
  await writeFile(`${certDir}/server.crt`, serverCert);
  await writeFile(`${certDir}/ca.crt`, ca.certPem);
  h.deps.dev = true;
  h.deps.config.agent.artifactsDir = `${h.root}/spool`;
  h.deps.config.agent.maxArtifactMb = 1;
  h.deps.config.agent.remote = { enabled: true, listen: "127.0.0.1", port: 0, certDir, clientCn: "freighter-control-plane" };
  agent = await startAgent(h.deps, { socketPath: `${h.root}/run/agent.sock` });

  const client = await issueClientCert({ ca, commonName: opts.clientCn });
  const make = (over: Record<string, unknown> = {}): AgentClient =>
    createAgentClient({ kind: "tls", host: "127.0.0.1", port: agent!.remote!.port, ca: ca.certPem, cert: client.certPem, key: client.keyPem, pinnedFingerprint: fingerprint(serverCert), ...over }, { timeoutMs: 10_000 });
  return { ...h, ca, client, serverCert, make };
}

async function tarball(files: Record<string, string> = { "server.mjs": "// web\n" }) {
  const src = await mkdtemp(join(tmpdir(), "freighter-src-"));
  for (const [n, t] of Object.entries(files)) await writeFile(join(src, n), t);
  const out = join(await mkdtemp(join(tmpdir(), "freighter-tgz-")), "a.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", src, "."]);
  return out;
}

describe("remote agent over mutual TLS", () => {
  it("serves the protocol to the control plane's client certificate", async () => {
    const t = await setupRemote();
    const client = t.make();
    const ping = await client.call("ping", {});
    expect(ping.capabilities).toContain("artifact.put");
    const host = await client.call("host.status", {});
    expect(host.hostname).toBeTruthy();
    expect(host.memTotal).toBeGreaterThan(0);
    expect(await client.call("apps.list", {})).toEqual({ apps: [] });
  });

  it("drops clients whose certificate has the wrong common name, or is from another CA", async () => {
    const t = await setupRemote();
    const imposter = await issueClientCert({ ca: t.ca, commonName: "somebody-else" });
    await expect(t.make({ cert: imposter.certPem, key: imposter.keyPem }).call("ping", {})).rejects.toMatchObject({ code: "unavailable" });
    const otherCa = await createCa();
    const foreign = await issueClientCert({ ca: otherCa });
    await expect(t.make({ cert: foreign.certPem, key: foreign.keyPem }).call("ping", {})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses an agent whose certificate does not match the pinned fingerprint", async () => {
    const t = await setupRemote();
    const wrong = fingerprint((await createCa()).certPem);
    await expect(t.make({ pinnedFingerprint: wrong }).call("ping", {})).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/pinned fingerprint/) });
  });

  it("uploads an artifact, deploys it from the remote spool, then deletes it", async () => {
    const t = await setupRemote();
    const client = t.make();
    const file = await tarball({ v: "1" });
    const id = randomUUID();
    const { path } = await client.putArtifact(id, file);
    expect(path).toBe(`${t.deps.config.agent.artifactsDir}/${id}.tar.gz`);
    expect(createHash("sha256").update(await readFile(path)).digest("hex")).toBe(createHash("sha256").update(await readFile(file)).digest("hex"));

    const r = await client.call("app.deploy", { artifact: path, ...routed() });
    expect(r).toMatchObject({ app: "shop", hostnames: ["shop.example.com"] });
    expect((await client.call("app.info", { app: "shop" })).release).toBe(r.releaseId);

    await client.call("artifact.delete", { id });
    await expect(stat(path)).rejects.toThrow();
  });

  it("rejects bad uploads: oversize, wrong hash and bad ids", async () => {
    const t = await setupRemote();
    const client = t.make();
    const big = join(await mkdtemp(join(tmpdir(), "freighter-big-")), "big.tar.gz");
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024, 7));
    await expect(client.putArtifact(randomUUID(), big)).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/exceeds 1 MiB/) });

    const raw = client as unknown as { call: (op: string, args: unknown) => Promise<unknown> };
    await expect(raw.call("artifact.delete", { id: "../../etc/passwd" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("detects a corrupted upload (hash mismatch) and leaves nothing behind", async () => {
    const t = await setupRemote();
    // Talk to the agent with a client that lies about the hash.
    const { connect } = await import("node:tls");
    const id = randomUUID();
    const payload = Buffer.from("not really a tarball");
    const sock = connect({ host: "127.0.0.1", port: agent!.remote!.port, ca: t.ca.certPem, cert: t.client.certPem, key: t.client.keyPem, minVersion: "TLSv1.3" });
    const reply = await new Promise<string>((resolve) => {
      let data = "";
      sock.on("data", (d) => { data += d; if (data.includes("\n")) resolve(data); });
      sock.on("close", () => resolve(data));
      sock.write(JSON.stringify({ id: "1", op: "artifact.put", args: { id, size: payload.length, sha256: "f".repeat(64) } }) + "\n");
      sock.write(payload);
    });
    sock.destroy();
    expect(JSON.parse(reply)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    await expect(stat(`${t.deps.config.agent.artifactsDir}/${id}.tar.gz`)).rejects.toThrow();
  });

  it("keeps working on the unix socket alongside the TLS listener", async () => {
    const t = await setupRemote();
    expect((await createAgentClient(agent!.socketPath).call("ping", {})).version).toBeTruthy();
    expect(t.deps.config.agent.remote.enabled).toBe(true);
    expect(HC_MANIFEST).toBeTruthy();
  });
});

describe("freighter-agent enroll", () => {
  async function stubControl(respond: (body: { token: string; csr: string }) => Promise<{ status: number; json: unknown }>) {
    const srv = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", async () => {
        const r = await respond(JSON.parse(data));
        res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => srv.close(() => r())));
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }

  async function dirs() {
    const root = await mkdtemp(join(tmpdir(), "freighter-enroll-"));
    return { certDir: `${root}/agent`, configPath: `${root}/freighter/config.yaml` };
  }

  it("generates a key locally, installs the signed certificate and enables the listener", async () => {
    const ca = await createCa();
    let seenCsr = "";
    const control = await stubControl(async (b) => {
      seenCsr = b.csr;
      return { status: 200, json: { name: "vps-1", port: 7555, serverCert: await issueServerCert({ ca, csrPem: b.csr, name: "vps-1", hosts: ["127.0.0.1"] }), caCert: ca.certPem } };
    });
    const d = await dirs();
    await mkdir(dirname(d.configPath), { recursive: true });
    await writeFile(d.configPath, "drainSeconds: 9\n");
    const r = await enroll({ control, token: "tok", caFingerprint: fingerprint(ca.certPem), ...d });
    expect(r).toMatchObject({ name: "vps-1", port: 7555 });
    expect(seenCsr).toContain("CERTIFICATE REQUEST");
    expect((await stat(`${d.certDir}/server.key`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${d.certDir}/server.crt`, "utf8")).toContain("BEGIN CERTIFICATE");
    expect(await readFile(`${d.certDir}/ca.crt`, "utf8")).toBe(ca.certPem);
    const cfg = await readFile(d.configPath, "utf8");
    expect(cfg).toContain("drainSeconds: 9"); // existing settings preserved
    expect(cfg).toMatch(/enabled: true/);
    expect(cfg).toMatch(/port: 7555/);
  });

  it("refuses a CA that does not match the pinned fingerprint and writes nothing", async () => {
    const ca = await createCa();
    const control = await stubControl(async (b) => ({ status: 200, json: { name: "x", serverCert: await issueServerCert({ ca, csrPem: b.csr, name: "x", hosts: ["a.example.com"] }), caCert: ca.certPem } }));
    const d = await dirs();
    await expect(enroll({ control, token: "t", caFingerprint: fingerprint((await createCa()).certPem), ...d })).rejects.toThrow(/does not match the one you pinned/);
    await expect(stat(d.certDir)).rejects.toThrow();
  });

  it("surfaces control-plane errors", async () => {
    const control = await stubControl(async () => ({ status: 401, json: { error: { code: "unauthorized", message: "invalid or expired enrollment token" } } }));
    await expect(enroll({ control, token: "t", caFingerprint: "SHA256:00", ...(await dirs()) })).rejects.toThrow(/401.*invalid or expired enrollment token/);
  });
});
