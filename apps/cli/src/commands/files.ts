import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { ago, bytes, type Out } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";
import { isRemote, remotePath } from "../lib/target.ts";

interface Entry {
  name: string;
  type: string;
  size: number;
  mtimeMs: number;
  owner?: string;
  group?: string;
  link?: { target: string } | null;
}
interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
  truncated: boolean;
}

/** What `ls` prints: folders with a slash, links with where they point. */
export function listing(out: Out, l: Listing, o: { owner: boolean }): void {
  const rows = l.entries.map((e) => [e.type === "dir" ? `${e.name}/` : e.link ? `${e.name} -> ${e.link.target}` : e.name, e.type === "dir" ? "" : bytes(e.size), ago(new Date(e.mtimeMs).toISOString()), ...(o.owner ? [e.owner ?? ""] : [])]);
  if (rows.length === 0) return out.note("empty");
  out.table(["NAME", "SIZE", "MODIFIED", ...(o.owner ? ["OWNER"] : [])], rows);
  if (l.truncated) out.warn("the list was cut short");
}

const exists = async (api: Api, path: string, base: string): Promise<"dir" | "none"> =>
  api.get<Listing>(`${base}`, { path }).then(() => "dir" as const, () => "none" as const);

/** Save a download to a path, or into it when it is a folder. */
async function save(res: Response, local: string | undefined, name: string, out: Out): Promise<string> {
  let dest = local ?? name;
  if (local && existsSync(local) && statSync(local).isDirectory()) dest = join(local, name);
  if (!res.body) throw new CliError("the download was empty");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  out.note(`Saved ${dest} (${bytes(statSync(dest).size)})`);
  return dest;
}

const ls = defineCommand({
  meta: { name: "ls", description: "A folder on a server" },
  args: { path: { type: "positional", required: true, description: "<server>:<path>" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path);
      const l = await api().get<Listing>(`/servers/${r.name}/fs`, { path: r.path });
      out.ids(l.entries.map((e) => e.name), l, () => listing(out, l, { owner: true }));
    }),
});

const cat = defineCommand({
  meta: { name: "cat", description: "Print a file" },
  args: { path: { type: "positional", required: true, description: "<server>:<path>" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ api }) => {
      const r = remotePath(args.path);
      const res = await api().response("GET", `/servers/${r.name}/fs/download`, { query: { path: r.path } });
      await pipeline(Readable.fromWeb(res.body as never), process.stdout, { end: false });
    }),
});

const get = defineCommand({
  meta: { name: "get", description: "Download a file, or a folder as a .zip" },
  args: { path: { type: "positional", required: true, description: "<server>:<path>" }, local: { type: "positional", required: false, description: "Where to save it (default: here)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path);
      const name = posix.basename(r.path.replace(/\/+$/, "")) || r.name;
      const dest = await (async () => {
        if ((await exists(api(), r.path, `/servers/${r.name}/fs`)) === "dir") {
          const { ticket, name: zip } = await api().post<{ ticket: string; name: string }>(`/servers/${r.name}/fs/archive`, { paths: [r.path] });
          return save(await api().response("GET", `/servers/${r.name}/fs/archive/${ticket}`), args.local, zip, out);
        }
        return save(await api().response("GET", `/servers/${r.name}/fs/download`, { query: { path: r.path } }), args.local, name, out);
      })();
      out.data({ saved: dest }, () => undefined);
    }),
});

const put = defineCommand({
  meta: { name: "put", description: "Upload a file" },
  args: { local: { type: "positional", required: true }, path: { type: "positional", required: true, description: "<server>:<path>, ending in / for a folder" }, overwrite: { type: "boolean", description: "Replace a file that is there" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (isRemote(args.local)) throw usage("put uploads a file from this machine", "to download, use `freighter file get`");
      const info = existsSync(args.local) ? statSync(args.local) : null;
      if (!info?.isFile()) throw new CliError(`${args.local} is not a file`, EXIT.notFound);
      const r = remotePath(args.path);
      const dest = r.path.endsWith("/") ? posix.join(r.path, basename(args.local)) : (await exists(api(), r.path, `/servers/${r.name}/fs`)) === "dir" ? posix.join(r.path, basename(args.local)) : r.path;
      await api().request("PUT", `/servers/${r.name}/fs/upload`, { raw: { body: Readable.toWeb(createReadStream(args.local)) as never, type: "application/octet-stream", length: info.size }, query: { path: dest, ...(args.overwrite ? { overwrite: 1 } : {}) } });
      out.data({ server: r.name, path: dest, bytes: info.size }, () => out.line(`Uploaded ${basename(args.local)} to ${r.name}:${dest} (${bytes(info.size)}).`));
    }),
});

const mkdir = defineCommand({
  meta: { name: "mkdir", description: "Make a folder" },
  args: { path: { type: "positional", required: true, description: "<server>:<path>" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path);
      await api().post(`/servers/${r.name}/fs/mkdir`, { path: r.path });
      out.data(r, () => out.line(`Made ${r.name}:${r.path}.`));
    }),
});

const mv = defineCommand({
  meta: { name: "mv", description: "Move or rename" },
  args: { from: { type: "positional", required: true }, to: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const a = remotePath(args.from);
      const b = remotePath(args.to);
      if (a.name !== b.name) throw usage("moving between servers isn't supported", "`file get` then `file put`");
      const base = `/servers/${a.name}/fs`;
      const intoFolder = b.path.endsWith("/") || (await exists(api(), b.path, base)) === "dir";
      const target = intoFolder ? posix.join(b.path, posix.basename(a.path)) : b.path;
      if (posix.dirname(a.path) !== posix.dirname(target)) await api().post(`${base}/move`, { paths: [a.path], to: posix.dirname(target) });
      if (posix.basename(a.path) !== posix.basename(target)) await api().post(`${base}/rename`, { path: posix.join(posix.dirname(target), posix.basename(a.path)), name: posix.basename(target) });
      out.data({ from: a.path, to: target }, () => out.line(`Moved to ${a.name}:${target}.`));
    }),
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete files and folders" },
  args: { path: { type: "positional", required: true, description: "<server>:<path> ..." }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const targets = [args.path, ...(((args as { _?: string[] })._ ?? []).slice(1))].map((p) => remotePath(p));
      if (new Set(targets.map((t) => t.name)).size > 1) throw usage("one server at a time");
      await out.confirm(`Delete ${targets.map((t) => t.path).join(", ")} on ${targets[0]!.name}? There is no undo.`);
      const r = await api().post<{ done: string[]; failed: { path: string; error: string }[] }>(`/servers/${targets[0]!.name}/fs/delete`, { paths: targets.map((t) => t.path) });
      out.data(r, () => {
        out.line(`Deleted ${r.done.length}.`);
        for (const f of r.failed) out.warn(`${f.path}: ${f.error}`);
      });
      if (r.failed.length) throw new CliError(`${r.failed.length} could not be deleted`);
    }),
});

const extract = defineCommand({
  meta: { name: "extract", description: "Unpack archives (.zip, .tar.gz, .7z ...) into a folder named after each" },
  args: { path: { type: "positional", required: true, description: "<server>:<path> ..." }, to: { type: "string", description: "Where to unpack (default: beside the archive)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const targets = [args.path, ...(((args as { _?: string[] })._ ?? []).slice(1))].map((p) => remotePath(p));
      const r = await api().post<{ done: string[]; failed: { path: string; error: string }[] }>(`/servers/${targets[0]!.name}/fs/extract`, { paths: targets.map((t) => t.path), ...(args.to ? { to: args.to } : {}) });
      out.data(r, () => {
        for (const d of r.done) out.line(`Unpacked to ${d}`);
        for (const f of r.failed) out.warn(`${f.path}: ${f.error}`);
      });
      if (r.failed.length) throw new CliError(`${r.failed.length} could not be unpacked`);
    }),
});

const chown = defineCommand({
  meta: { name: "chown", description: "Change the owner or group" },
  args: { path: { type: "positional", required: true, description: "<server>:<path> ..." }, owner: { type: "string", description: "The user (name or number)" }, group: { type: "string", description: "The group" }, r: { type: "boolean", alias: "r", description: "Through folders, recursively" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (!args.owner && !args.group) throw usage("give --owner, --group or both");
      const targets = [args.path, ...(((args as { _?: string[] })._ ?? []).slice(1))].map((p) => remotePath(p));
      if (args.r) await out.confirm(`Change the owner of everything under ${targets.map((t) => t.path).join(", ")}? It can't be undone.`);
      const r = await api().post<{ done: string[]; failed: { path: string; error: string }[] }>(`/servers/${targets[0]!.name}/fs/chown`, { paths: targets.map((t) => t.path), ...(args.owner ? { owner: args.owner } : {}), ...(args.group ? { group: args.group } : {}), ...(args.r ? { recursive: true } : {}) });
      out.data(r, () => {
        out.line(`Changed ${r.done.length}.`);
        for (const f of r.failed) out.warn(`${f.path}: ${f.error}`);
      });
      if (r.failed.length) throw new CliError(`${r.failed.length} could not be changed`);
    }),
});

export const file = defineCommand({
  meta: { name: "file", description: "A server's files" },
  subCommands: { ls, cat, get, put, mkdir, mv, rm, extract, chown },
});

export { dirname };
