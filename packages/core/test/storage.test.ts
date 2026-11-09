import { readFile, stat } from "node:fs/promises";
import { parseManifest, type StorageBackend } from "@freighter/manifest";
import { splitCommand } from "@freighter/systemd";
import { beforeEach, describe, expect, it } from "vitest";
import { applyStorage, hostKeyFingerprint, readState, resetStorageCheck, setDomains, storageManifest, testStorage, type StorageSpec } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

beforeEach(() => resetStorageCheck());

const spec = (backend: StorageBackend): StorageSpec => ({ name: "uploads", backend, accessKey: "AKIAEXAMPLE1", secretKey: "s3cr3t-s3cr3t-s3cr3t" });
const sftp: StorageBackend = { kind: "sftp", host: "files.example.com", user: "backup", path: "s3", auth: "password", hostKey: "files.example.com ssh-ed25519 AAAAC3Nza" };
const smb: StorageBackend = { kind: "smb", host: "nas.local", share: "media", user: "me", domain: "WORKGROUP", path: "buckets" };

describe("storageManifest", () => {
  it("serves the local directory the agent keeps, on the allocated port, with generous proxy timeouts", async () => {
    const h = await makeDeps();
    const m = parseManifest(storageManifest(h.deps, spec({ kind: "local" }), 20005));
    const svc = m.services.s3!;
    expect(m.name).toBe("storage-uploads");
    expect(svc).toMatchObject({ port: 20005, restart: "always", proxy: { timeout: "30m" } });
    expect(splitCommand(svc.command!).slice(0, 2)).toEqual(["sh", "-c"]);
    expect(svc.command).toContain("serve s3");
    expect(svc.environment.FR_TARGET).toBe(`:local:${h.deps.layout.appsRoot}/storage-uploads/shared/data`);
    expect(svc.secrets).toEqual(["RCLONE_AUTH_KEY"]);
  });
  it("describes SFTP and SMB backends in environment, with only the password as a secret", async () => {
    const h = await makeDeps();
    const a = parseManifest(storageManifest(h.deps, spec(sftp), 20005));
    expect(a.services.s3!.environment).toMatchObject({ FR_TARGET: "remote:s3", RCLONE_CONFIG_REMOTE_TYPE: "sftp", RCLONE_CONFIG_REMOTE_HOST: "files.example.com", RCLONE_CONFIG_REMOTE_USER: "backup" });
    expect(a.services.s3!.secrets).toEqual(["RCLONE_AUTH_KEY", "RCLONE_CONFIG_REMOTE_PASS"]);
    const b = parseManifest(storageManifest(h.deps, spec(smb), 20005));
    expect(b.services.s3!.environment).toMatchObject({ FR_TARGET: "remote:media/buckets", RCLONE_CONFIG_REMOTE_TYPE: "smb", RCLONE_CONFIG_REMOTE_DOMAIN: "WORKGROUP" });
    expect(JSON.stringify(b)).not.toMatch(/PASS"?:/);
  });
});

describe("applyStorage", () => {
  it("creates the app, its data directory and credentials, and deploys it", async () => {
    const h = await makeDeps();
    const { deploy: r, port } = await applyStorage(h.deps, spec({ kind: "local" }));
    expect(port).toBe(20000);
    expect(r.units).toEqual(["freighter-storage-uploads--s3.service"]);
    expect(h.unitText(r.units[0]!)).toContain("Environment=PORT=20000\n");
    expect((await stat(`${h.deps.layout.appsRoot}/storage-uploads/shared/data`)).isDirectory()).toBe(true);
    const env = await readFile(`${h.deps.layout.envDir}/storage-uploads/s3.env`, "utf8");
    expect(env).toContain('RCLONE_AUTH_KEY="AKIAEXAMPLE1,s3cr3t-s3cr3t-s3cr3t"');
    expect(h.unitText(r.units[0]!)).not.toContain("s3cr3t");
    expect(h.calls).toContainEqual(["chown", "-R", "storage-uploads:storage-uploads", `${h.deps.layout.appsRoot}/storage-uploads/shared/data`, `${h.deps.layout.appsRoot}/storage-uploads/shared/cache`]);
  });
  it("keeps a domain across updates and becomes routed when it gets one", async () => {
    const h = await makeDeps();
    await applyStorage(h.deps, spec({ kind: "local" }));
    await setDomains(h.deps, "storage-uploads", [{ hostname: "s3.example.com", service: "s3", tls: "auto" }]);
    expect((await readState(h.deps, "storage-uploads")).routed.s3).toMatchObject({ timeout: "30m" });
    expect(h.haproxyFile("backends.cfg")).toContain("timeout server 30m");
    await applyStorage(h.deps, { ...spec({ kind: "local" }), secretKey: "another-secret-key-1" });
    expect(h.haproxyFile("hostnames.map")).toContain("s3.example.com be_storage-uploads_s3");
  });
  it("hands rclone an obscured password, pins the SFTP host key and writes the private key root-readable only for its user", async () => {
    const h = await makeDeps();
    await applyStorage(h.deps, spec(sftp), { secrets: { password: "hunter2" } });
    const env = await readFile(`${h.deps.layout.envDir}/storage-uploads/s3.env`, "utf8");
    expect(env).toContain('RCLONE_CONFIG_REMOTE_PASS="obscured(hunter2)"');
    const dir = `${h.deps.layout.appsRoot}/storage-uploads/shared/ssh`;
    expect(await readFile(`${dir}/known_hosts`, "utf8")).toBe("files.example.com ssh-ed25519 AAAAC3Nza\n");

    await applyStorage(h.deps, spec({ ...sftp, auth: "key" }), { secrets: { privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----" } });
    expect((await stat(`${dir}/id`)).mode & 0o777).toBe(0o600);
  });
  it("refuses what is missing: rclone, the pinned host key, a password", async () => {
    const h = await makeDeps();
    await expect(applyStorage(h.deps, spec(sftp), {})).rejects.toThrow(/password is required/);
    await expect(applyStorage(h.deps, spec({ ...sftp, hostKey: undefined }), { secrets: { password: "x" } })).rejects.toThrow(/host key is not pinned/);
    h.ctl.rclone.version = "rclone v1.60.1";
    resetStorageCheck();
    await expect(applyStorage(h.deps, spec({ kind: "local" }))).rejects.toThrow(/rclone 1.65 or newer/);
  });
});

describe("storage ports", () => {
  it("gives each storage its own port and keeps it across updates", async () => {
    const h = await makeDeps();
    const a = await applyStorage(h.deps, spec({ kind: "local" }));
    const b = await applyStorage(h.deps, { ...spec({ kind: "local" }), name: "media" });
    expect([a.port, b.port]).toEqual([20000, 20001]);
    expect((await applyStorage(h.deps, spec({ kind: "local" }))).port).toBe(20000);
  });
});

describe("testStorage", () => {
  it("reads an SFTP server's host key to confirm before connecting", async () => {
    const h = await makeDeps();
    h.ctl.rclone.keyscan = "# files.example.com:22 SSH-2.0-OpenSSH\nfiles.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYDATA\n";
    const r = await testStorage(h.deps, { ...sftp, hostKey: undefined }, {});
    expect(r).toMatchObject({ ok: true, hostKey: { type: "ssh-ed25519", line: "files.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYDATA" } });
    expect(r.hostKey!.fingerprint).toBe(hostKeyFingerprint("AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYDATA"));
    expect(r.hostKey!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
  it("lists the remote, and reports why that failed", async () => {
    const h = await makeDeps();
    expect(await testStorage(h.deps, smb, { password: "pw" })).toEqual({ ok: true });
    const lsd = h.calls.find((c) => c[1] === "lsd")!;
    expect(lsd).toContain("remote:media/buckets");
    h.ctl.rclone.lsdCode = 1;
    h.ctl.rclone.lsdStderr = "2026/11/09 12:00:00 ERROR : Failed to create file system: smb: login failed: access denied\n";
    expect(await testStorage(h.deps, smb, { password: "bad" })).toEqual({ ok: false, error: "Failed to create file system: smb: login failed: access denied" });
    expect(await testStorage(h.deps, smb, {})).toEqual({ ok: false, error: "a password is required" });
  });
});
