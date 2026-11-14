import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { resolveConnection } from "../config.ts";
import { CHARACTER_LIMIT } from "../constants.ts";
import { tail } from "../format.ts";

/** The console's WebSocket messages (WIRE in @freighter/api): a byte for what it is, then its content. */
const MSG = { data: 0, exit: 2, error: 3, ready: 4, eof: 6, stderr: 7 } as const;
const MAX_CAPTURE = 4 * CHARACTER_LIMIT;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run one command in a service over the console's WebSocket, without a terminal, and collect what it prints. */
export function execIn(o: { url: string; token: string; app: string; service: string; command: string[]; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/_console";
    const q = new URLSearchParams({ app: o.app, service: o.service, cols: "80", rows: "24", tty: "0", cmd: JSON.stringify(o.command) });
    if (o.env && Object.keys(o.env).length) q.set("env", JSON.stringify(o.env));
    u.search = q.toString();

    const ws = new WebSocket(u, { headers: { authorization: `Bearer ${o.token}` } } as never);
    ws.binaryType = "arraybuffer";
    const dec = { out: new TextDecoder(), err: new TextDecoder() };
    let stdout = "";
    let stderr = "";
    let code: number | undefined;
    let reason = "";
    let timedOut = false;
    const add = (which: "out" | "err", b: Uint8Array) => {
      const s = dec[which].decode(b, { stream: true });
      if (which === "out") stdout = (stdout + s).slice(-MAX_CAPTURE);
      else stderr = (stderr + s).slice(-MAX_CAPTURE);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      ws.close();
    }, o.timeoutMs);
    const abort = () => ws.close();
    o.signal?.addEventListener("abort", abort, { once: true });
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
    };

    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      const body = b.subarray(1);
      if (b[0] === MSG.ready) ws.send(new Uint8Array([MSG.eof]));
      else if (b[0] === MSG.data) add("out", body);
      else if (b[0] === MSG.stderr) add("err", body);
      else if (b[0] === MSG.error) reason = new TextDecoder().decode(body);
      else if (b[0] === MSG.exit && body.length === 4) code = new DataView(body.buffer, body.byteOffset, 4).getInt32(0);
    };
    ws.onclose = () => {
      done();
      if (code !== undefined || timedOut) return resolve({ code: code ?? -1, stdout, stderr, timedOut });
      reject(new Error(reason || "The connection closed before the command ended."));
    };
    ws.onerror = () => {
      done();
      reject(new Error(`Cannot open the console on ${o.url}: check the URL and that the token has the admin role.`));
    };
  });
}

export function registerExecTools(server: McpServer): void {
  server.registerTool(
    "freighter_exec",
    {
      title: "Run a command in a service",
      description: `Run one non-interactive command inside a running service (in the container for container services, as the service's user otherwise) and return its output and exit code. Its input is empty, so a command that waits for input gets end-of-file.

The command is an argument list, not a shell line: ["ls", "-la"], or ["sh", "-c", "cat a | wc -l"] when a pipe is needed. Output beyond ${CHARACTER_LIMIT} characters keeps its end.
This changes the live service if the command does: prefer read-only commands unless asked. Needs the admin role, and is recorded in the audit log.
Example: "which database tables does shop have?" -> app="shop", service="db", command=["psql","-c","\\\\dt"].`,
      inputSchema: z.strictObject({
        app: z.string().min(1).describe("The app's name"),
        service: z.string().min(1).describe("The service's name"),
        command: z.array(z.string()).min(1).max(200).describe('Program and arguments, e.g. ["ls","-la"]'),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional().describe("Extra environment variables for this command only"),
        timeout_seconds: z.number().int().min(1).max(600).default(60).describe("Stop waiting after this long (1-600)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ app, service, command, env, timeout_seconds }, ctx) => {
      const c = resolveConnection();
      const r = await execIn({ url: c.url, token: c.token, app, service, command, env, timeoutMs: timeout_seconds * 1000, signal: ctx.mcpReq.signal });
      const out = tail(r.stdout);
      const err = tail(r.stderr, CHARACTER_LIMIT / 4);
      const head = r.timedOut ? `Stopped after ${timeout_seconds}s without the command ending.` : `Exit code ${r.code}.`;
      const text = [head, out.text ? `\nstdout:\n${out.text}` : "", err.text ? `\nstderr:\n${err.text}` : ""].join("");
      return { content: [{ type: "text", text }], structuredContent: { exit_code: r.timedOut ? null : r.code, timed_out: r.timedOut, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated }, ...(r.timedOut || r.code !== 0 ? { isError: true } : {}) };
    },
  );
}
