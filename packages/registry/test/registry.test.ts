import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/migrations.ts";
import { existsSync, readFileSync } from "node:fs";
import { createSecretBox, hashToken, memorySecretBox, openRegistry, roleAtLeast } from "../src/index.ts";

const mem = () => openRegistry(":memory:");

describe("registry", () => {
  it("migrates once and is reopenable", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "freighter-db-")), "sub", "r.db");
    const a = openRegistry(path);
    expect(a.schemaVersion()).toBe(16);
    a.tokens.create({ name: "x", role: "admin" });
    a.close();
    const b = openRegistry(path);
    expect(b.schemaVersion()).toBe(16);
    expect(b.tokens.list()).toHaveLength(1);
  });

  it("stores only the token hash and verifies, revokes", () => {
    const r = mem();
    const { token, row } = r.tokens.create({ name: "ci", role: "deployer" });
    expect(token).toMatch(/^fr_[A-Za-z0-9_-]{43}$/);
    expect(r.tokens.verify(token)).toMatchObject({ id: row.id, role: "deployer" });
    expect(r.tokens.verify(token + "x")).toBeNull();
    expect(JSON.stringify(r.tokens.list())).not.toContain(token);
    expect(JSON.stringify(r.tokens.list())).not.toContain(hashToken(token));
    expect(r.tokens.revoke(row.id)).toBe(true);
    expect(r.tokens.revoke(row.id)).toBe(false);
    expect(r.tokens.verify(token)).toBeNull();
    expect(() => r.tokens.create({ name: "x", role: "root" as never })).toThrow(/invalid role/);
  });

  it("orders roles", () => {
    expect(roleAtLeast("admin", "deployer")).toBe(true);
    expect(roleAtLeast("viewer", "deployer")).toBe(false);
  });

  it("upserts apps and replaces services", () => {
    const r = mem();
    r.apps.upsert({ name: "shop", manifestText: "m", currentRelease: "r1", previousRelease: null, status: "deployed" });
    r.apps.upsert({ name: "shop", manifestText: "m2", currentRelease: "r2", previousRelease: "r1", status: "deployed" });
    expect(r.apps.get("shop")).toMatchObject({ currentRelease: "r2", previousRelease: "r1", manifestText: "m2" });
    const svc = { name: "web", unit: "u", port: 20000, hostnames: ["a.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: null };
    r.services.replace("shop", [svc, { ...svc, name: "worker", port: null, hostnames: [] }]);
    r.services.replace("shop", [svc]);
    expect(r.services.list("shop")).toHaveLength(1);
    expect(r.services.list("shop")[0]).toMatchObject({ hostnames: ["a.example.com"], port: 20000 });
    r.apps.upsert({ name: "gone", manifestText: null, currentRelease: null, previousRelease: null, status: "deployed" });
    r.apps.markMissing(["shop"]);
    expect(r.apps.get("gone")?.status).toBe("missing");
    expect(r.apps.get("shop")?.status).toBe("deployed");
  });

  it("imports host history idempotently and lets API rows win", () => {
    const r = mem();
    const e = { at: "2026-11-06T10:00:00.000Z", action: "deploy" as const, release: "r1", previous: null, result: "success" as const };
    expect(r.deployments.importHistory("shop", [e])).toBe(1);
    expect(r.deployments.importHistory("shop", [e])).toBe(0);
    expect(r.deployments.list({ app: "shop" })[0]).toMatchObject({ source: "host", status: "success", releaseId: "r1" });

    const api = r.deployments.create({ app: "shop", action: "deploy", requestedBy: "tok_1" });
    r.deployments.update(api.id, { status: "success", releaseId: "r1", historyAt: e.at, finishedAt: e.at });
    const rows = r.deployments.list({ app: "shop" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: api.id, source: "api" });
  });

  it("marks queued/running deployments as interrupted", () => {
    const r = mem();
    const a = r.deployments.create({ app: "x", action: "deploy" });
    const b = r.deployments.create({ app: "x", action: "deploy" });
    r.deployments.update(b.id, { status: "success" });
    expect(r.deployments.markInterrupted()).toBe(1);
    expect(r.deployments.get(a.id)).toMatchObject({ status: "failed", error: "interrupted by API restart" });
    expect(r.deployments.get(b.id)?.status).toBe("success");
  });

  it("records and lists audit entries newest first", () => {
    const r = mem();
    r.audit.add({ tokenId: "t", action: "env.set", app: "shop", detail: { key: "K" } });
    r.audit.add({ action: "sync" });
    expect(r.audit.list().map((a) => a.action)).toEqual(["sync", "env.set"]);
    expect(r.audit.list()[1]?.detail).toEqual({ key: "K" });
  });

  it("migrates an existing v1 database to v2 without losing data", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "freighter-db-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.exec(migrations[0]!);
    old.exec("INSERT INTO meta VALUES ('schema_version', '1')");
    old.exec("INSERT INTO apps (name, status, updated_at) VALUES ('shop', 'deployed', 'x')");
    old.close();
    const r = openRegistry(path);
    expect(r.schemaVersion()).toBe(16);
    expect(r.apps.get("shop")?.status).toBe("deployed");
    r.metrics.add([{ app: "shop", service: "web", unit: "u", active: "active", memoryBytes: 1, cpuNanos: 2, restarts: 0 }]);
    expect(r.metrics.series("shop", "")).toHaveLength(1);
  });

  it("stores, queries and prunes metric samples", () => {
    const r = mem();
    const row = (service: string, cpu: number) => ({ app: "shop", service, unit: `u-${service}`, active: "active", memoryBytes: 100, cpuNanos: cpu, restarts: 0 });
    r.metrics.add([row("web", 1), row("worker", 1)], "2026-11-06T10:00:00.000Z");
    r.metrics.add([row("web", 2), row("worker", 2)], "2026-11-06T10:00:15.000Z");
    r.metrics.add([{ ...row("web", 1), app: "other" }], "2026-11-06T10:00:15.000Z");
    const s = r.metrics.series("shop", "2026-11-06T10:00:10.000Z");
    expect(s.map((x) => [x.service, x.at, x.cpuNanos])).toEqual([
      ["web", "2026-11-06T10:00:15.000Z", 2],
      ["worker", "2026-11-06T10:00:15.000Z", 2],
    ]);
    expect(r.metrics.prune("2026-11-06T10:00:10.000Z")).toBe(2);
    expect(r.metrics.series("shop", "")).toHaveLength(2);
  });

  it("migrates v2 to v3: seeds the local server and pins existing apps to it", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "freighter-db-")), "v2.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    old.exec(migrations[0]!);
    old.exec(migrations[1]!);
    old.exec("INSERT INTO meta VALUES ('schema_version', '2')");
    old.exec("INSERT INTO apps (name, status, updated_at) VALUES ('shop', 'deployed', 'x')");
    old.close();
    const r = openRegistry(path);
    expect(r.schemaVersion()).toBe(16);
    expect(r.apps.get("shop")?.server).toBe("local");
    expect(r.servers.list().map((s) => [s.name, s.kind, s.status, s.appCount])).toEqual([["local", "local", "online", 1]]);
  });

  it("can run without a local server, unless apps or history still point at it", () => {
    const r = openRegistry(":memory:");
    expect(r.servers.setLocal(false)).toBe(true);
    expect(r.servers.list()).toEqual([]);
    expect(r.servers.setLocal(true)).toBe(true);
    expect(r.servers.get("local")?.kind).toBe("local");
    r.apps.upsert({ name: "shop", server: "local", manifestText: null, currentRelease: null, previousRelease: null, status: "undeployed" });
    expect(r.servers.setLocal(false)).toBe(false); // an app is pinned to it
    expect(r.servers.get("local")).not.toBeNull();
    expect(r.servers.setLocal(true)).toBe(true); // idempotent
  });

  it("bootstraps one admin token on first run only", () => {
    const r = openRegistry(":memory:");
    const token = "fr_" + "a".repeat(40);
    expect(() => r.tokens.bootstrap("fr_short")).toThrow(/at least 32/);
    expect(r.tokens.bootstrap(token)).toBe(true);
    expect(r.tokens.verify(token)).toMatchObject({ name: "bootstrap", role: "admin" });
    expect(r.tokens.bootstrap(token)).toBe(false); // already there
    r.tokens.revoke(r.tokens.list()[0]!.id);
    expect(r.tokens.bootstrap(token)).toBe(false); // revoking it does not bring it back
    expect(r.tokens.verify(token)).toBeNull();
    const other = openRegistry(":memory:");
    other.tokens.create({ name: "me", role: "admin" });
    expect(other.tokens.bootstrap(token)).toBe(false); // someone already has access
  });

  it("manages remote servers and their one-time enrollment tokens", () => {
    let t = Date.parse("2026-11-06T10:00:00.000Z");
    const r = openRegistry(":memory:", { now: () => new Date(t) });
    const s = r.servers.create({ name: "vps-1", address: "vps1.example.com:7443" });
    expect(s).toMatchObject({ kind: "remote", status: "pending", enrollmentPending: false, appCount: 0 });
    expect(() => r.servers.create({ name: "vps-1", address: "x" })).toThrow();

    const token = r.servers.newEnrollment("vps-1");
    expect(token).toMatch(/^fre_/);
    expect(r.servers.get("vps-1")?.enrollmentPending).toBe(true);
    expect(JSON.stringify(r.servers.get("vps-1"))).not.toContain(token);
    expect(r.servers.consumeEnrollment("fre_wrong")).toBeNull();
    expect(r.servers.consumeEnrollment(token)?.name).toBe("vps-1");
    expect(r.servers.consumeEnrollment(token)).toBeNull(); // single use
    expect(() => r.servers.newEnrollment("local")).toThrow(/unknown remote server/);

    const stale = r.servers.newEnrollment("vps-1", 60_000);
    t += 61_000;
    expect(r.servers.consumeEnrollment(stale)).toBeNull(); // expired

    r.servers.setCert("vps-1", "SHA256:AA", "2027-11-06T10:00:00.000Z");
    expect(r.servers.get("vps-1")).toMatchObject({ status: "offline", certFingerprint: "SHA256:AA" });
    r.servers.markSeen("vps-1", { agentVersion: "1.2.3", hostname: "box", host: { hostname: "box", uptimeSeconds: 5, load1: 0.1, memTotal: 10, memFree: 5, diskTotalBytes: 100, diskFreeBytes: 50 } });
    expect(r.servers.get("vps-1")).toMatchObject({ status: "online", agentVersion: "1.2.3", host: { memFree: 5 } });
    r.servers.markError("vps-1", "ECONNREFUSED");
    expect(r.servers.get("vps-1")).toMatchObject({ status: "offline", lastError: "ECONNREFUSED" });
  });

  it("pins apps to servers and never moves them", () => {
    const r = mem();
    r.servers.create({ name: "vps-1", address: "a:1" });
    r.apps.ensure("shop", "vps-1");
    r.apps.ensure("shop", "local"); // ignored: already pinned
    r.apps.upsert({ name: "shop", manifestText: "m", currentRelease: "r1", previousRelease: null, status: "deployed" }); // sync does not move it
    expect(r.apps.get("shop")?.server).toBe("vps-1");
    expect(r.servers.get("vps-1")?.appCount).toBe(1);
    const d = r.deployments.create({ app: "shop", server: "vps-1", action: "deploy" });
    expect(d.server).toBe("vps-1");
    r.deployments.importHistory("shop", [{ at: "2026-11-06T10:00:00.000Z", action: "deploy", release: "r1", previous: null, result: "success" }]);
    expect(r.deployments.list({ app: "shop" }).every((x) => x.server === "vps-1")).toBe(true);
    expect(r.servers.remove("local")).toBe(false);
    expect(r.servers.remove("vps-1")).toBe(true);
  });

  it("migrates v3 to v4 keeping deployments, which gain the upload trigger", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "freighter-db-")), "v3.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const m of migrations.slice(0, 3)) old.exec(m);
    old.exec("INSERT INTO meta VALUES ('schema_version', '3')");
    old.exec("INSERT INTO deployments (id, app, action, status, source, created_at) VALUES ('d1', 'shop', 'deploy', 'success', 'api', 'x')");
    old.close();
    const r = openRegistry(path);
    expect(r.schemaVersion()).toBe(16);
    expect(r.deployments.get("d1")).toMatchObject({ trigger: "upload", commitSha: null });
  });

  it("stores git links, hides nothing from the registry layer, and tracks deliveries", () => {
    const r = mem();
    const input = { app: "shop", provider: "github" as const, repository: "git@github.com:o/r.git", branch: "main", subpath: "", autoDeploy: true, webhookSecret: "s3", publicKey: "ssh-ed25519 AAAA", keyFingerprint: "SHA256:x" };
    expect(r.gitLinks.get("shop")).toBeUndefined();
    const link = r.gitLinks.upsert(input);
    expect(link).toMatchObject({ ...input, lastDeliveryAt: null });
    r.gitLinks.markDelivery("shop", "deployed abc");
    expect(r.gitLinks.get("shop")).toMatchObject({ lastDeliveryResult: "deployed abc" });
    expect(r.gitLinks.upsert({ ...input, branch: "release", autoDeploy: false })).toMatchObject({ branch: "release", autoDeploy: false, lastDeliveryResult: "deployed abc" });
    expect(r.gitLinks.remove("shop")).toBe(true);
    expect(r.gitLinks.remove("shop")).toBe(false);
  });

  it("records commits on deployments, keeps logs apart, and imports commits from host history", () => {
    const r = mem();
    const d = r.deployments.create({ app: "shop", action: "deploy", trigger: "webhook" });
    expect(d).toMatchObject({ trigger: "webhook", commitSha: null });
    r.deployments.update(d.id, { commitSha: "abc123", commitSubject: "fix", commitAuthor: "Ada" });
    r.deployments.setLog(d.id, "line1\nline2\n");
    expect(r.deployments.get(d.id)).toMatchObject({ commitSha: "abc123", commitSubject: "fix", commitAuthor: "Ada" });
    expect(JSON.stringify(r.deployments.get(d.id))).not.toContain("line1"); // rows never carry the log
    expect(r.deployments.getLog(d.id)).toBe("line1\nline2\n");
    expect(r.deployments.getLog("nope")).toBeNull();

    r.deployments.importHistory("blog", [
      { at: "2026-11-06T10:00:00.000Z", action: "deploy", release: "r1", previous: null, result: "success", source: { type: "git", sha: "def456", ref: "refs/heads/main", subject: "ship it", author: "Bob" } },
    ]);
    expect(r.deployments.list({ app: "blog" })[0]).toMatchObject({ source: "host", trigger: "host", commitSha: "def456", commitSubject: "ship it", commitAuthor: "Bob" });
  });

  it("migrates v4 to v6 keeping existing git links", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "freighter-db-")), "v4.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const m of migrations.slice(0, 4)) old.exec(m);
    old.exec("INSERT INTO meta VALUES ('schema_version', '4')");
    old.exec("INSERT INTO git_links (app, provider, repository, branch, webhook_secret, public_key, created_at) VALUES ('shop', 'github', 'git@github.com:a/b.git', 'main', 's', 'k', 'x')");
    old.close();
    const r = openRegistry(path);
    expect(r.schemaVersion()).toBe(16);
    expect(r.gitLinks.get("shop")).toMatchObject({ repository: "git@github.com:a/b.git", sshKeyId: null });
  });

  it("encrypts secrets at rest and decrypts them for callers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "freighter-db-"));
    const path = join(dir, "r.db");
    const r = openRegistry(path);
    const k = r.sshKeys.create({ name: "deploy", keyType: "ed25519", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:x", privateKey: "PRIVATE-KEY-MATERIAL" });
    expect(r.sshKeys.privateKey(k.id)).toBe("PRIVATE-KEY-MATERIAL");
    expect(JSON.stringify(r.sshKeys.get(k.id))).not.toContain("PRIVATE-KEY-MATERIAL");
    r.close();
    const raw = readFileSync(path).toString("latin1") + (existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).toString("latin1") : "");
    expect(raw).not.toContain("PRIVATE-KEY-MATERIAL");
    // the key file persists, so the next process can read them again
    const again = openRegistry(path);
    expect(again.sshKeys.privateKey(k.id)).toBe("PRIVATE-KEY-MATERIAL");
    expect((await import("node:fs")).statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
  });

  it("secret boxes reject tampering and wrong keys", async () => {
    const a = memorySecretBox();
    const sealed = a.seal("hello");
    expect(a.open(sealed)).toBe("hello");
    expect(sealed).not.toContain("hello");
    expect(() => a.open(sealed.slice(0, -4) + "AAAA")).toThrow();
    expect(() => memorySecretBox().open(sealed)).toThrow();
    expect(() => a.open("garbage")).toThrow(/unrecognised/);
    const dir = await mkdtemp(join(tmpdir(), "freighter-key-"));
    const k1 = createSecretBox(join(dir, "k"));
    expect(createSecretBox(join(dir, "k")).open(k1.seal("x"))).toBe("x");
  });

  it("ssh keys are unique, counted by the apps using them, and removable", () => {
    const r = mem();
    const k = r.sshKeys.create({ name: "work", keyType: "ed25519", publicKey: "ssh-ed25519 AAAA", fingerprint: "SHA256:aaa", privateKey: "P" });
    expect(k.appCount).toBe(0);
    expect(() => r.sshKeys.create({ name: "work", keyType: "ed25519", publicKey: "x", fingerprint: "SHA256:bbb", privateKey: "P" })).toThrow();
    expect(() => r.sshKeys.create({ name: "other", keyType: "ed25519", publicKey: "x", fingerprint: "SHA256:aaa", privateKey: "P" })).toThrow();
    r.gitLinks.upsert({ app: "shop", provider: "other", repository: "git@example.com:a/b.git", branch: "main", subpath: "", autoDeploy: true, webhookSecret: "", publicKey: "", keyFingerprint: "", sshKeyId: k.id });
    expect(r.sshKeys.get(k.id)?.appCount).toBe(1);
    r.sshKeys.touch(k.id);
    expect(r.sshKeys.get(k.id)?.lastUsedAt).not.toBeNull();
    expect(r.sshKeys.list()).toHaveLength(1);
    expect(r.sshKeys.remove(k.id)).toBe(true);
    expect(r.sshKeys.privateKey(k.id)).toBeNull();
  });

  it("migrates v5 to v6 dropping provider integrations but keeping git links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "freighter-db-"));
    const path = join(dir, "r.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const m of migrations.slice(0, 5)) old.exec(m);
    old.exec("INSERT INTO meta VALUES ('schema_version', '5')");
    old.exec("INSERT INTO git_links (app, provider, repository, branch, webhook_secret, public_key, created_at) VALUES ('shop', 'github', 'git@github.com:a/b.git', 'main', 's', 'k', 'x')");
    old.close();
    const r = openRegistry(path);
    expect(r.schemaVersion()).toBe(16);
    expect(r.gitLinks.get("shop")).toMatchObject({ branch: "main", sshKeyId: null });
    expect(r.sshKeys.list()).toEqual([]);
  });
});

describe("pending domains", () => {
  it("are unique per hostname, listed per app, and record the last check", () => {
    const r = openRegistry(":memory:");
    r.pendingDomains.create({ hostname: "a.example.com", app: "shop", service: "web", tls: "auto" });
    r.pendingDomains.create({ hostname: "b.example.com", app: "blog", service: "web", tls: "off" });
    expect(() => r.pendingDomains.create({ hostname: "a.example.com", app: "blog", service: "web", tls: "auto" })).toThrow();
    expect(r.pendingDomains.list("shop").map((d) => d.hostname)).toEqual(["a.example.com"]);
    expect(r.pendingDomains.list()).toHaveLength(2);
    r.pendingDomains.markChecked("a.example.com", "does not resolve");
    expect(r.pendingDomains.get("a.example.com")).toMatchObject({ lastError: "does not resolve", checkedAt: expect.any(String) });
    expect(r.pendingDomains.remove("a.example.com")).toBe(true);
    expect(r.pendingDomains.get("a.example.com")).toBeUndefined();
  });
});

describe("forgetting an app", () => {
  it("removes the app and everything recorded about it, and nothing about other apps", () => {
    const r = openRegistry(":memory:");
    const seed = (name: string) => {
      r.apps.upsert({ name, server: "local", manifestText: "name: x\n", currentRelease: "r1", previousRelease: null, status: "deployed" });
      r.services.replace(name, [{ name: "web", unit: `${name}-web`, port: 1, hostnames: [], activeState: "active", subState: "running", restarts: 0, memoryBytes: 1 }]);
      const d = r.deployments.create({ app: name, action: "deploy" });
      r.deployments.setLog(d.id, "log");
      r.pendingDomains.create({ hostname: `${name}.example.com`, app: name, service: "web", tls: "auto" });
      r.gitLinks.upsert({ app: name, provider: "other", repository: "git@example.com:a/b.git", branch: "main", subpath: "", autoDeploy: true, webhookSecret: "s", publicKey: "", keyFingerprint: "" });
      r.metrics.add([{ app: name, service: "web", unit: `${name}-web`, active: "active", memoryBytes: 1, cpuNanos: 1, restarts: 0 }]);
      return d.id;
    };
    const gone = seed("shop");
    const kept = seed("blog");
    r.audit.add({ tokenId: null, action: "deploy", app: "shop" });

    expect(r.apps.remove("shop")).toBe(true);
    expect(r.apps.remove("shop")).toBe(false);
    expect(r.apps.get("shop")).toBeUndefined();
    expect(r.services.list("shop")).toEqual([]);
    expect(r.deployments.get(gone)).toBeUndefined();
    expect(r.deployments.getLog(gone)).toBeNull();
    expect(r.pendingDomains.list("shop")).toEqual([]);
    expect(r.gitLinks.get("shop")).toBeUndefined();
    expect(r.audit.list().some((a) => a.app === "shop")).toBe(true); // history of who did what stays
    expect(r.metrics.series("shop", "1970-01-01T00:00:00.000Z")).toEqual([]);
    expect(r.metrics.series("blog", "1970-01-01T00:00:00.000Z")).toHaveLength(1);

    expect(r.apps.get("blog")).toBeDefined();
    expect(r.services.list("blog")).toHaveLength(1);
    expect(r.deployments.get(kept)).toBeDefined();
    expect(r.pendingDomains.list("blog")).toHaveLength(1);
    expect(r.gitLinks.get("blog")).toBeDefined();
  });
});

describe("registry credentials", () => {
  it("keeps passwords sealed, replaces a login in place and forgets it on removal", () => {
    const r = mem();
    const row = r.registryCredentials.set({ host: "ghcr.io", username: "me", password: "s3cret-token" });
    expect(JSON.stringify(row)).not.toContain("s3cret-token");
    expect(JSON.stringify(r.registryCredentials.list())).not.toContain("s3cret-token");
    expect(r.registryCredentials.secret("ghcr.io", "me")).toEqual({ username: "me", password: "s3cret-token" });

    r.registryCredentials.set({ host: "ghcr.io", username: "me", password: "other" });
    expect(r.registryCredentials.list()).toHaveLength(1);
    expect(r.registryCredentials.secret("ghcr.io", "me")?.password).toBe("other");

    expect(r.registryCredentials.remove("ghcr.io", "me")).toBe(true);
    expect(r.registryCredentials.remove("ghcr.io", "me")).toBe(false);
    expect(r.registryCredentials.secret("ghcr.io", "me")).toBeNull();
  });

  it("allows several logins per host and picks one per app", () => {
    const r = mem();
    const c = r.registryCredentials;
    expect(c.resolve("shop", "ghcr.io")).toBeNull();
    c.set({ host: "ghcr.io", username: "alice", password: "pa" });
    expect(c.resolve("shop", "ghcr.io")).toEqual({ username: "alice", password: "pa" }); // the only one is the default
    c.set({ host: "ghcr.io", username: "bob", password: "pb" });
    c.set({ host: "docker.io", username: "carol", password: "pc" });
    expect(c.list().map((x) => `${x.host}/${x.username}`)).toEqual(["docker.io/carol", "ghcr.io/alice", "ghcr.io/bob"]);
    expect(c.resolve("shop", "ghcr.io")).toEqual({ ambiguous: ["alice", "bob"] }); // two, and no choice: don't guess

    expect(c.setAppChoice("shop", "ghcr.io", "bob")).toBe(true);
    expect(c.setAppChoice("shop", "ghcr.io", "nobody")).toBe(false);
    expect(c.resolve("shop", "ghcr.io")).toEqual({ username: "bob", password: "pb" });
    expect(c.resolve("blog", "ghcr.io")).toEqual({ ambiguous: ["alice", "bob"] }); // per app
    expect(c.appChoices("shop")).toEqual({ "ghcr.io": "bob" });

    c.setAppChoice("shop", "ghcr.io", null);
    expect(c.resolve("shop", "ghcr.io")).toEqual({ ambiguous: ["alice", "bob"] });
  });

  it("falls back when the chosen login is deleted, and forgets choices with the app", () => {
    const r = mem();
    const c = r.registryCredentials;
    c.set({ host: "ghcr.io", username: "alice", password: "pa" });
    c.set({ host: "ghcr.io", username: "bob", password: "pb" });
    c.setAppChoice("shop", "ghcr.io", "bob");
    c.remove("ghcr.io", "bob");
    expect(c.appChoices("shop")).toEqual({});
    expect(c.resolve("shop", "ghcr.io")).toEqual({ username: "alice", password: "pa" });
    c.setAppChoice("shop", "ghcr.io", "alice");
    r.apps.upsert({ name: "shop", server: "local", manifestText: null, currentRelease: null, previousRelease: null, status: "undeployed" });
    r.apps.remove("shop");
    expect(c.appChoices("shop")).toEqual({});
  });

  it("migrates single logins from before, keeping their secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "freighter-db-"));
    const secrets = createSecretBox(join(dir, "key"));
    const path = join(dir, "v10.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const m of migrations.slice(0, 10)) old.exec(m);
    old.exec("INSERT INTO meta VALUES ('schema_version', '10')");
    old.prepare("INSERT INTO registry_credentials VALUES (?, ?, ?, NULL, 'x', 'x')").run("ghcr.io", "me", secrets.seal("legacy-pw"));
    old.close();
    const r = openRegistry(path, { secrets });
    expect(r.schemaVersion()).toBe(16);
    expect(r.registryCredentials.secret("ghcr.io", "me")).toEqual({ username: "me", password: "legacy-pw" });
    expect(r.registryCredentials.resolve("shop", "ghcr.io")).toEqual({ username: "me", password: "legacy-pw" });
  });

  it("keeps canvas layouts per scope and drops a project's with the project", () => {
    const r = openRegistry(":memory:");
    const p = r.projects.create({ name: "Shop" });
    expect(r.layouts.get(p.id)).toEqual({});
    r.layouts.set(p.id, { "web/web": { x: 1, y: 2 } });
    r.layouts.set(p.id, { "web/web": { x: 3, y: 4 } });
    r.layouts.set("none", { "a/b": { x: 0, y: 0 } });
    expect(r.layouts.get(p.id)).toEqual({ "web/web": { x: 3, y: 4 } });
    r.projects.remove(p.id);
    expect(r.layouts.get(p.id)).toEqual({});
    expect(r.layouts.get("none")).toEqual({ "a/b": { x: 0, y: 0 } });
  });

  it("organizes apps in projects; deleting a project only ungroups its apps", () => {
    const r = mem();
    r.apps.ensure("shop", "local");
    r.apps.ensure("blog", "local");
    const p = r.projects.create({ name: "Storefront", description: "web + api" });
    expect(p).toMatchObject({ name: "Storefront", description: "web + api", appCount: 0 });
    expect(() => r.projects.create({ name: "storefront" })).toThrow(); // names are unique, ignoring case
    expect(r.apps.setProject("shop", p.id)).toBe(true);
    expect(r.apps.setProject("shop", "prj_nope")).toBe(false);
    expect(r.apps.setProject("ghost", p.id)).toBe(false);
    expect(r.apps.get("shop")?.projectId).toBe(p.id);
    expect(r.apps.get("blog")?.projectId).toBeNull();
    expect(r.projects.get(p.id)?.appCount).toBe(1);
    // a sync of the app leaves its project alone
    r.apps.upsert({ name: "shop", manifestText: null, currentRelease: "r1", previousRelease: null, status: "deployed" });
    expect(r.apps.get("shop")?.projectId).toBe(p.id);
    expect(r.projects.update(p.id, { name: "Shop" })).toBe(true);
    expect(r.projects.get(p.id)).toMatchObject({ name: "Shop", description: "web + api" });
    expect(r.projects.remove(p.id)).toBe(true);
    expect(r.apps.get("shop")?.projectId).toBeNull();
    expect(r.projects.list()).toEqual([]);
  });
});

describe("storages", () => {
  it("keeps the key pair and remote credentials sealed, and hides the apps that serve them", () => {
    const r = openRegistry(":memory:");
    r.apps.ensure("storage-up", "local", "storage");
    r.apps.ensure("shop", "local");
    expect(r.apps.list().map((a) => a.name)).toEqual(["shop"]);
    expect(r.apps.list({ includeStorage: true }).map((a) => [a.name, a.kind])).toEqual([["shop", "app"], ["storage-up", "storage"]]);

    const backend = { kind: "sftp", host: "files.example.com", user: "me", path: "s3", auth: "password", hostKey: "files.example.com ssh-ed25519 AAAA" } as const;
    const s = r.storages.create({ name: "up", server: "local", backend, port: 20100, accessKey: "AKIAEXAMPLE1", secretKey: "the-secret-key-1234", remoteSecrets: { password: "pw" }, createdBy: "tok" });
    expect(s).toMatchObject({ name: "up", server: "local", port: 20100, accessKey: "AKIAEXAMPLE1", backend });
    expect(JSON.stringify(s)).not.toMatch(/the-secret|pw/);
    expect(r.storages.secrets("up")).toEqual({ secretKey: "the-secret-key-1234", remote: { password: "pw" } });
    expect(() => r.storages.create({ name: "up", server: "local", backend: { kind: "local" }, port: 1, accessKey: "x", secretKey: "y" })).toThrow();

    expect(r.storages.update("up", { secretKey: "rotated-secret-key-1" })).toBe(true);
    expect(r.storages.secrets("up")).toEqual({ secretKey: "rotated-secret-key-1", remote: { password: "pw" } });
    expect(r.storages.update("up", { remoteSecrets: {} })).toBe(true);
    expect(r.storages.secrets("up")?.remote).toEqual({});
    expect(r.storages.get("up")?.public).toBe(false);
    expect(r.storages.update("up", { public: true })).toBe(true);
    expect(r.storages.get("up")?.public).toBe(true);
    expect(r.storages.update("up", { accessKey: "AKIAOTHER000" })).toBe(true);
    expect(r.storages.get("up")?.public).toBe(true); // what is left out stays
    expect(r.storages.update("up", { public: false })).toBe(true);
    expect(r.storages.get("up")?.public).toBe(false);
    expect(r.storages.update("nope", {})).toBe(false);
    expect(r.storages.remove("up")).toBe(true);
    expect(r.storages.list()).toEqual([]);
  });
});

describe("host samples", () => {
  it("keeps a server's readings in time order and prunes the old ones", () => {
    const r = openRegistry(":memory:");
    const row = (load1: number) => ({ load1, cpus: 4, memUsed: 100, memTotal: 400, diskUsed: 10, diskTotal: 50 });
    r.hostSamples.add("a", row(1), "2026-11-10T10:00:00.000Z");
    r.hostSamples.add("a", row(2), "2026-11-10T10:01:00.000Z");
    r.hostSamples.add("b", row(9), "2026-11-10T10:01:00.000Z");
    expect(r.hostSamples.series("a", "2026-11-10T10:00:30.000Z").map((x) => x.load1)).toEqual([2]);
    expect(r.hostSamples.series("a", "2026-11-10T00:00:00.000Z")).toMatchObject([{ load1: 1, cpus: 4, memUsed: 100, diskTotal: 50 }, { load1: 2 }]);
    expect(r.hostSamples.prune("2026-11-10T10:00:30.000Z")).toBe(1);
    expect(r.hostSamples.series("a", "2026-11-10T00:00:00.000Z")).toHaveLength(1);
  });
});
