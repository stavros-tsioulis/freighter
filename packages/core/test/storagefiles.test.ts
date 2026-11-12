import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStorage, createStorageUpload, deleteStoragePaths, listStorage, makeStorageDir, openStorageDownload, renameStoragePath, resetStorageCheck, useRcloneBinary } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

/** Enough of rclone for these commands, over a local folder: `:local:<dir>/…` is the folder itself. */
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd, ...rest] = process.argv.slice(2);
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (["--contimeout", "--timeout", "--retries", "--low-level-retries"].includes(rest[i])) i++;
  else if (rest[i] !== "--no-mimetype") args.push(rest[i]);
}
const real = (t) => t.replace(/^:local:/, "");
const fail = (m, code = 3) => (process.stderr.write("2026/11/12 10:00:00 ERROR : " + m + "\\n"), process.exit(code));
try {
  if (process.env.RCLONE_AUTH_KEY) fail("the S3 key pair was passed on", 9);
  if (process.env.FAKE_FAIL) fail(process.env.FAKE_FAIL, 1);
  if (cmd === "lsjson") {
    const dir = real(args[0]);
    if (!fs.existsSync(dir)) fail("error listing: directory not found");
    const rows = fs.readdirSync(dir).map((n) => { const s = fs.statSync(dir + "/" + n); return { Path: n, Name: n, Size: s.isDirectory() ? -1 : s.size, ModTime: s.mtime.toISOString(), IsDir: s.isDirectory() }; });
    process.stdout.write(JSON.stringify(rows));
  } else if (cmd === "mkdir") fs.mkdirSync(real(args[0]), { recursive: true });
  else if (cmd === "purge") fs.rmSync(real(args[0]), { recursive: true });
  else if (cmd === "deletefile") fs.rmSync(real(args[0]));
  else if (cmd === "moveto") fs.renameSync(real(args[0]), real(args[1]));
  else if (cmd === "cat") process.stdout.write(fs.readFileSync(real(args[0])));
  else if (cmd === "rcat") {
    const dest = real(args[0]);
    fs.mkdirSync(require("node:path").dirname(dest), { recursive: true });
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => fs.writeFileSync(dest, Buffer.concat(chunks)));
  } else fail("unknown command " + cmd, 2);
} catch (e) { fail(e.message); }
`;

const drain = async (s: AsyncIterable<Buffer | string>) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
};

async function setup() {
  resetStorageCheck();
  const h = await makeDeps();
  await applyStorage(h.deps, { name: "uploads", backend: { kind: "local" }, accessKey: "AKIAEXAMPLE1", secretKey: "s3cr3t-s3cr3t-s3cr3t" });
  const data = `${h.deps.layout.appsRoot}/storage-uploads/shared/data`;
  const bin = join(await mkdtemp(join(tmpdir(), "fake-rclone-")), "rclone");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  useRcloneBinary(bin);
  return { ...h, data };
}
afterEach(() => useRcloneBinary());

describe("browsing a storage", () => {
  it("lists buckets at the root and keys inside them", async () => {
    const { deps, data } = await setup();
    await mkdir(`${data}/photos/2026`, { recursive: true });
    await writeFile(`${data}/photos/a.jpg`, "jpeg");
    const root = await listStorage(deps, "uploads", "/");
    expect(root).toMatchObject({ path: "/", parent: null, truncated: false });
    expect(root.entries.map((e) => [e.name, e.type])).toEqual([["photos", "dir"]]);
    const inside = await listStorage(deps, "uploads", "/photos");
    expect(inside.parent).toBe("/");
    expect(inside.entries.map((e) => [e.name, e.type, e.size]).sort()).toEqual([["2026", "dir", 0], ["a.jpg", "file", 4]]);
    expect((await listStorage(deps, "uploads", "/photos", 1)).truncated).toBe(true);
    await expect(listStorage(deps, "uploads", "/nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(listStorage(deps, "uploads", "/photos/../..")).rejects.toMatchObject({ code: "bad_request" });
    await expect(listStorage(deps, "uploads", "relative")).rejects.toMatchObject({ code: "bad_request" });
    await expect(listStorage(deps, "ghost", "/")).rejects.toMatchObject({ code: "not_found" });
  });

  it("makes buckets and folders, renames, and deletes in bulk", async () => {
    const { deps, data } = await setup();
    await makeStorageDir(deps, "uploads", "/docs");
    await makeStorageDir(deps, "uploads", "/docs/reports");
    await expect(makeStorageDir(deps, "uploads", "/docs")).rejects.toMatchObject({ code: "conflict" });
    await writeFile(`${data}/docs/a.txt`, "a");
    expect(await renameStoragePath(deps, "uploads", "/docs/a.txt", "b.txt")).toBe("/docs/b.txt");
    await expect(renameStoragePath(deps, "uploads", "/docs/b.txt", "reports")).rejects.toMatchObject({ code: "conflict" });
    await expect(renameStoragePath(deps, "uploads", "/docs/b.txt", "x/y")).rejects.toMatchObject({ code: "bad_request" });
    const r = await deleteStoragePaths(deps, "uploads", ["/docs/b.txt", "/docs/reports", "/docs/missing", "/"]);
    expect(r.done).toEqual(["/docs/b.txt", "/docs/reports"]);
    expect(r.failed.map((f) => f.path)).toEqual(["/docs/missing", "/"]);
    expect(await readdir(`${data}/docs`)).toEqual([]);
  });

  it("receives a file and sends it back", async () => {
    const { deps, data } = await setup();
    const up = await createStorageUpload(deps, "uploads", "/photos/new.txt", false);
    Readable.from([Buffer.from("hello "), Buffer.from("storage")]).pipe(up.dest);
    await new Promise((r) => up.dest.once("finish", r));
    await up.commit();
    expect(await readFile(`${data}/photos/new.txt`, "utf8")).toBe("hello storage");
    await expect(createStorageUpload(deps, "uploads", "/photos/new.txt", false)).rejects.toMatchObject({ code: "conflict" });
    await expect(createStorageUpload(deps, "uploads", "/loose.txt", false)).rejects.toMatchObject({ code: "bad_request" });
    await expect(createStorageUpload(deps, "uploads", "/photos", true)).rejects.toMatchObject({ code: "bad_request" });
    const again = await createStorageUpload(deps, "uploads", "/photos/new.txt", true);
    again.dest.end("replaced");
    await new Promise((r) => again.dest.once("finish", r));
    await again.commit();

    const file = await openStorageDownload(deps, "uploads", "/photos/new.txt");
    expect(file.size).toBe(8);
    expect((await drain(file.stream)).toString()).toBe("replaced");
    await expect(openStorageDownload(deps, "uploads", "/photos")).rejects.toMatchObject({ code: "bad_request" });
    await expect(openStorageDownload(deps, "uploads", "/photos/none")).rejects.toMatchObject({ code: "not_found" });
  });

  it("says what rclone said when it fails, and never hands it the S3 key pair", async () => {
    const { deps } = await setup();
    expect(await listStorage(deps, "uploads", "/")).toMatchObject({ path: "/" }); // the fake refuses if it were given the key pair
    const envFile = `${deps.layout.envDir}/storage-uploads/s3.env`;
    await writeFile(envFile, `${await readFile(envFile, "utf8")}FAKE_FAIL="couldn't connect to the host: connection refused"\n`);
    await expect(listStorage(deps, "uploads", "/")).rejects.toThrow(/connection refused/);
    useRcloneBinary("/nonexistent/rclone");
    await expect(listStorage(deps, "uploads", "/")).rejects.toThrow(/rclone is not installed/);
  });
});
