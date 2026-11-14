import { z } from "zod";
import { FRAME, parseExit, type ConsoleSession } from "@freighter/protocol";
import { roleAtLeast } from "@freighter/registry";
import { IDENT_RE } from "@freighter/manifest";
import type { ApiContext } from "./context.ts";
import { ApiError, toHttpError } from "./errors.ts";
import { SESSION_COOKIE } from "./auth.ts";

/** What a console session needs from the request that opened it (the WebSocket upgrade). */
export interface ConsoleRequest {
  url: string;
  header(name: string): string | null | undefined;
  /** The caller's address, for the audit log. */
  ip?: string;
}

/** Where the shell's output goes (the browser). */
export interface ConsoleSink {
  data(chunk: Buffer): void;
  /** The shell ended; the code is its exit status. */
  exit(code: number): void;
  /** What a command wrote to standard error (a session on a terminal has only `data`). */
  stderr(chunk: Buffer): void;
  /** Something the agent wants the person to read (a refusal, an idle timeout). */
  error(message: string): void;
  /** The session is over, however it ended. */
  closed(): void;
}

export interface ConsoleHandle {
  info: { kind: "host" | "container"; user: string; cwd: string; shell: string };
  /** Keystrokes and pasted text. */
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** No more input is coming. */
  end(): void;
  close(): void;
}

const query = z.object({
  app: z.string().regex(IDENT_RE),
  service: z.string().regex(IDENT_RE),
  cols: z.coerce.number().int().min(1).max(1000).default(80),
  rows: z.coerce.number().int().min(1).max(1000).default(24),
  /** A command to run instead of a shell: a JSON array of words. */
  cmd: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      try {
        const words = JSON.parse(v) as unknown;
        if (Array.isArray(words) && words.length > 0 && words.length <= 512 && words.every((w) => typeof w === "string" && w.length <= 8192)) return words as string[];
      } catch {
        /* fall through */
      }
      ctx.addIssue({ code: "custom", message: "cmd is a JSON array of strings" });
      return z.NEVER;
    }),
  /** `0`: plain pipes instead of a terminal. */
  tty: z.enum(["0", "1"]).default("1"),
  env: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      try {
        const o = JSON.parse(v) as unknown;
        if (o && typeof o === "object" && !Array.isArray(o) && Object.entries(o).every(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof x === "string")) return o as Record<string, string>;
      } catch {
        /* fall through */
      }
      ctx.addIssue({ code: "custom", message: "env is a JSON object of strings" });
      return z.NEVER;
    }),
});

const TOKEN_RE = /^fr_[A-Za-z0-9_-]+$/;

function cookieOf(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/**
 * A browser always names the page that opens a WebSocket, and a page of another site must not be able to use the
 * visitor's session cookie to get a shell. Without an Origin it is not a browser, and has to bring a bearer token.
 */
export function sameOrigin(req: Pick<ConsoleRequest, "header">, trustProxy: boolean): boolean {
  const origin = req.header("origin");
  if (!origin) return true;
  const host = (trustProxy ? req.header("x-forwarded-host")?.split(",")[0]?.trim() : undefined) ?? req.header("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Open a console for a service on behalf of whoever the request is from: admins only, and every session is in the audit
 * log. Throws an ApiError (with a status the caller can use to refuse the upgrade) when it cannot be opened.
 */
export async function openConsole(ctx: ApiContext, req: ConsoleRequest, sink: ConsoleSink): Promise<ConsoleHandle> {
  const bearer = /^Bearer (fr_[A-Za-z0-9_-]+)$/.exec(req.header("authorization") ?? "")?.[1];
  const cookie = cookieOf(req.header("cookie"), SESSION_COOKIE);
  const token = bearer ?? (cookie && TOKEN_RE.test(cookie) ? cookie : undefined);
  const row = token ? ctx.registry.tokens.verify(token) : null;
  if (!row) throw new ApiError(401, "unauthorized", "missing or invalid API token");
  if (bearer === undefined && !sameOrigin(req, ctx.trustProxy)) throw new ApiError(403, "forbidden", "the console must be opened from the dashboard itself");
  if (!roleAtLeast(row.role, "admin")) throw new ApiError(403, "forbidden", "this endpoint requires the admin role");

  const parsed = query.safeParse(Object.fromEntries(new URL(req.url, "http://x").searchParams));
  if (!parsed.success) throw new ApiError(400, "bad_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { app, service, cols, rows, cmd, tty, env } = parsed.data;
  const app_ = ctx.registry.apps.get(app);
  if (!app_) throw new ApiError(404, "not_found", `unknown app "${app}"`);
  if (app_.kind === "storage") throw new ApiError(409, "managed_by_storage", `"${app}" serves a storage; it has no console`);

  let session: ConsoleSession;
  try {
    session = await ctx.agents.forServer(app_.server).openConsole({ app, service, cols, rows, tty: tty === "1", ...(cmd ? { command: cmd } : {}), ...(env ? { env } : {}) }, { timeoutMs: 30_000 });
  } catch (e) {
    const { status, body } = toHttpError(e);
    throw new ApiError(status, body.error?.code ?? "internal", body.error?.message ?? "could not open the console");
  }

  const started = Date.now();
  ctx.registry.audit.add({ tokenId: row.id, action: "console.open", app, detail: { service, server: app_.server, kind: session.result.kind, ip: req.ip, ...(cmd ? { command: cmd[0]!.split("/").pop() } : {}) } }); // the command's name: never its arguments, which can hold secrets
  session.onFrame((f) => {
    if (f.type === FRAME.data) sink.data(f.payload);
    else if (f.type === FRAME.stderr) sink.stderr(f.payload);
    else if (f.type === FRAME.exit) sink.exit(parseExit(f.payload));
    else if (f.type === FRAME.error) sink.error(f.payload.toString("utf8"));
  });
  let over = false;
  session.onClose(() => {
    if (over) return;
    over = true;
    ctx.registry.audit.add({ tokenId: row.id, action: "console.close", app, detail: { service, seconds: Math.round((Date.now() - started) / 1000) } });
    sink.closed();
  });
  return { info: session.result, write: (d) => session.write(d), resize: (c, r) => session.resize(c, r), end: () => session.end(), close: () => session.close() };
}
