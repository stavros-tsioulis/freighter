import type { FsEntry } from "~/types";

/** Paths in the file explorer are absolute, with `/` as the separator. */
export const joinPath = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
export const parentOf = (path: string) => (path === "/" ? "/" : path.replace(/\/[^/]*$/, "") || "/");
export const baseName = (path: string) => (path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1));

/** `/srv/apps/shop` -> [/, srv, apps, shop], each with the path that opens it. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

/** Turn what was typed into an absolute path (the folder it is relative to is `base`); `~` goes to /root. */
export function resolveTyped(input: string, base: string): string {
  let text = input.trim();
  if (text === "") return base;
  if (text === "~" || text.startsWith("~/")) text = `/root${text.slice(1)}`;
  const joined = text.startsWith("/") ? text : joinPath(base, text);
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** `rwxr-xr-x`, with the setuid/setgid/sticky letters. */
export function formatMode(mode: number): string {
  const bit = (shift: number, letters: string, special: boolean, specialLetter: string) => {
    const r = mode & (4 << shift) ? "r" : "-";
    const w = mode & (2 << shift) ? "w" : "-";
    const x = mode & (1 << shift);
    return r + w + (special ? (x ? specialLetter : specialLetter.toUpperCase()) : x ? "x" : "-");
  };
  return bit(6, "", !!(mode & 0o4000), "s") + bit(3, "", !!(mode & 0o2000), "s") + bit(0, "", !!(mode & 0o1000), "t");
}

export type SortKey = "name" | "size" | "mtime";

/** Folders first, then by the chosen column. A link to a folder counts as a folder. */
export function sortEntries(entries: FsEntry[], key: SortKey, desc: boolean): FsEntry[] {
  const isDir = (e: FsEntry) => e.type === "dir" || (e.type === "link" && e.link?.type === "dir");
  const dir = desc ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const by = key === "size" ? a.size - b.size : key === "mtime" ? a.mtimeMs - b.mtimeMs : byName;
    return by !== 0 ? by * dir : byName;
  });
}

/** Whether double-clicking opens it as a folder. */
export const opensAsFolder = (e: FsEntry) => e.type === "dir" || (e.type === "link" && e.link?.type === "dir");

/** Whether the file explorer can extract a file of this name (the agent decides the same way). */
export const isArchive = (name: string) => /\.(zip|tar|tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tzst|7z|rar|gz|bz2|xz)$/i.test(name);

export function entryIcon(e: FsEntry): string {
  if (opensAsFolder(e)) return e.type === "link" ? "pi pi-folder-plus" : "pi pi-folder";
  if (e.type === "link") return "pi pi-link";
  if (e.type === "other") return "pi pi-question-circle";
  if (isArchive(e.name)) return "pi pi-box";
  if (/\.(png|jpe?g|gif|webp|svg|avif|ico)$/i.test(e.name)) return "pi pi-image";
  if (/\.(log|txt|md|json|ya?ml|toml|conf|cfg|ini|env|sh|js|mjs|ts|py|service|mount)$/i.test(e.name)) return "pi pi-file-edit";
  return "pi pi-file";
}

/** Where a dropped file goes: its place inside the dropped folder, if it came from one. */
export const relativeTarget = (dir: string, relativePath: string) => joinPath(dir, relativePath.replace(/^\/+/, ""));

/** Names in `names` that already exist in the folder being shown. */
export const clashes = (names: string[], listing: FsEntry[]) => {
  const have = new Set(listing.map((e) => e.name));
  return names.filter((n) => have.has(n));
};

/** A count of things, as words. */
export const items = (n: number) => (n === 1 ? "1 item" : `${n} items`);
