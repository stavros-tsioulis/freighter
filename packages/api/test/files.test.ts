import { describe, expect, it } from "vitest";
import { makeApi } from "./helpers.ts";

const listing = { path: "/srv", parent: "/", entries: [{ name: "apps", type: "dir", size: 0, mtimeMs: 1, mode: 493, uid: 0, gid: 0, owner: "root", group: "root" }], truncated: false };

describe("file explorer", () => {
  it("is for admins only, on every route", async () => {
    const t = await makeApi();
    const routes: [string, string][] = [
      ["GET", "/v1/servers/local/fs?path=/"],
      ["POST", "/v1/servers/local/fs/mkdir"],
      ["POST", "/v1/servers/local/fs/rename"],
      ["POST", "/v1/servers/local/fs/copy"],
      ["POST", "/v1/servers/local/fs/move"],
      ["POST", "/v1/servers/local/fs/extract"],
      ["POST", "/v1/servers/local/fs/chown"],
      ["GET", "/v1/servers/local/fs/identities"],
      ["POST", "/v1/servers/local/fs/delete"],
      ["PUT", "/v1/servers/local/fs/upload?path=/tmp/x"],
      ["GET", "/v1/servers/local/fs/download?path=/etc/passwd"],
      ["POST", "/v1/servers/local/fs/archive"],
      ["GET", "/v1/servers/local/fs/archive/ticket"],
    ];
    for (const [method, path] of routes) {
      for (const role of ["viewer", "deployer"] as const) expect((await t.request(path, { method, token: t.tokens[role], json: method === "POST" ? {} : undefined })).status, `${method} ${path} as ${role}`).toBe(403);
      expect((await t.request(path, { method })).status, `${method} ${path} anonymous`).toBe(401);
    }
    expect(t.calls.some((c) => c.op.startsWith("fs."))).toBe(false);
  });

  it("lists a folder (the root by default) and passes the agent's answer through", async () => {
    const t = await makeApi();
    t.handlers["fs.list"] = (a: { path: string }) => ({ ...listing, path: a.path });
    expect((await t.request("/v1/servers/local/fs", { token: t.tokens.admin })).json).toMatchObject({ path: "/", entries: [{ name: "apps" }] });
    expect(t.calls.at(-1)).toEqual({ op: "fs.list", args: { path: "/" } });
    expect((await t.request("/v1/servers/local/fs?path=/srv", { token: t.tokens.admin })).json.path).toBe("/srv");
    expect((await t.request("/v1/servers/ghost/fs", { token: t.tokens.admin })).status).toBe(404);
    t.handlers["fs.list"] = () => {
      throw new t.AgentError("not_found", "/nope: no such file or directory");
    };
    expect((await t.request("/v1/servers/local/fs?path=/nope", { token: t.tokens.admin })).status).toBe(404);
    t.handlers["fs.list"] = () => {
      throw new Error("unknown operation \"fs.list\"");
    };
    const old = await t.request("/v1/servers/local/fs", { token: t.tokens.admin });
    expect(old.status).toBe(500); // a plain Error is not an AgentError: the real client turns it into one
  });

  it("changes things and writes each change to the audit log", async () => {
    const t = await makeApi();
    t.handlers["fs.mkdir"] = () => ({});
    t.handlers["fs.rename"] = (a: { path: string; name: string }) => ({ path: `/srv/${a.name}` });
    t.handlers["fs.copy"] = (a: { paths: string[] }) => ({ done: a.paths.map((p) => `/dst${p}`), failed: [] });
    t.handlers["fs.move"] = () => ({ done: ["/dst/a"], failed: [{ path: "/b", error: "/b: already exists" }] });
    t.handlers["fs.delete"] = (a: { paths: string[] }) => ({ done: a.paths, failed: [] });
    t.handlers["fs.extract"] = (a: { paths: string[] }) => ({ done: a.paths.map((p) => p.replace(/\.tar\.gz$/, "")), failed: [] });
    t.handlers["fs.chown"] = (a: { paths: string[] }) => ({ done: a.paths, failed: [] });
    const post = (op: string, json: unknown) => t.request(`/v1/servers/local/fs/${op}`, { method: "POST", token: t.tokens.admin, json });
    expect((await post("mkdir", { path: "/srv/new" })).status).toBe(200);
    expect((await post("rename", { path: "/srv/a", name: "b" })).json.path).toBe("/srv/b");
    expect((await post("copy", { paths: ["/a", "/b"], to: "/dst", onConflict: "rename" })).json.done).toEqual(["/dst/a", "/dst/b"]);
    expect((await post("move", { paths: ["/a", "/b"], to: "/dst" })).json.failed).toHaveLength(1);
    expect((await post("delete", { paths: ["/tmp/x"] })).json.done).toEqual(["/tmp/x"]);
    expect((await post("extract", { paths: ["/srv/site.tar.gz"] })).json.done).toEqual(["/srv/site"]);
    expect((await post("chown", { paths: ["/srv/a"], owner: "shop", group: "shop", recursive: true })).json.done).toEqual(["/srv/a"]);
    expect((await post("chown", { paths: ["/srv/a"] })).status).toBe(400);
    expect(t.registry.audit.list().find((a) => a.action === "file.chown")!.detail).toMatchObject({ owner: "shop", group: "shop", recursive: true, done: 1 });
    expect((await post("delete", { paths: [] })).status).toBe(400);
    expect((await post("copy", { paths: ["/a"], to: "/d", onConflict: "bogus" })).status).toBe(400);
    expect(t.registry.audit.list().map((a) => a.action).reverse()).toEqual(["file.mkdir", "file.rename", "file.copy", "file.move", "file.delete", "file.extract", "file.chown"]);
    expect(t.registry.audit.list().find((a) => a.action === "file.move")!.detail).toMatchObject({ server: "local", to: "/dst", done: 1, failed: 1 });
  });

  it("uploads a file by streaming the body to the agent", async () => {
    const t = await makeApi();
    const put = (qs: string, body: string, headers: Record<string, string> = {}) =>
      t.request(`/v1/servers/local/fs/upload?${qs}`, { method: "PUT", token: t.tokens.admin, body, headers: { "content-length": String(Buffer.byteLength(body)), ...headers } });
    const r = await put("path=/srv/a.txt", "hello world");
    expect(r.json).toEqual({ ok: true, path: "/srv/a.txt", size: 11 });
    expect(t.uploads[0]).toMatchObject({ args: { path: "/srv/a.txt", size: 11, overwrite: false } });
    expect(t.uploads[0]!.bytes.toString()).toBe("hello world");
    await put("path=/srv/a.txt&overwrite=1", "x");
    expect(t.uploads[1]!.args).toMatchObject({ overwrite: true });
    t.failUploads(new t.AgentError("conflict", "/srv/a.txt: already exists"));
    expect((await put("path=/srv/a.txt", "x")).status).toBe(409);
    expect((await put("overwrite=1", "x")).status).toBe(400);
    expect(JSON.stringify(t.registry.audit.list())).not.toContain("hello world");
    expect(t.registry.audit.list().filter((a) => a.action === "file.upload").at(-1)!.detail).toMatchObject({ server: "local", path: "/srv/a.txt", bytes: 11 });
  });

  it("downloads a file with its size and name, and records it", async () => {
    const t = await makeApi();
    const r = await t.request("/v1/servers/local/fs/download?path=/etc/some%20file%C3%A9.txt", { token: t.tokens.admin });
    expect(r.status).toBe(200);
    expect(r.json.raw).toBe("hello");
    expect(r.headers.get("content-length")).toBe("5");
    expect(r.headers.get("content-disposition")).toContain("filename*=UTF-8''some%20file%C3%A9.txt");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="some file_\.txt"/);
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "file.download", detail: { path: "/etc/some fileé.txt", bytes: 5 } });
    t.streams["fs.read"] = () => {
      throw new t.AgentError("bad_request", "/etc: not a file (download a folder as an archive)");
    };
    expect((await t.request("/v1/servers/local/fs/download?path=/etc", { token: t.tokens.admin })).status).toBe(400);
  });

  it("zips several paths behind a short-lived link that only its owner can use", async () => {
    const t = await makeApi();
    const made = await t.request("/v1/servers/local/fs/archive", { method: "POST", token: t.tokens.admin, json: { paths: ["/srv/a", "/srv/b.txt"] } });
    expect(made.json.name).toBe("local-files.zip");
    const got = await t.request(`/v1/servers/local/fs/archive/${made.json.ticket}`, { token: t.tokens.admin });
    expect(got.status).toBe(200);
    expect(got.json.raw).toBe("PK-zip");
    expect(got.headers.get("content-disposition")).toContain("local-files.zip");
    expect(t.calls.find((c) => c.op === "fs.archive")!.args).toEqual({ paths: ["/srv/a", "/srv/b.txt"] });
    expect(t.registry.audit.list()[0]).toMatchObject({ action: "file.archive", detail: { server: "local", paths: ["/srv/a", "/srv/b.txt"] } });

    const one = await t.request("/v1/servers/local/fs/archive", { method: "POST", token: t.tokens.admin, json: { paths: ["/srv/photos"] } });
    expect(one.json.name).toBe("local-photos.zip");
    expect((await t.request("/v1/servers/local/fs/archive/nonsense", { token: t.tokens.admin })).status).toBe(404);
    const other = t.registry.tokens.create({ name: "other admin", role: "admin" }).token;
    expect((await t.request(`/v1/servers/local/fs/archive/${one.json.ticket}`, { token: other })).status).toBe(404);
  });
});

describe("server metrics", () => {
  it("samples the machine with the apps and serves the history", async () => {
    const t = await makeApi();
    t.handlers["host.status"] = () => ({ hostname: "h", uptimeSeconds: 5, load1: 1.5, memTotal: 1000, memFree: 400, diskTotalBytes: 2000, diskFreeBytes: 500, cpus: 4 });
    t.handlers["metrics.snapshot"] = () => ({ samples: [] });
    const { sampleOnce } = await import("../src/metrics.ts");
    await sampleOnce(t.ctx);
    const r = await t.request("/v1/servers/local/metrics?minutes=30", { token: t.tokens.viewer });
    expect(r.json.points).toMatchObject([{ load1: 1.5, cpus: 4, memUsed: 600, memTotal: 1000, diskUsed: 1500, diskTotal: 2000 }]);
    expect((await t.request("/v1/servers/ghost/metrics", { token: t.tokens.viewer })).status).toBe(404);
    expect((await t.request("/v1/servers/local/metrics?minutes=0", { token: t.tokens.viewer })).status).toBe(400);
  });
});
