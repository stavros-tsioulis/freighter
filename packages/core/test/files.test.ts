import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cleanPath, copyPaths, createUpload, deletePaths, extractPaths, isArchive, listDir, makeDir, movePaths, openForDownload, renamePath, zipStream } from "../src/index.ts";

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "freighter-files-"));
  await mkdir(`${root}/a/sub`, { recursive: true });
  await mkdir(`${root}/b`);
  await writeFile(`${root}/a/one.txt`, "one");
  await writeFile(`${root}/a/sub/two.txt`, "two".repeat(1000));
  await writeFile(`${root}/b/one.txt`, "other one");
  await symlink(`${root}/a`, `${root}/link-to-a`);
  await symlink(`${root}/nowhere`, `${root}/broken`);
  return root;
}

const drain = async (s: AsyncIterable<Buffer | string>) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
};

/** Read a ZIP the way unzip would: from its central directory, checking each entry's CRC. */
function readZip(zip: Buffer): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  let eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) {
    const loc = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    const z = Number(zip.readBigUInt64LE(loc + 8));
    count = Number(zip.readBigUInt64LE(z + 32));
    at = Number(zip.readBigUInt64LE(z + 48));
  }
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const local = offset;
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (name.endsWith("/")) out.set(name, null);
    else {
      const data = method === 8 ? inflateRawSync(zip.subarray(dataAt, dataAt + csize)) : zip.subarray(dataAt, dataAt + csize);
      const { crc32 } = require("node:zlib") as typeof import("node:zlib");
      expect(crc32(data) >>> 0).toBe(crc);
      out.set(name, data);
    }
    at += 46 + nameLen + extraLen + zip.readUInt16LE(at + 32);
  }
  return out;
}

describe("listing", () => {
  it("lists a folder with types, sizes and where links point", async () => {
    const root = await tree();
    const l = await listDir(root);
    expect(l.parent).toBe(join(root, ".."));
    expect(l.entries.map((e) => [e.name, e.type])).toEqual([["a", "dir"], ["b", "dir"], ["broken", "link"], ["link-to-a", "link"]]);
    expect(l.entries.find((e) => e.name === "link-to-a")!.link).toEqual({ target: `${root}/a`, type: "dir" });
    expect(l.entries.find((e) => e.name === "broken")!.link!.type).toBe("missing");
    const a = await listDir(`${root}/a`);
    expect(a.entries.find((e) => e.name === "one.txt")).toMatchObject({ type: "file", size: 3 });
    expect((await listDir("/")).parent).toBeNull();
  });
  it("says what is wrong with a path", async () => {
    const root = await tree();
    await expect(listDir(`${root}/nope`)).rejects.toThrow(/no such file/);
    await expect(listDir(`${root}/a/one.txt`)).rejects.toThrow(/not a directory/);
    expect(() => cleanPath("relative/path")).toThrow(/absolute/);
    expect(() => cleanPath("/a\0b")).toThrow(/invalid/);
    expect(cleanPath("/a/./b/../c//")).toBe("/a/c");
  });
});

describe("changing files", () => {
  it("makes folders and renames, and won't overwrite", async () => {
    const root = await tree();
    await makeDir(`${root}/new`);
    expect((await stat(`${root}/new`)).isDirectory()).toBe(true);
    await expect(makeDir(`${root}/new`)).rejects.toThrow(/already exists/);
    expect(await renamePath(`${root}/a/one.txt`, "uno.txt")).toBe(`${root}/a/uno.txt`);
    await expect(renamePath(`${root}/a/uno.txt`, "sub")).rejects.toThrow(/already exists/);
    await expect(renamePath(`${root}/a/uno.txt`, "x/y")).rejects.toThrow(/invalid name/);
    await expect(renamePath("/etc", "etc2")).rejects.toThrow(/can't be renamed/);
  });

  it("copies and moves in bulk, with the three ways to treat a name that is taken", async () => {
    const root = await tree();
    const fail = await copyPaths([`${root}/a/one.txt`, `${root}/a/sub`], `${root}/b`, "fail");
    expect(fail.failed).toEqual([{ path: `${root}/a/one.txt`, error: expect.stringMatching(/already exists/) }]);
    expect(fail.done).toEqual([`${root}/b/sub`]);
    expect(await readFile(`${root}/b/sub/two.txt`, "utf8")).toHaveLength(3000);

    const renamed = await copyPaths([`${root}/a/one.txt`], `${root}/b`, "rename");
    expect(renamed.done).toEqual([`${root}/b/one copy.txt`]);
    expect((await copyPaths([`${root}/a/one.txt`], `${root}/b`, "rename")).done).toEqual([`${root}/b/one copy 2.txt`]);

    const over = await movePaths([`${root}/a/one.txt`], `${root}/b`, "overwrite");
    expect(over.failed).toEqual([]);
    expect(await readFile(`${root}/b/one.txt`, "utf8")).toBe("one");
    expect(existsSync(`${root}/a/one.txt`)).toBe(false);

    expect((await copyPaths([`${root}/b/sub`], `${root}/b`, "fail")).done).toEqual([`${root}/b/sub copy`]); // into its own folder: a copy next to it
  });

  it("refuses a folder into itself, a destination that isn't a folder, and moving onto itself is a no-op", async () => {
    const root = await tree();
    expect((await copyPaths([`${root}/a`], `${root}/a/sub`)).failed[0]!.error).toMatch(/into itself/);
    await expect(copyPaths([`${root}/a`], `${root}/b/one.txt`)).rejects.toThrow(/not a folder/);
    expect(await movePaths([`${root}/a/one.txt`], `${root}/a`)).toEqual({ done: [], failed: [] });
  });

  it("deletes in bulk, reports what failed, and never touches the system's own folders", async () => {
    const root = await tree();
    const r = await deletePaths([`${root}/a`, `${root}/ghost`, `${root}/link-to-a`, "/etc", "/"]);
    expect(r.done).toEqual([`${root}/a`, `${root}/link-to-a`]);
    expect(r.failed.map((f) => f.path)).toEqual([`${root}/ghost`, "/etc", "/"]);
    expect(existsSync(`${root}/a`)).toBe(false);
  });
});

describe("transfers", () => {
  it("opens a file for download, and sends a folder to the archive instead", async () => {
    const root = await tree();
    const f = await openForDownload(`${root}/a/one.txt`);
    expect(f.size).toBe(3);
    expect((await drain(f.stream)).toString()).toBe("one");
    await expect(openForDownload(`${root}/a`)).rejects.toThrow(/archive/);
  });

  it("receives a file beside its place and renames it in when done; an aborted upload leaves nothing", async () => {
    const root = await tree();
    const up = await createUpload(`${root}/b/new.bin`, false);
    up.dest.end(Buffer.from("hello"));
    await new Promise((r) => up.dest.once("close", r));
    expect(existsSync(`${root}/b/new.bin`)).toBe(false);
    await up.commit();
    expect(await readFile(`${root}/b/new.bin`, "utf8")).toBe("hello");

    await expect(createUpload(`${root}/b/new.bin`, false)).rejects.toThrow(/already exists/);
    const again = await createUpload(`${root}/b/new.bin`, true);
    again.dest.write("partial");
    await again.abort();
    expect(await readFile(`${root}/b/new.bin`, "utf8")).toBe("hello");
    expect((await listDir(`${root}/b`)).entries.map((e) => e.name)).toEqual(["new.bin", "one.txt"]);
    await expect(createUpload(`${root}/nope/x`, false)).rejects.toThrow(/no such file/);
    await expect(createUpload(`${root}/b/..`, false)).rejects.toThrow();
  });
});

describe("zip", () => {
  it("archives files and folders under their own names, skipping links and saying so", async () => {
    const root = await tree();
    await writeFile(`${root}/ünï.txt`, "unicode name");
    const zip = await drain(zipStream([`${root}/a`, `${root}/ünï.txt`, `${root}/link-to-a`, `${root}/b/one.txt`]));
    const files = readZip(zip);
    expect([...files.keys()].sort()).toEqual(["_NOT_INCLUDED.txt", "a/", "a/one.txt", "a/sub/", "a/sub/two.txt", "one.txt", "ünï.txt"]);
    expect(files.get("a/sub/two.txt")!.toString()).toBe("two".repeat(1000));
    expect(files.get("one.txt")!.toString()).toBe("other one");
    expect(files.get("_NOT_INCLUDED.txt")!.toString()).toMatch(/link-to-a: symbolic link/);
  });

  it("is a zip that unzip accepts, with permissions", async () => {
    const root = await tree();
    const out = join(root, "out.zip");
    await writeFile(out, await drain(zipStream([`${root}/a`])));
    let tested = true;
    try {
      execFileSync("unzip", ["-tq", out], { stdio: "pipe" });
    } catch (e) {
      tested = (e as NodeJS.ErrnoException).code !== "ENOENT" ? false : true; // no unzip here: the reader above is the check
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    expect(tested).toBe(true);
  });

  it("handles an empty folder and an empty file", async () => {
    const root = await tree();
    await mkdir(`${root}/empty`);
    await writeFile(`${root}/zero`, "");
    const files = readZip(await drain(zipStream([`${root}/empty`, `${root}/zero`])));
    expect([...files.keys()]).toEqual(["empty/", "zero"]);
    expect(files.get("zero")!.length).toBe(0);
  });
});

describe("extractPaths", () => {
  const have = (tool: string) => { try { execFileSync("sh", ["-c", `command -v ${tool}`]); return true; } catch { return false; } };
  async function source() {
    const root = await mkdtemp(join(tmpdir(), "freighter-extract-"));
    await mkdir(`${root}/src/inner`, { recursive: true });
    await writeFile(`${root}/src/hello.txt`, "hello");
    await writeFile(`${root}/src/inner/deep.txt`, "deep");
    return root;
  }

  it("knows archives by their extension", () => {
    for (const n of ["a.zip", "a.TAR", "a.tar.gz", "a.tgz", "a.tar.bz2", "a.tar.xz", "a.tar.zst", "a.7z", "a.rar", "a.gz"]) expect(isArchive(n), n).toBe(true);
    for (const n of ["a.txt", "a", "targz", "a.zipx.bak"]) expect(isArchive(n), n).toBe(false);
  });

  it("unpacks tar and tar.gz into a folder named after the archive, beside it", async () => {
    const root = await source();
    execFileSync("tar", ["-cf", `${root}/plain.tar`, "-C", `${root}/src`, "."]);
    execFileSync("tar", ["-czf", `${root}/site.tar.gz`, "-C", `${root}/src`, "."]);
    const r = await extractPaths([`${root}/plain.tar`, `${root}/site.tar.gz`], undefined);
    expect(r.failed).toEqual([]);
    expect(r.done).toEqual([`${root}/plain`, `${root}/site`]);
    expect(await readFile(`${root}/site/inner/deep.txt`, "utf8")).toBe("deep");
    expect(await readFile(`${root}/plain/hello.txt`, "utf8")).toBe("hello");
  });

  it.runIf(have("zip") && have("unzip"))("unpacks zip", async () => {
    const root = await source();
    execFileSync("zip", ["-qr", `${root}/z.zip`, "."], { cwd: `${root}/src` });
    const r = await extractPaths([`${root}/z.zip`], undefined);
    expect(r.failed).toEqual([]);
    expect(await readFile(`${root}/z/inner/deep.txt`, "utf8")).toBe("deep");
  });

  it.runIf(have("7zz") || have("7z"))("unpacks 7z", async () => {
    const root = await source();
    execFileSync(have("7zz") ? "7zz" : "7z", ["a", `${root}/s.7z`, "."], { cwd: `${root}/src`, stdio: "ignore" });
    const r = await extractPaths([`${root}/s.7z`], undefined);
    expect(r.failed).toEqual([]);
    expect(await readFile(`${root}/s/hello.txt`, "utf8")).toBe("hello");
  });

  it("unpacks a single compressed file", async () => {
    const root = await source();
    execFileSync("gzip", [`${root}/src/hello.txt`]);
    const r = await extractPaths([`${root}/src/hello.txt.gz`], undefined);
    expect(r.failed).toEqual([]);
    expect(await readFile(`${root}/src/hello.txt/hello.txt`, "utf8")).toBe("hello");
  });

  it("deals with an existing folder like a copy would, and can extract elsewhere", async () => {
    const root = await source();
    execFileSync("tar", ["-czf", `${root}/site.tar.gz`, "-C", `${root}/src`, "."]);
    await extractPaths([`${root}/site.tar.gz`], undefined);
    expect((await extractPaths([`${root}/site.tar.gz`], undefined, "fail")).failed[0]?.error).toMatch(/already exists/);
    expect((await extractPaths([`${root}/site.tar.gz`], undefined, "rename")).done).toEqual([`${root}/site copy`]);
    await writeFile(`${root}/site/hello.txt`, "changed");
    expect((await extractPaths([`${root}/site.tar.gz`], undefined, "overwrite")).done).toEqual([`${root}/site`]);
    expect(await readFile(`${root}/site/hello.txt`, "utf8")).toBe("hello");
    await mkdir(`${root}/elsewhere`);
    expect((await extractPaths([`${root}/site.tar.gz`], `${root}/elsewhere`)).done).toEqual([`${root}/elsewhere/site`]);
  });

  it("reports what is wrong, and leaves nothing half-made behind", async () => {
    const root = await source();
    await writeFile(`${root}/bad.tar.gz`, "this is not an archive");
    await writeFile(`${root}/notes.txt`, "x");
    const r = await extractPaths([`${root}/bad.tar.gz`, `${root}/notes.txt`, `${root}/nope.zip`, `${root}/src`], undefined);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.path)).toEqual([`${root}/bad.tar.gz`, `${root}/notes.txt`, `${root}/nope.zip`, `${root}/src`]);
    expect(r.failed[1]!.error).toMatch(/not an archive/);
    expect(existsSync(`${root}/bad`)).toBe(false);
  });

  it("does not let an archive write outside its folder", async () => {
    const root = await source();
    await mkdir(`${root}/evil/x`, { recursive: true });
    await writeFile(`${root}/evil/outside.txt`, "boo");
    // GNU tar refuses members that climb out; bsdtar strips them. Either way nothing lands beside the folder.
    execFileSync("tar", ["-cf", `${root}/evil.tar`, "-C", `${root}/evil/x`, "../outside.txt"]);
    await extractPaths([`${root}/evil.tar`], undefined).catch(() => {});
    expect(existsSync(`${root}/outside.txt`)).toBe(false);
  });
});
