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

const entry = (name: string, type: string, size = 0) => ({ name, type, size, mtimeMs: Date.now() - 7_200_000, mode: 0o644, uid: 1, gid: 1, owner: "shop", group: "shop", link: null });

async function setup(handlers: Record<string, (a: any) => unknown> = {}) {
  api = await startApi({
    handlers: {
      "fs.list": ({ path }: { path: string }) => {
        if (path === "/srv/apps/shop/shared") return { path, parent: "/srv/apps/shop", entries: [entry("uploads", "dir"), entry("data.db", "file", 4_200_000)], truncated: false };
        if (path === "/srv/apps/shop/shared/uploads") return { path, parent: "/srv/apps/shop/shared", entries: [], truncated: false };
        throw new Error("no such directory");
      },
      "fs.mkdir": () => ({}),
      "fs.rename": ({ path, name }: { path: string; name: string }) => ({ path: `${path.slice(0, path.lastIndexOf("/"))}/${name}` }),
      "fs.move": ({ paths }: { paths: string[] }) => ({ done: paths, failed: [] }),
      "fs.delete": ({ paths }: { paths: string[] }) => ({ done: paths, failed: [] }),
      "fs.extract": ({ paths }: { paths: string[] }) => ({ done: paths.map((p) => `${p} copy`), failed: [] }),
      "fs.chown": ({ paths }: { paths: string[] }) => ({ done: paths, failed: [] }),
      ...handlers,
    },
  });
  api.registry.servers.create({ name: "contabo-1", address: "203.0.113.9:7443" });
  api.registry.servers.markSeen("contabo-1", { agentVersion: "aaaaaaa" });
  api.streams["fs.read"] = () => ({ result: { size: 5, mtimeMs: 1 }, body: Readable.from([Buffer.from("hello")]) });
  api.streams["fs.archive"] = () => ({ result: {}, body: Readable.from([Buffer.from("PK-zip")]) });
  return { env: api.env(api.admin), dir: mkdtempSync(join(tmpdir(), "freighter-cli-files-")) };
}
const base = "contabo-1:/srv/apps/shop/shared";

describe("file", () => {
  it("lists a folder, with folders marked and the owner", async () => {
    const { env } = await setup();
    const r = await cli(["file", "ls", base], { env });
    expect(r.stdout).toMatch(/NAME\s+SIZE\s+MODIFIED\s+OWNER/);
    expect(r.stdout).toMatch(/uploads\/\s+-\s+2h ago\s+shop/);
    expect(r.stdout).toMatch(/data\.db\s+4\.2 MB/);
    expect((await cli(["file", "ls", "contabo-1:etc"], { env })).status).toBe(2); // a path starts with /
    expect((await cli(["file", "ls", "ghost:/"], { env })).status).toBe(4);
    expect((await cli(["file", "ls", "contabo-1:/nope"], { env })).status).toBe(1);
  });

  it("prints and downloads a file, and a folder as a zip", async () => {
    const { env, dir } = await setup();
    expect((await cli(["file", "cat", `${base}/data.db`], { env })).stdout).toBe("hello");
    const saved = await cli(["file", "get", `${base}/data.db`, dir], { env });
    expect(saved.status).toBe(0);
    expect(readFileSync(join(dir, "data.db"), "utf8")).toBe("hello");
    const zip = await cli(["file", "get", `${base}/uploads`, join(dir, "uploads.zip")], { env });
    expect(zip.status).toBe(0);
    expect(readFileSync(join(dir, "uploads.zip"), "utf8")).toBe("PK-zip");
  });

  it("uploads into a folder, under a name, and refuses what it shouldn't", async () => {
    const { env, dir } = await setup();
    const local = join(dir, "photo.jpg");
    writeFileSync(local, "jpegbytes");
    const r = await cli(["file", "put", local, `${base}/uploads/`], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Uploaded photo.jpg to contabo-1:/srv/apps/shop/shared/uploads/photo.jpg");
    expect(api!.uploads.at(-1)).toMatchObject({ args: { path: "/srv/apps/shop/shared/uploads/photo.jpg", overwrite: false } });
    expect(api!.uploads.at(-1)!.bytes.toString()).toBe("jpegbytes");
    await cli(["file", "put", local, `${base}/uploads`, "--overwrite"], { env }); // an existing folder: inside it
    expect(api!.uploads.at(-1)!.args).toMatchObject({ path: "/srv/apps/shop/shared/uploads/photo.jpg", overwrite: true });
    await cli(["file", "put", local, `${base}/new.jpg`], { env });
    expect(api!.uploads.at(-1)!.args.path).toBe("/srv/apps/shop/shared/new.jpg");
    expect((await cli(["file", "put", "/nonexistent", `${base}/x`], { env })).status).toBe(4);
    expect((await cli(["file", "put", base, local], { env })).status).toBe(2);
  });

  it("makes folders, moves and renames, extracts, changes owners, and deletes only after asking", async () => {
    const { env } = await setup();
    expect((await cli(["file", "mkdir", `${base}/reports`], { env })).status).toBe(0);
    const calls = () => api!.calls.map((c) => c.op);
    expect((await cli(["file", "mv", `${base}/data.db`, `${base}/main.db`], { env })).stdout).toContain("Moved to contabo-1:/srv/apps/shop/shared/main.db");
    expect(calls()).toContain("fs.rename");
    expect(calls()).not.toContain("fs.move"); // same folder: a rename
    await cli(["file", "mv", `${base}/data.db`, `${base}/uploads/`], { env });
    expect(api!.calls.find((c) => c.op === "fs.move")!.args).toEqual({ paths: ["/srv/apps/shop/shared/data.db"], to: "/srv/apps/shop/shared/uploads" });
    expect((await cli(["file", "mv", `${base}/a`, "other:/b"], { env })).status).toBe(2);

    expect((await cli(["file", "extract", `${base}/docs.zip`], { env })).stdout).toContain("docs.zip copy");
    expect((await cli(["file", "chown", `${base}/uploads`, "--owner", "shop"], { env })).status).toBe(0);
    expect((await cli(["file", "chown", `${base}/uploads`], { env })).status).toBe(2);
    expect((await cli(["file", "chown", `${base}/uploads`, "--owner", "shop", "-r"], { env })).status).toBe(1); // recursive: asks first

    expect((await cli(["file", "rm", `${base}/data.db`], { env })).status).toBe(1);
    const gone = await cli(["file", "rm", `${base}/data.db`, `${base}/old.log`, "--yes"], { env });
    expect(gone.stdout).toContain("Deleted 2.");
    expect(api!.calls.find((c) => c.op === "fs.delete")!.args.paths).toEqual(["/srv/apps/shop/shared/data.db", "/srv/apps/shop/shared/old.log"]);
  });

  it("is for admins only", async () => {
    await setup();
    expect((await cli(["file", "ls", base], { env: api!.env(api!.token("deployer")) })).status).toBe(3);
  });
});
