import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { bytes, readStdin, type Out } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";
import { isRemote, remotePath } from "../lib/target.ts";
import { finish, parseSpan } from "../lib/wait.ts";
import { listing } from "./files.ts";
import { pipeline } from "node:stream/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join, posix } from "node:path";

interface Backend {
  kind: "local" | "sftp" | "smb";
  host?: string;
  port?: number;
  user?: string;
  path?: string;
  share?: string;
  auth?: "password" | "key";
  hostKey?: string;
  domain?: string;
}
interface Storage {
  name: string;
  server: string;
  backend: Backend;
  public: boolean;
  accessKey: string;
  status: string;
  activeState: string;
  hostnames: string[];
  publicHostnames: string[];
}

const wait = (args: { wait?: boolean; verbose?: boolean }) => ({ wait: args.wait !== false, verbose: args.verbose });
const waitArgs = {
  wait: { type: "boolean", default: true, description: "Wait for it to be applied (--no-wait returns the deployment id)" },
  verbose: { type: "boolean", alias: "v", description: "Show the whole log" },
} as const;

const list = defineCommand({
  meta: { name: "list", description: "The storages" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { storages } = await api().get<{ storages: Storage[] }>("/storages");
      out.ids(storages.map((s) => s.name), storages, () => {
        if (storages.length === 0) return out.note("no storages: `freighter storage create <name> --server <server>` makes one");
        out.table(["NAME", "TYPE", "SERVER", "DOMAIN", "PUBLIC", "STATE"], storages.map((s) => [s.name, s.backend.kind, s.server, s.hostnames[0] ?? "", s.public ? "yes" : "no", s.activeState === "active" ? "running" : s.activeState]));
      });
    }),
});

const show = defineCommand({
  meta: { name: "show", description: "One storage" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const s = await api().get<Storage>(`/storages/${args.name}`);
      out.data(s, () =>
        out.facts([
          ["storage", s.name],
          ["type", s.backend.kind],
          ["server", s.server],
          ["endpoint", s.hostnames[0] ? `https://${s.hostnames[0]}` : "(no domain yet)"],
          ["access key", s.accessKey],
          ["public", s.public ? `yes${s.publicHostnames[0] ? ` (https://${s.publicHostnames[0]})` : ""}` : "no"],
          ["remote", s.backend.kind === "local" ? undefined : `${s.backend.host}${s.backend.share ? `/${s.backend.share}` : ""}${s.backend.path ? `:${s.backend.path}` : ""}`],
          ["state", s.activeState],
        ]),
      );
    }),
});

const backendArgs = {
  type: { type: "string", description: "local (default), sftp or smb" },
  host: { type: "string", description: "sftp/smb: the remote host" },
  port: { type: "string", description: "sftp/smb: its port" },
  user: { type: "string", description: "sftp/smb: the user" },
  path: { type: "string", description: "sftp/smb: the folder on the remote" },
  share: { type: "string", description: "smb: the share" },
  "key-file": { type: "string", description: "sftp: a private key file (use - for standard input) instead of a password" },
  "password-stdin": { type: "boolean", description: "sftp/smb: read the password from standard input" },
  "host-key": { type: "string", description: "sftp: the host key line to pin (default: ask, after testing the connection)" },
} as const;

type BackendFlags = { type?: string; host?: string; port?: string; user?: string; path?: string; share?: string; "key-file"?: string; "password-stdin"?: boolean; "host-key"?: string };

async function secretsFrom(args: BackendFlags): Promise<{ password?: string; privateKey?: string }> {
  const secrets: { password?: string; privateKey?: string } = {};
  if (args["key-file"]) secrets.privateKey = args["key-file"] === "-" ? await readStdin() : readFileSync(args["key-file"], "utf8");
  else if (args["password-stdin"]) secrets.password = (await readStdin()).replace(/\r?\n$/, "");
  return secrets;
}

function backendOf(args: BackendFlags, secrets: { password?: string; privateKey?: string }): Backend {
  const kind = args.type ?? "local";
  if (kind === "local") return { kind };
  if (kind !== "sftp" && kind !== "smb") throw usage(`unknown type "${kind}"`, "local, sftp or smb");
  if (!args.host || !args.user) throw usage(`a ${kind} storage needs --host and --user`);
  const port = args.port === undefined ? undefined : Number(args.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw usage("--port is a port number");
  if (kind === "smb") {
    if (!args.share) throw usage("an smb storage needs --share");
    return { kind, host: args.host, ...(port ? { port } : {}), user: args.user, share: args.share, path: args.path ?? "" };
  }
  if (!secrets.password && !secrets.privateKey) throw usage("an sftp storage needs --password-stdin or --key-file");
  return { kind, host: args.host, ...(port ? { port } : {}), user: args.user, path: args.path ?? "", auth: secrets.privateKey ? "key" : "password", ...(args["host-key"] ? { hostKey: args["host-key"] } : {}) };
}

/** The SSH host key of an sftp storage has to be pinned: test the connection, show its fingerprint, and keep it if it's trusted. */
async function pinHostKey(api: Api, out: Out, server: string, backend: Backend, secrets: object): Promise<Backend> {
  const t = await api.post<{ ok: boolean; error?: string; hostKey?: { line: string; fingerprint: string; type: string } }>("/storages/test", { server, backend, secrets });
  if (!t.ok && !t.hostKey) throw new CliError(`cannot connect to ${backend.host}: ${t.error ?? "no answer"}`);
  if (backend.kind !== "sftp" || backend.hostKey) {
    if (!t.ok) throw new CliError(`cannot connect to ${backend.host}: ${t.error ?? "failed"}`);
    return backend;
  }
  if (!t.hostKey) throw new CliError(`${backend.host} did not offer an SSH host key`);
  await out.confirm(`${backend.host} offers the ${t.hostKey.type} host key ${t.hostKey.fingerprint}.\nPin it? Only say yes if that is the fingerprint of your server.`);
  return { ...backend, hostKey: t.hostKey.line };
}

const create = defineCommand({
  meta: { name: "create", description: "Make a storage" },
  args: {
    name: { type: "positional", required: true },
    server: { type: "string", description: "The server it runs on (default: the first)" },
    domain: { type: "string", description: "The endpoint's domain (verify it afterwards like any other)" },
    public: { type: "boolean", description: "Anyone can read, nobody can write without a key" },
    "public-domain": { type: "string", description: "The public endpoint's domain" },
    ...backendArgs,
    ...waitArgs,
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const secrets = await secretsFrom(args);
      let backend = backendOf(args, secrets);
      const server = args.server ?? (await api().get<{ servers: { name: string }[] }>("/servers")).servers[0]?.name;
      if (!server) throw new CliError("there is no server to put it on", EXIT.notFound);
      if (backend.kind !== "local") backend = await pinHostKey(api(), out, server, backend, secrets);
      const r = await api().post<{ id: string; storage: Storage; accessKey: string; secretKey: string }>("/storages", { name: args.name, server, backend, ...(Object.keys(secrets).length ? { secrets } : {}) });
      out.step(`Creating ${args.name} on ${server}`);
      if (args.domain) await api().post(`/apps/storage-${args.name}/domains`, { hostname: args.domain, service: "s3", tls: "auto" });
      await finish(api(), out, r, { ...wait(args), verb: "storage" });
      if (args.public) {
        const p = await api().patch<{ id: string }>(`/storages/${args.name}`, { public: true });
        if (args["public-domain"]) await api().post(`/apps/storage-${args.name}/domains`, { hostname: args["public-domain"], service: "public", tls: "auto" });
        await finish(api(), out, p, { ...wait(args), verb: "storage" });
      }
      out.data({ name: args.name, accessKey: r.accessKey, secretKey: r.secretKey, endpoint: args.domain ? `https://${args.domain}` : null }, () => {
        out.line(`Storage ${args.name} created on ${server}.`);
        out.facts([["endpoint", args.domain ? `https://${args.domain}` : undefined], ["access key", r.accessKey], ["secret key", `${r.secretKey}   (shown once)`]]);
        if (args.domain) out.line(`\nThen run: freighter domain verify storage-${args.name} ${args.domain}`);
      });
    }),
});

const set = defineCommand({
  meta: { name: "set", description: "Change a storage: public or private, or where the remote is" },
  args: { name: { type: "positional", required: true }, public: { type: "boolean", description: "Make it public" }, private: { type: "boolean", description: "Make it private" }, ...backendArgs, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (args.public && args.private) throw usage("public or private, not both");
      const cur = await api().get<Storage>(`/storages/${args.name}`);
      const changesBackend = !!(args.host || args.port || args.user || args.path || args.share || args["key-file"] || args["password-stdin"] || args["host-key"]);
      const body: Record<string, unknown> = {};
      if (args.public || args.private) body.public = !!args.public;
      if (changesBackend) {
        const secrets = await secretsFrom(args);
        const merged = { ...cur.backend, ...(args.host ? { host: args.host } : {}), ...(args.port ? { port: Number(args.port) } : {}), ...(args.user ? { user: args.user } : {}), ...(args.path !== undefined ? { path: args.path } : {}), ...(args.share ? { share: args.share } : {}), ...(args["host-key"] ? { hostKey: args["host-key"] } : {}) };
        body.backend = merged;
        if (Object.keys(secrets).length) body.secrets = secrets;
      }
      if (Object.keys(body).length === 0) throw usage("nothing to change", "--public, --private, or a remote's settings");
      const r = await api().patch<{ id: string }>(`/storages/${args.name}`, body);
      out.step(`Updating ${args.name}`);
      await finish(api(), out, r, { ...wait(args), verb: "storage" });
    }),
});

const rotate = defineCommand({
  meta: { name: "rotate-keys", description: "A new secret key (the access key stays); apps that use the storage restart" },
  args: { name: { type: "positional", required: true }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await out.confirm(`Make a new secret key for ${args.name}? Anything using the old one stops working.`);
      const r = await api().post<{ id: string; accessKey: string; secretKey: string }>(`/storages/${args.name}/rotate-keys`);
      await finish(api(), out, r, { ...wait(args), verb: "storage" });
      out.data({ accessKey: r.accessKey, secretKey: r.secretKey }, () => out.facts([["access key", r.accessKey], ["secret key", `${r.secretKey}   (shown once)`]]));
    }),
});

const connect = defineCommand({
  meta: { name: "connect", description: "How to use a storage: AWS CLI, rclone, or the variables for an app" },
  args: { name: { type: "positional", required: true }, aws: { type: "boolean" }, rclone: { type: "boolean" }, env: { type: "boolean", description: "Variables for an app's environment, using connections" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const s = await api().get<Storage>(`/storages/${args.name}`);
      const endpoint = s.hostnames[0] ? `https://${s.hostnames[0]}` : null;
      if (!endpoint && !args.env) throw new CliError(`${args.name} has no domain yet`, EXIT.failed, `give it one: freighter domain add storage-${args.name} <hostname> --service s3`);
      if (args.env) {
        return out.data({ environment: { S3_ENDPOINT: `@storage:${s.name}.url`, S3_ACCESS_KEY: `@storage:${s.name}.accessKey`, S3_SECRET_KEY: `@storage:${s.name}.secretKey`, S3_REGION: `@storage:${s.name}.region` } }, () =>
          out.line([`S3_ENDPOINT: "@storage:${s.name}.url"`, `S3_ACCESS_KEY: "@storage:${s.name}.accessKey"`, `S3_SECRET_KEY: "@storage:${s.name}.secretKey"`, `S3_REGION: "@storage:${s.name}.region"`].join("\n")),
        );
      }
      if (args.rclone) return out.line([`[${s.name}]`, "type = s3", "provider = Other", `access_key_id = ${s.accessKey}`, "secret_access_key = <your secret key>", `endpoint = ${endpoint}`, "force_path_style = true"].join("\n"));
      out.data({ endpoint, accessKey: s.accessKey }, () => out.line([`export AWS_ACCESS_KEY_ID=${s.accessKey}`, "export AWS_SECRET_ACCESS_KEY=<your secret key>", `aws --endpoint-url ${endpoint} s3 ls`].join("\n")));
    }),
});

const del = defineCommand({
  meta: { name: "delete", description: "Delete a storage and everything it holds" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await out.confirm(`This deletes the storage ${args.name}, its endpoint, keys and domains. Files on a remote stay there; files in a local storage are removed.\nThere is no undo.`, { typed: args.name, verb: "delete" });
      await api().delete(`/storages/${args.name}`, { confirm: args.name });
      out.data({ deleted: args.name }, () => out.line(`Deleted ${args.name}.`));
    }),
});

// ---- storage file ----

const ls = defineCommand({
  meta: { name: "ls", description: "A bucket or folder" },
  args: { path: { type: "positional", required: true, description: "<storage>:/bucket/prefix" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path, "storage");
      const l = await api().get<{ path: string; parent: string | null; entries: { name: string; type: string; size: number; mtimeMs: number }[]; truncated: boolean }>(`/storages/${r.name}/files`, { path: r.path });
      out.ids(l.entries.map((e) => e.name), l, () => listing(out, l as never, { owner: false }));
    }),
});

const get = defineCommand({
  meta: { name: "get", description: "Download a file" },
  args: { path: { type: "positional", required: true, description: "<storage>:/bucket/key" }, local: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path, "storage");
      const res = await api().response("GET", `/storages/${r.name}/files/download`, { query: { path: r.path } });
      let dest = args.local ?? posix.basename(r.path);
      if (args.local && existsSync(args.local) && statSync(args.local).isDirectory()) dest = join(args.local, posix.basename(r.path));
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
      out.data({ saved: dest }, () => out.note(`Saved ${dest} (${bytes(statSync(dest).size)})`));
    }),
});

const put = defineCommand({
  meta: { name: "put", description: "Upload files" },
  args: { local: { type: "positional", required: true }, path: { type: "positional", required: true, description: "<storage>:/bucket/prefix/ (ending in / for a folder)" }, overwrite: { type: "boolean" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const words = (args as { _?: string[] })._ ?? [];
      const dest = remotePath(words.at(-1)!, "storage");
      const files = words.slice(0, -1);
      if (files.some(isRemote)) throw usage("put uploads files from this machine");
      for (const f of files) {
        const info = existsSync(f) ? statSync(f) : null;
        if (!info?.isFile()) throw new CliError(`${f} is not a file`, EXIT.notFound);
        const key = dest.path.endsWith("/") || files.length > 1 ? posix.join(dest.path, basename(f)) : dest.path;
        await api().request("PUT", `/storages/${dest.name}/files/upload`, { raw: { body: Readable.toWeb(createReadStream(f)) as never, type: "application/octet-stream", length: info.size }, query: { path: key, ...(args.overwrite ? { overwrite: 1 } : {}) } });
        out.step(`${f} -> ${dest.name}:${key} (${bytes(info.size)})`);
      }
      out.data({ storage: dest.name, uploaded: files.length }, () => out.line(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}.`));
    }),
});

const mkdir = defineCommand({
  meta: { name: "mkdir", description: "Make a bucket or folder" },
  args: { path: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path, "storage");
      await api().post(`/storages/${r.name}/files/mkdir`, { path: r.path });
      out.data(r, () => out.line(`Made ${r.name}:${r.path}.`));
    }),
});

const mv = defineCommand({
  meta: { name: "mv", description: "Rename a file or folder (within its folder)" },
  args: { from: { type: "positional", required: true }, to: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const a = remotePath(args.from, "storage");
      const b = remotePath(args.to, "storage");
      if (a.name !== b.name || posix.dirname(a.path) !== posix.dirname(b.path)) throw usage("a storage file can only be renamed within its folder");
      await api().post(`/storages/${a.name}/files/rename`, { path: a.path, newName: posix.basename(b.path) });
      out.data({ from: a.path, to: b.path }, () => out.line(`Renamed to ${b.path}.`));
    }),
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete files and folders" },
  args: { path: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const targets = [args.path, ...(((args as { _?: string[] })._ ?? []).slice(1))].map((p) => remotePath(p, "storage"));
      if (new Set(targets.map((t) => t.name)).size > 1) throw usage("one storage at a time");
      await out.confirm(`Delete ${targets.map((t) => t.path).join(", ")} from ${targets[0]!.name}? There is no undo.`);
      const r = await api().post<{ done: string[]; failed: { path: string; error: string }[] }>(`/storages/${targets[0]!.name}/files/delete`, { paths: targets.map((t) => t.path) });
      out.data(r, () => {
        out.line(`Deleted ${r.done.length}.`);
        for (const f of r.failed) out.warn(`${f.path}: ${f.error}`);
      });
      if (r.failed.length) throw new CliError(`${r.failed.length} could not be deleted`);
    }),
});

const link = defineCommand({
  meta: { name: "link", description: "An address that downloads a file without a key" },
  args: { path: { type: "positional", required: true, description: "<storage>:/bucket/key" }, expires: { type: "string", description: "How long a signed link works: 60s to 7d (default 1h)", default: "1h" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = remotePath(args.path, "storage");
      const s = await api().get<Storage>(`/storages/${r.name}`);
      if (s.public && s.publicHostnames[0]) {
        const url = `https://${s.publicHostnames[0]}${r.path}`;
        return out.ids([url], { url, expiresAt: null }, () => out.line(url));
      }
      const seconds = Math.round(parseSpan(args.expires) / 1000);
      const l = await api().post<{ url: string; expiresAt: string }>(`/storages/${r.name}/files/link`, { path: r.path, expires: seconds });
      out.ids([l.url], l, () => out.line(l.url));
    }),
});

const storageFile = defineCommand({ meta: { name: "file", description: "The files in a storage" }, subCommands: { ls, get, put, mkdir, mv, rm, link } });

export const storage = defineCommand({
  meta: { name: "storage", description: "S3 storages" },
  subCommands: { list, show, create, set, "rotate-keys": rotate, connect, delete: del, file: storageFile },
});
