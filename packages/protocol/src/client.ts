import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { LineReader } from "./framing.ts";
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

export type AgentTarget =
  | { kind: "unix"; path: string }
  | { kind: "tls"; host: string; port: number; ca: string; cert: string; key: string; pinnedFingerprint?: string };

export interface AgentClient {
  call<N extends OpName>(op: N, args: OpArgs<N>, opts?: { timeoutMs?: number }): Promise<OpResult<N>>;
  /** Upload a file into the agent's artifact spool as `<id>.tar.gz`; resolves with its path on the agent host. */
  putArtifact(id: string, filePath: string, opts?: { timeoutMs?: number }): Promise<{ path: string }>;
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
