import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "@freighter/api";
import { PkiStore } from "@freighter/pki";
import { openRegistry, type Role } from "@freighter/registry";
import { Readable } from "node:stream";
import { createApp, toNodeListener, useBase } from "h3";

export const cliPath = join(import.meta.dirname, "../dist/cli.js");
export const hello = join(import.meta.dirname, "../../../examples/hello");

export interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. `FREIGHTER_*` from the test's own environment never leaks in. */
export function cli(args: string[], o: { env?: Record<string, string>; cwd?: string; input?: string; /** Stop it after this long, as a person pressing Ctrl+C would, and return what it printed. */ killAfterMs?: number } = {}): Promise<Result> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FREIGHTER_")) env[k] = v;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [cliPath, ...args], { cwd: o.cwd ?? join(import.meta.dirname, ".."), env: { ...env, NO_COLOR: "1", ...o.env }, ...(o.killAfterMs ? { timeout: o.killAfterMs, killSignal: "SIGINT" as const } : {}) }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code?: number }).code as number) : 130) : 0, stdout, stderr }),
    );
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

/** A config file of its own, so a test never touches the real `~/.config`. */
export const isolated = () => ({ FREIGHTER_CONFIG: join(mkdtempSync(join(tmpdir(), "freighter-cli-cfg-")), "config.json") });

type Handler = (args: any) => unknown;

/**
 * The real API over HTTP, with a registry in memory and a fake agent behind it. `handlers` answers agent operations;
 * `calls` records them.
 */
export async function startApi(o: { handlers?: Record<string, Handler>; role?: Role } = {}) {
  const registry = openRegistry(":memory:");
  const calls: { op: string; args: any }[] = [];
  const handlers: Record<string, Handler> = {
    ping: () => ({ version: "0.0.0", time: "2026-11-06T10:00:00.000Z", capabilities: ["images", "console"] }),
    ...o.handlers,
  };
  /** What `fs.read` and `fs.archive` stream back, and what `fs.write` received. */
  const streams: Record<string, (args: any) => { result: unknown; body: Readable }> = {};
  const uploads: { args: any; bytes: Buffer }[] = [];
  const agent = {
    async call(op: string, args: unknown) {
      calls.push({ op, args });
      const h = handlers[op];
      if (!h) throw new Error(`unexpected agent operation ${op}`);
      return h(args);
    },
    async openStream(op: string, args: unknown) {
      calls.push({ op, args });
      const h = streams[op];
      if (!h) throw new Error(`unexpected agent stream ${op}`);
      return h(args);
    },
    async writeFile(args: unknown, body: Readable) {
      calls.push({ op: "fs.write", args });
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(Buffer.from(c as Buffer));
      uploads.push({ args, bytes: Buffer.concat(parts) });
    },
  };
  const api = createApi({ registry, agents: { forServer: () => agent as never }, pki: new PkiStore(mkdtempSync(join(tmpdir(), "freighter-pki-"))), artifactsDir: mkdtempSync(join(tmpdir(), "freighter-spool-")), maxUploadBytes: 10_000_000, trustProxy: false, publicIps: ["203.0.113.7"] });
  const outer = createApp();
  outer.use(useBase("/api", api.app.handler));
  const server: Server = createServer(toNodeListener(outer));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (role: Role) => registry.tokens.create({ name: role, role }).token;
  return {
    url,
    registry,
    calls,
    handlers,
    streams,
    uploads,
    token,
    admin: token("admin"),
    /** Environment for a command run as this token, with nothing saved on disk. */
    env: (t: string) => ({ FREIGHTER_URL: url, FREIGHTER_TOKEN: t }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
