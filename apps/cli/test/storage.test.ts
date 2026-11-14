import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { cli, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

let n = 0;
const deployed = () => ({ app: "storage-files", releaseId: "r1", previous: null, units: [], removed: [], pruned: [], hostnames: [], warnings: [], verified: true, historyAt: `2026-11-14T10:00:0${++n % 10}.000Z` });

async function setup(extra: Record<string, (a: any) => unknown> = {}) {
  api = await startApi({
    handlers: {
      ping: () => ({ version: "0", time: "t", capabilities: ["storage", "files"] }),
      "storage.apply": () => ({ deploy: deployed(), hostnames: [] }), "app.deploy": deployed, "app.info": () => ({ app: "storage-files", release: "r1", previous: null, manifestText: "", services: {}, releases: [] }),
      "app.history": () => ({ entries: [] }), "app.delete": () => ({ app: "storage-files", units: [], hostnames: [] }), "connections.set": () => ({}), "domains.get": () => ({ domains: [] }),
      "storage.ls": () => ({ path: "/photos", parent: "/", entries: [{ name: "2026", type: "dir", size: 0, mtimeMs: 1 }, { name: "cover.jpg", type: "file", size: 412_000, mtimeMs: Date.now() - 3_600_000 }], truncated: false }),
      "storage.mkdir": () => ({}), "storage.rename": () => ({ path: "/photos/new.jpg" }), "storage.rm": ({ paths }: { paths: string[] }) => ({ done: paths, failed: [] }),
      ...extra,
    },
  });
  api.streams["fs.read"] = () => ({ result: { size: 5, mtimeMs: 1 }, body: Readable.from([Buffer.from("hello")]) });
  const env = { ...api.env(api.admin), FREIGHTER_POLL_MS: "50" };
  return { env, registry: api.registry };
}

describe("storage", () => {
  it("creates a local storage, shows its keys once, and lists it", async () => {
    const { env, registry } = await setup();
    const r = await cli(["storage", "create", "files", "--server", "local", "--domain", "files.example.com"], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Storage files created on local.");
    expect(r.stdout).toMatch(/access key\s+FR[0-9A-F]+/);
    expect(r.stdout).toMatch(/secret key\s+\S+\s+\(shown once\)/);
    expect(r.stdout).toContain("freighter domain verify storage-files files.example.com");
    expect(registry.storages.get("files")?.backend).toEqual({ kind: "local" });
    expect(registry.pendingDomains.list("storage-files")[0]).toMatchObject({ hostname: "files.example.com", service: "s3" });

    const list = await cli(["storage", "list"], { env });
    expect(list.stdout).toMatch(/NAME\s+TYPE\s+SERVER\s+DOMAIN\s+PUBLIC\s+STATE/);
    expect(list.stdout).toMatch(/files\s+local\s+local/);
    expect((await cli(["storage", "list", "-q"], { env })).stdout).toBe("files\n");
    expect((await cli(["storage", "show", "files"], { env })).stdout).toMatch(/access key\s+FR/);
    expect((await cli(["storage", "show", "ghost"], { env })).status).toBe(4);
    expect((await cli(["storage", "create", "files", "--server", "local"], { env })).status).toBe(1); // taken
  });

  it("checks what an sftp or smb storage needs, and pins the SSH host key only when told it is right", async () => {
    const { env } = await setup({ "storage.test": ({ backend }: any) => (backend.hostKey ? { ok: true } : { ok: false, hostKey: { line: "host ssh-ed25519 AAAA", fingerprint: "SHA256:abc", type: "ssh-ed25519" } }) });
    expect((await cli(["storage", "create", "media", "--server", "local", "--type", "sftp"], { env })).stderr).toContain("needs --host and --user");
    expect((await cli(["storage", "create", "media", "--server", "local", "--type", "sftp", "--host", "nas", "--user", "me"], { env })).stderr).toContain("--password-stdin or --key-file");
    expect((await cli(["storage", "create", "media", "--server", "local", "--type", "smb", "--host", "nas", "--user", "me"], { env })).stderr).toContain("needs --share");
    expect((await cli(["storage", "create", "media", "--server", "local", "--type", "tape"], { env })).status).toBe(2);

    const noAnswer = await cli(["storage", "create", "media", "--server", "local", "--type", "sftp", "--host", "nas", "--user", "me", "--password-stdin"], { env, input: "pw\n" });
    expect(noAnswer.status).toBe(1); // the fingerprint has to be confirmed, and nobody is there to
    expect(noAnswer.stderr).toContain("SHA256:abc");
    const pinned = await cli(["storage", "create", "media", "--server", "local", "--type", "sftp", "--host", "nas", "--user", "me", "--password-stdin", "--yes"], { env, input: "pw\n" });
    expect(pinned.status).toBe(0);
    expect(api!.registry.storages.get("media")?.backend).toMatchObject({ kind: "sftp", host: "nas", hostKey: "host ssh-ed25519 AAAA", auth: "password" });
    expect(JSON.stringify(api!.registry.storages.list())).not.toContain("pw\n");
  });

  it("makes a storage public or private, prints how to connect to it, rotates its keys and deletes it", async () => {
    const { env, registry } = await setup();
    await cli(["storage", "create", "files", "--server", "local", "--domain", "files.example.com"], { env });
    registry.storages.update("files", { public: false });
    expect((await cli(["storage", "set", "files", "--public"], { env })).status).toBe(0);
    expect(registry.storages.get("files")?.public).toBe(true);
    expect((await cli(["storage", "set", "files", "--public", "--private"], { env })).status).toBe(2);
    expect((await cli(["storage", "set", "files"], { env })).status).toBe(2);

    registry.apps.upsert({ name: "storage-files", server: "local", manifestText: "", currentRelease: "r1", previousRelease: null, status: "deployed" });
    registry.services.replace("storage-files", [{ name: "s3", unit: "u", port: 1, hostnames: ["files.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: 1 }]);
    const aws = await cli(["storage", "connect", "files"], { env });
    expect(aws.stdout).toMatch(/AWS_ACCESS_KEY_ID=FR/);
    expect(aws.stdout).toContain("aws --endpoint-url https://files.example.com s3 ls");
    expect(aws.stdout).not.toMatch(/AWS_SECRET_ACCESS_KEY=[A-Za-z0-9_-]{20}/);
    expect((await cli(["storage", "connect", "files", "--rclone"], { env })).stdout).toContain("force_path_style = true");
    expect((await cli(["storage", "connect", "files", "--env"], { env })).stdout).toContain('S3_SECRET_KEY: "@storage:files.secretKey"');

    expect((await cli(["storage", "rotate-keys", "files"], { env })).status).toBe(1); // asks
    const rot = await cli(["storage", "rotate-keys", "files", "--yes"], { env });
    expect(rot.stdout).toMatch(/secret key\s+\S+\s+\(shown once\)/);
    expect((await cli(["storage", "delete", "files"], { env })).status).toBe(1);
    expect((await cli(["storage", "delete", "files", "--yes"], { env })).stdout).toContain("Deleted files.");
    expect(registry.storages.get("files")).toBeUndefined();
  });
});

describe("storage file", () => {
  it("lists, downloads, uploads, makes folders, renames and deletes", async () => {
    const { env, registry } = await setup();
    await cli(["storage", "create", "files", "--server", "local", "--domain", "files.example.com"], { env });
    const dir = mkdtempSync(join(tmpdir(), "freighter-cli-st-"));
    const ls = await cli(["storage", "file", "ls", "files:/photos"], { env });
    expect(ls.stdout).toMatch(/2026\/\s+-/);
    expect(ls.stdout).toMatch(/cover\.jpg\s+412 KB\s+1h ago/);

    expect((await cli(["storage", "file", "get", "files:/photos/cover.jpg", dir], { env })).status).toBe(0);
    expect(readFileSync(join(dir, "cover.jpg"), "utf8")).toBe("hello");

    const local = join(dir, "new.jpg");
    writeFileSync(local, "bytes");
    expect((await cli(["storage", "file", "put", local, "files:/photos/"], { env })).stdout).toContain("Uploaded 1 file.");
    expect(api!.uploads.at(-1)!.args).toMatchObject({ path: "/photos/new.jpg", storage: "files" });
    expect((await cli(["storage", "file", "mkdir", "files:/archive"], { env })).status).toBe(0);
    expect((await cli(["storage", "file", "mv", "files:/photos/new.jpg", "files:/photos/old.jpg"], { env })).status).toBe(0);
    expect((await cli(["storage", "file", "mv", "files:/photos/a.jpg", "files:/other/a.jpg"], { env })).status).toBe(2);
    expect((await cli(["storage", "file", "rm", "files:/photos/cover.jpg"], { env })).status).toBe(1);
    expect((await cli(["storage", "file", "rm", "files:/photos/cover.jpg", "--yes"], { env })).stdout).toContain("Deleted 1.");
    void registry;
  });

  it("makes a signed link, or just the address on a public storage", async () => {
    const { env, registry } = await setup();
    await cli(["storage", "create", "files", "--server", "local", "--domain", "files.example.com"], { env });
    api!.handlers["domains.get"] = () => ({ domains: [{ hostname: "files.example.com", service: "s3", tls: "auto" }] }); // verified since
    const signed = await cli(["storage", "file", "link", "files:/photos/cover.jpg", "--expires", "24h"], { env });
    expect(signed.stdout).toMatch(/^https:\/\/files\.example\.com\/photos\/cover\.jpg\?X-Amz-Algorithm=/);
    expect(signed.stdout).toContain("X-Amz-Expires=86400");
    expect((await cli(["storage", "file", "link", "files:/photos", "-q"], { env })).status).toBe(1); // a link is for a file in a bucket

    registry.storages.update("files", { public: true });
    registry.apps.upsert({ name: "storage-files", server: "local", manifestText: "", currentRelease: "r1", previousRelease: null, status: "deployed" });
    registry.services.replace("storage-files", [{ name: "public", unit: "u", port: 1, hostnames: ["cdn.example.com"], activeState: "active", subState: "running", restarts: 0, memoryBytes: 1 }]);
    expect((await cli(["storage", "file", "link", "files:/photos/cover.jpg"], { env })).stdout.trim()).toBe("https://cdn.example.com/photos/cover.jpg");
  });
});
