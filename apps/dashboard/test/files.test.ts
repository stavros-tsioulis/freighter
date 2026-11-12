import { describe, expect, it } from "vitest";
import type { FsEntry } from "../app/types";
import { baseName, breadcrumbs, clashes, entryIcon, formatMode, items, joinPath, opensAsFolder, parentOf, resolveTyped, sortEntries } from "../app/utils/files";

const e = (name: string, over: Partial<FsEntry> = {}): FsEntry => ({ name, type: "file", size: 0, mtimeMs: 0, mode: 0o644, uid: 0, gid: 0, owner: "root", group: "root", ...over });

describe("paths", () => {
  it("joins, finds the parent and the name", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/srv/apps", "shop")).toBe("/srv/apps/shop");
    expect(parentOf("/srv/apps/shop")).toBe("/srv/apps");
    expect(parentOf("/srv")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(baseName("/srv/apps/shop")).toBe("shop");
  });
  it("splits a path into clickable parts", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
    expect(breadcrumbs("/srv/apps")).toEqual([{ name: "/", path: "/" }, { name: "srv", path: "/srv" }, { name: "apps", path: "/srv/apps" }]);
  });
  it("understands what is typed in the path box", () => {
    expect(resolveTyped("/etc/../var//log/", "/srv")).toBe("/var/log");
    expect(resolveTyped("apps/./shop", "/srv")).toBe("/srv/apps/shop");
    expect(resolveTyped("..", "/srv/apps")).toBe("/srv");
    expect(resolveTyped("../../..", "/srv")).toBe("/");
    expect(resolveTyped("~/x", "/srv")).toBe("/root/x");
    expect(resolveTyped("  ", "/srv")).toBe("/srv");
  });
});

describe("entries", () => {
  it("shows permissions the way ls does", () => {
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatMode(0o600)).toBe("rw-------");
    expect(formatMode(0o4755)).toBe("rwsr-xr-x");
    expect(formatMode(0o1777)).toBe("rwxrwxrwt");
    expect(formatMode(0o2640)).toBe("rw-r-S---");
  });
  it("sorts folders first, then by the column, either way", () => {
    const list = [e("b.txt", { size: 5, mtimeMs: 1 }), e("a", { type: "dir" }), e("c.txt", { size: 9, mtimeMs: 3 }), e("10.txt", { size: 1, mtimeMs: 2 }), e("2.txt", { size: 1, mtimeMs: 2 }), e("lnk", { type: "link", link: { target: "/x", type: "dir" } })];
    expect(sortEntries(list, "name", false).map((x) => x.name)).toEqual(["a", "lnk", "2.txt", "10.txt", "b.txt", "c.txt"]);
    expect(sortEntries(list, "name", true).map((x) => x.name)).toEqual(["lnk", "a", "c.txt", "b.txt", "10.txt", "2.txt"]);
    expect(sortEntries(list, "size", true).map((x) => x.name).slice(2)).toEqual(["c.txt", "b.txt", "2.txt", "10.txt"]); // ties by name
    expect(sortEntries(list, "mtime", false).map((x) => x.name).slice(2)).toEqual(["b.txt", "2.txt", "10.txt", "c.txt"]);
  });
  it("knows what opens as a folder and which icon to give", () => {
    expect(opensAsFolder(e("a", { type: "dir" }))).toBe(true);
    expect(opensAsFolder(e("l", { type: "link", link: { target: "/x", type: "dir" } }))).toBe(true);
    expect(opensAsFolder(e("l", { type: "link", link: { target: "/x", type: "missing" } }))).toBe(false);
    expect(entryIcon(e("a.zip"))).toBe("pi pi-box");
    expect(entryIcon(e("a.service"))).toBe("pi pi-file-edit");
    expect(entryIcon(e("dir", { type: "dir" }))).toBe("pi pi-folder");
  });
  it("finds names that would be replaced, and counts", () => {
    expect(clashes(["a", "b"], [e("b"), e("c")])).toEqual(["b"]);
    expect(items(1)).toBe("1 item");
    expect(items(3)).toBe("3 items");
  });
});

describe("isArchive", () => {
  it("matches what the agent can extract", async () => {
    const { isArchive } = await import("../app/utils/files");
    for (const n of ["a.zip", "a.TAR", "a.tar.gz", "a.tgz", "a.tar.bz2", "a.tar.xz", "a.tar.zst", "a.7z", "a.rar", "a.gz"]) expect(isArchive(n), n).toBe(true);
    for (const n of ["a.txt", "tar", "a.zipx"]) expect(isArchive(n), n).toBe(false);
  });
});
