import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError, type AgentClient, type OpArgs, type OpName, type OpResult } from "@freighter/protocol";
import { PkiStore } from "@freighter/pki";
import { openRegistry, type Role } from "@freighter/registry";
import { toWebHandler } from "h3";
import { createApi, type ApiContext } from "../src/index.ts";

export const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Body = NonNullable<ConstructorParameters<typeof Request>[1]>["body"];

export const APP_YAML = "name: shop\nservices:\n  web:\n    command: node server.mjs\n";

type Handler = (args: never) => unknown;

let historyTick = 0;
/** Every real deploy writes its own history entry, so timestamps never repeat. */
const nextHistoryAt = () => new Date(Date.parse("2026-11-06T14:00:00.000Z") + ++historyTick * 1000).toISOString();

export function fakeAgent() {
  const calls: { op: string; args: unknown }[] = [];
  const handlers: Record<string, Handler> = {
    ping: () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", hostname: "box", capabilities: ["artifact.put", "images"] }),
    "host.status": () => ({ hostname: "box", uptimeSeconds: 100, load1: 0.5, memTotal: 1000, memFree: 500, diskTotalBytes: 2000, diskFreeBytes: 1000 }),
    "artifact.delete": () => ({}),
    "git.keygen": () => ({ publicKey: "ssh-ed25519 AAAAfakekey freighter:app", fingerprint: "SHA256:fakefingerprint" }),
    "ssh.import": ({ privateKey }: { privateKey: string }) => ({
      privateKey: `${privateKey.trim()}\n`,
      publicKey: `ssh-ed25519 AAAA${Buffer.from(privateKey).toString("hex").slice(0, 12)} me@laptop`,
      fingerprint: `SHA256:${Buffer.from(privateKey).toString("base64").slice(0, 20)}`,
      keyType: "ed25519",
      comment: "me@laptop",
    }),
    "ssh.generate": ({ comment }: { comment: string }) => ({
      privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${comment}\n-----END OPENSSH PRIVATE KEY-----\n`,
      publicKey: `ssh-ed25519 AAAAgenerated ${comment}`,
      fingerprint: `SHA256:gen-${comment}`,
      keyType: "ed25519",
      comment,
    }),
    "git.branches": () => ({ branches: [{ name: "main", default: true }, { name: "dev", default: false }], defaultBranch: "main" }),
    "git.inspect": () => ({ sha: "d".repeat(40), commit: { sha: "d".repeat(40), subject: "init", author: "Ada" }, hasManifest: true, valid: true, appName: "shop", error: null, buildCommands: [] }),
    "domains.get": () => ({ domains: [{ hostname: "shop.example.com", service: "web", tls: "auto" }] }),
    "domains.set": (a: { domains: unknown[] }) => ({ domains: a.domains, deploy: { app: "shop", releaseId: "r8", previous: "r7", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: nextHistoryAt() } }),
    "git.check": () => ({ sha: "a".repeat(40) }),
    "git.deploy": () => ({
      skipped: false,
      commit: { sha: "b".repeat(40), subject: "fix the bug", author: "Ada" },
      buildSeconds: 3,
      deploy: { app: "shop", releaseId: "r7", previous: "r6", units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: nextHistoryAt() },
    }),
    "build.log": () => ({ text: "==> building\nbuilt ok\n", next: 22, done: true }),
    "apps.list": () => ({ apps: ["shop"] }),
    "app.info": () => ({
      app: "shop",
      release: "r2",
      previous: "r1",
      manifestText: APP_YAML,
      services: {
        web: { unit: "freighter-shop--web--r2.service", port: 20001, hostnames: ["shop.example.com"], activeState: "active", subState: "running", mainPid: 7, memoryCurrent: 1024, restarts: 0 },
      },
      releases: [
        { id: "r1", current: false, result: "success" },
        { id: "r2", current: true, result: "success" },
      ],
    }),
    "app.history": () => ({ entries: [{ at: "2026-11-06T10:00:00.000Z", action: "deploy", release: "r1", previous: null, result: "success" }] }),
    "app.deploy": () => ({ app: "shop", releaseId: "r2", previous: "r1", units: [], removed: [], pruned: [], hostnames: [], warnings: ["w1"], verified: true, historyAt: "2026-11-06T11:00:00.000Z" }),
    "app.rollback": () => ({ app: "shop", from: "r2", to: "r1", verified: true, historyAt: "2026-11-06T12:00:00.000Z" }),
    "app.control": ({ verb }: { verb: string }) => ({ units: [`${verb}-unit`] }),
    "app.logs": () => ({ text: "line1\nline2\n" }),
    "env.list": () => ({ names: ["TOKEN"] }),
    "metrics.snapshot": () => ({ samples: [{ app: "shop", service: "web", unit: "freighter-shop--web--r2.service", activeState: "active", memoryBytes: 1000, cpuNanos: 1_000_000_000, restarts: 0 }] }),
    "env.set": () => ({}),
    "certs.status": () => ({ certs: [{ hostname: "shop.example.com", expires: null }] }),
    "certs.renew": () => ({ certs: [] }),
  };
  const agent: AgentClient = {
    async call<N extends OpName>(op: N, args: OpArgs<N>): Promise<OpResult<N>> {
      calls.push({ op, args });
      const h = handlers[op];
      if (!h) throw new Error(`no fake handler for ${op}`);
      return h(args as never) as OpResult<N>;
    },
    async putArtifact(id, filePath) {
      calls.push({ op: "putArtifact", args: { id, filePath } });
      return { path: `/remote-spool/${id}.tar.gz` };
    },
  };
  return { agent, calls, handlers };
}

export async function makeApi(opts: { maxUploadBytes?: number; publicIps?: string[] } = {}) {
  /** Fake DNS: hostname -> addresses (edit it in a test to "change the zone"). */
  const zone: Record<string, string[]> = {};
  const dns = {
    resolve4: async (h: string) => (zone[h] ?? []).filter((ip) => !ip.includes(":")),
    resolve6: async (h: string) => (zone[h] ?? []).filter((ip) => ip.includes(":")),
  };
  const dir = await mkdtemp(join(tmpdir(), "freighter-api-"));
  const registry = openRegistry(":memory:");
  const fake = fakeAgent();
  const fakes = new Map<string, ReturnType<typeof fakeAgent>>([["local", fake]]);
  /** The fake agent behind a server (created on first use). */
  const remote = (name: string) => {
    let f = fakes.get(name);
    if (!f) fakes.set(name, (f = fakeAgent()));
    return f;
  };
  const pki = new PkiStore(join(dir, "pki"));
  const ctx: ApiContext = {
    registry,
    pki,
    agents: {
      forServer(name) {
        if (!registry.servers.get(name)) throw new AgentError("not_found", `unknown server "${name}"`);
        return remote(name).agent;
      },
    },
    artifactsDir: join(dir, "spool"),
    maxUploadBytes: opts.maxUploadBytes ?? 10_000_000,
    trustProxy: true,
    dns,
    publicIps: opts.publicIps ?? ["203.0.113.7"],
  };
  const api = createApi(ctx);
  const handler = toWebHandler(api.app);
  const tokens = Object.fromEntries((["viewer", "deployer", "admin"] as Role[]).map((r) => [r, registry.tokens.create({ name: r, role: r }).token])) as Record<Role, string>;

  async function request(path: string, o: { method?: string; token?: string; json?: unknown; body?: Body; headers?: Record<string, string>; ip?: string } = {}) {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.json !== undefined) headers["content-type"] = "application/json";
    if (o.ip) headers["x-forwarded-for"] = o.ip;
    const res = await handler(new Request(`http://api.test${path}`, { method: o.method ?? "GET", headers, body: o.json !== undefined ? JSON.stringify(o.json) : o.body }));
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      json = { raw: text }; // e.g. the HTML body of a redirect
    }
    return { status: res.status, headers: res.headers, json };
  }

  /** gzip tarball with the given files. */
  async function tarball(files: Record<string, string> = { "app.yaml": APP_YAML, "server.mjs": "//\n" }) {
    const src = await mkdtemp(join(tmpdir(), "freighter-tar-src-"));
    for (const [n, t] of Object.entries(files)) await writeFile(join(src, n), t);
    const out = join(await mkdtemp(join(tmpdir(), "freighter-tar-")), "a.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", src, "."]);
    return readFileSync(out);
  }

  const spoolFiles = () => (existsSync(ctx.artifactsDir) ? readdirSync(ctx.artifactsDir) : []);
  return { ...fake, api, ctx, registry, tokens, request, tarball, spoolFiles, AgentError, remote, pki, zone };
}
