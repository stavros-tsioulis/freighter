import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { LineReader } from "./framing.ts";
import { FRAME, FrameDecoder, encodeFrame, resizeFrame, type Frame } from "./console.ts";
import { MAX_LINE_BYTES, ops, type ErrorCode, type ErrorExtra, type OpArgs, type OpName, type OpResult, type Reply } from "./schemas.ts";

export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode | "unavailable" | "timeout",
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** A running `console.open`: write keystrokes, hear the shell. */
export interface ConsoleSession {
  result: OpResult<"console.open">;
  /** Keystrokes (or pasted text) for the shell. */
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** Every frame the agent sends: `data` (output), then `exit` or `error`. */
  onFrame(cb: (frame: Frame) => void): void;
  /** The connection ended, whichever way. */
  onClose(cb: () => void): void;
  close(): void;
}

export type AgentTarget =
  | { kind: "unix"; path: string }
  | { kind: "tls"; host: string; port: number; ca: string; cert: string; key: string; pinnedFingerprint?: string };

export interface AgentClient {
  call<N extends OpName>(op: N, args: OpArgs<N>, opts?: { timeoutMs?: number }): Promise<OpResult<N>>;
  /** Upload a file into the agent's artifact spool as `<id>.tar.gz`; resolves with its path on the agent host. */
  putArtifact(id: string, filePath: string, opts?: { timeoutMs?: number }): Promise<{ path: string }>;
  /** `fs.write`: send `size` bytes from `body`; resolves once the agent has put the file in place. */
  writeFile(args: OpArgs<"fs.write">, body: Readable, opts?: { timeoutMs?: number }): Promise<void>;
  /** `console.open`: a shell on the server, for as long as the session is held open. */
  openConsole(args: OpArgs<"console.open">, opts?: { timeoutMs?: number }): Promise<ConsoleSession>;
  /** `fs.read` or `fs.archive`: the reply, and the bytes that follow it. Destroy `body` to stop early. */
  openStream<N extends "fs.read" | "fs.archive">(op: N, args: OpArgs<N>, opts?: { timeoutMs?: number }): Promise<{ result: OpResult<N>; body: Readable }>;
}

function open(target: AgentTarget): { socket: Socket; where: string } {
  if (target.kind === "unix") return { socket: netConnect(target.path), where: target.path };
  const pinned = target.pinnedFingerprint?.replace(/^SHA256:/, "").toUpperCase();
  const socket = tlsConnect({
    host: target.host,
    port: target.port,
    ca: target.ca,
    cert: target.cert,
    key: target.key,
    minVersion: "TLSv1.3",
    servername: isIP(target.host) ? undefined : target.host,
    checkServerIdentity: (host, cert) => {
      const err = checkServerIdentity(host, cert);
      if (err) return err;
      if (pinned && cert.fingerprint256.toUpperCase() !== pinned) return new Error("agent certificate does not match the pinned fingerprint");
      return undefined;
    },
  });
  return { socket: socket as unknown as Socket, where: `${target.host}:${target.port}` };
}

/** Client for an agent: one short-lived connection per call, over a unix socket or mutual TLS. */
export function createAgentClient(target: string | AgentTarget, defaults: { timeoutMs?: number } = {}): AgentClient {
  const t: AgentTarget = typeof target === "string" ? { kind: "unix", path: target } : target;
  let counter = 0;

  /** Send `op`, optionally stream a body after the header, and resolve with the raw reply line's payload. */
  function exchange(op: string, args: unknown, timeoutMs: number, body?: (socket: Socket) => void): Promise<unknown> {
    const id = `${process.pid}-${++counter}`;
    return new Promise((resolve, reject) => {
      const { socket, where } = open(t);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const fail = (e: AgentError) =>
        finish(() => {
          socket.destroy();
          reject(e);
        });
      const timer = setTimeout(() => fail(new AgentError("timeout", `agent did not answer ${op} within ${timeoutMs}ms`)), timeoutMs);
      socket.once("error", (e: NodeJS.ErrnoException) => fail(new AgentError("unavailable", `cannot reach agent at ${where}: ${e.code ?? e.message}`)));
      socket.once("close", () => fail(new AgentError("unavailable", "agent closed the connection without a reply")));
      new LineReader(
        socket,
        (line) => {
          let reply: Reply;
          try {
            reply = JSON.parse(line) as Reply;
          } catch {
            return fail(new AgentError("internal", "agent sent invalid JSON"));
          }
          if (reply.id !== id) return;
          finish(() => {
            socket.removeAllListeners("close");
            socket.end();
            if (reply.ok) resolve(reply.result);
            else reject(new AgentError(reply.error.code, reply.error.message, reply.error));
          });
        },
        () => fail(new AgentError("internal", `agent reply exceeded ${MAX_LINE_BYTES} bytes`)),
      );
      socket.write(JSON.stringify({ id, op, args }) + "\n");
      body?.(socket);
    });
  }

  return {
    async call(op, args, opts) {
      const raw = await exchange(op, args, opts?.timeoutMs ?? defaults.timeoutMs ?? 20 * 60_000);
      const parsed = ops[op].result.safeParse(raw);
      if (!parsed.success) throw new AgentError("internal", `agent reply for ${op} did not match the protocol`);
      return parsed.data as OpResult<typeof op>;
    },
    async writeFile(args, body, opts) {
      await exchange("fs.write", args, opts?.timeoutMs ?? 2 * 3_600_000, (socket) => {
        body.on("error", () => socket.destroy());
        body.pipe(socket, { end: false });
      });
    },
    openStream(op, args, opts) {
      const id = `${process.pid}-${++counter}`;
      const idleMs = opts?.timeoutMs ?? 120_000;
      return new Promise((resolve, reject) => {
        const { socket, where } = open(t);
        let settled = false;
        let buf: Buffer = Buffer.alloc(0);
        let body: PassThrough | undefined;
        const fail = (e: AgentError) => {
          if (body) return void body.destroy(e);
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(e);
        };
        socket.setTimeout(idleMs, () => fail(new AgentError("timeout", `agent stopped answering ${op}`)));
        socket.on("error", (e: NodeJS.ErrnoException) => fail(new AgentError("unavailable", `cannot reach agent at ${where}: ${e.code ?? e.message}`)));
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const i = buf.indexOf(0x0a);
          if (i === -1) {
            if (buf.length > MAX_LINE_BYTES) fail(new AgentError("internal", `agent reply exceeded ${MAX_LINE_BYTES} bytes`));
            return;
          }
          socket.off("data", onData);
          let reply: Reply;
          try {
            reply = JSON.parse(buf.subarray(0, i).toString("utf8")) as Reply;
          } catch {
            return fail(new AgentError("internal", "agent sent invalid JSON"));
          }
          if (!reply.ok) {
            settled = true;
            socket.destroy();
            return reject(new AgentError(reply.error.code, reply.error.message, reply.error));
          }
          const parsed = ops[op].result.safeParse(reply.result);
          if (!parsed.success) return fail(new AgentError("internal", `agent reply for ${op} did not match the protocol`));
          settled = true;
          socket.setTimeout(0); // a slow reader pauses the socket; that is not the agent going quiet
          body = new PassThrough();
          const rest = buf.subarray(i + 1);
          if (rest.length > 0) body.write(rest);
          socket.pipe(body);
          body.on("close", () => socket.destroy());
          resolve({ result: parsed.data as OpResult<typeof op>, body });
        };
        socket.on("data", onData);
        socket.write(JSON.stringify({ id, op, args }) + "\n");
      });
    },
    openConsole(args, opts) {
      const id = `${process.pid}-${++counter}`;
      return new Promise((resolve, reject) => {
        const { socket, where } = open(t);
        let settled = false;
        let buf: Buffer = Buffer.alloc(0);
        const frameCbs: ((f: Frame) => void)[] = [];
        const closeCbs: (() => void)[] = [];
        const fail = (e: AgentError) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(e);
        };
        const timer = setTimeout(() => fail(new AgentError("timeout", "agent did not open the console in time")), opts?.timeoutMs ?? 30_000);
        socket.once("error", (e: NodeJS.ErrnoException) => fail(new AgentError("unavailable", `cannot reach agent at ${where}: ${e.code ?? e.message}`)));
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const i = buf.indexOf(0x0a);
          if (i === -1) {
            if (buf.length > MAX_LINE_BYTES) fail(new AgentError("internal", `agent reply exceeded ${MAX_LINE_BYTES} bytes`));
            return;
          }
          socket.off("data", onData);
          clearTimeout(timer);
          let reply: Reply;
          try {
            reply = JSON.parse(buf.subarray(0, i).toString("utf8")) as Reply;
          } catch {
            return fail(new AgentError("internal", "agent sent invalid JSON"));
          }
          if (!reply.ok) return fail(new AgentError(reply.error.code, reply.error.message, reply.error));
          const parsed = ops["console.open"].result.safeParse(reply.result);
          if (!parsed.success) return fail(new AgentError("internal", "agent reply for console.open did not match the protocol"));
          settled = true;
          const decoder = new FrameDecoder();
          const feed = (chunk: Buffer) => {
            try {
              for (const f of decoder.push(chunk)) for (const cb of frameCbs) cb(f);
            } catch {
              socket.destroy();
            }
          };
          socket.on("data", feed);
          socket.once("close", () => closeCbs.forEach((cb) => cb()));
          socket.on("error", () => {});
          const rest = buf.subarray(i + 1);
          resolve({
            result: parsed.data,
            write: (data) => void (socket.destroyed || socket.write(encodeFrame(FRAME.data, data))),
            resize: (cols, rows) => void (socket.destroyed || socket.write(resizeFrame(cols, rows))),
            onFrame: (cb) => {
              frameCbs.push(cb);
            },
            onClose: (cb) => {
              if (socket.destroyed) queueMicrotask(cb);
              else closeCbs.push(cb);
            },
            close: () => socket.destroy(),
          });
          if (rest.length > 0) queueMicrotask(() => feed(rest));
        };
        socket.on("data", onData);
        socket.write(JSON.stringify({ id, op: "console.open", args }) + "\n");
      });
    },
    async putArtifact(id, filePath, opts) {
      const [info, sha256] = await Promise.all([
        stat(filePath),
        new Promise<string>((resolve, reject) => {
          const h = createHash("sha256");
          createReadStream(filePath).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
        }),
      ]);
      const raw = await exchange("artifact.put", { id, size: info.size, sha256 }, opts?.timeoutMs ?? defaults.timeoutMs ?? 20 * 60_000, (socket) => {
        createReadStream(filePath).on("error", () => socket.destroy()).pipe(socket, { end: false });
      });
      const parsed = ops["artifact.put"].result.safeParse(raw);
      if (!parsed.success) throw new AgentError("internal", "agent reply for artifact.put did not match the protocol");
      return parsed.data;
    },
  };
}
