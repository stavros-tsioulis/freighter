import type { ApiContext } from "./context.ts";
import { ApiError } from "./errors.ts";
import { openConsole, type ConsoleHandle } from "./console.ts";

/**
 * What a browser or the CLI says over the console's WebSocket. Every message is binary: a byte for what it is, then its
 * content. The two directions have their own numbers.
 */
export const WIRE = {
  /** Both ways: terminal bytes (a command's standard output, without a terminal). */
  data: 0,
  /** To the server: `[cols: u16][rows: u16]`. */
  resize: 1,
  /** To the client: the shell ended; its exit code as an `i32`. */
  exit: 2,
  /** To the client: a reason, as UTF-8 (a refusal, an idle timeout). */
  error: 3,
  /** To the client: the session is open; `{ kind, user, cwd, shell }` as JSON. */
  ready: 4,
  /** To the server: still here. Not passed on. */
  ping: 5,
  /** To the server: no more input will come. */
  eof: 6,
  /** To the client: what a command wrote to standard error. */
  stderr: 7,
} as const;

/** The part of a WebSocket connection the bridge needs. The dashboard's server and the tests each adapt their own to it. */
export interface WirePeer {
  id: string;
  request: { url: string; headers: { get(name: string): string | null } };
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

const frame = (type: number, payload: Uint8Array | string = new Uint8Array()) => {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};

/** Connects WebSocket peers to console sessions, with everything `openConsole` checks. One per server. */
export function createConsoleBridge(ctx: ApiContext) {
  const sessions = new Map<string, ConsoleHandle>();
  return {
    async open(peer: WirePeer): Promise<void> {
      const refuse = (message: string) => {
        peer.send(frame(WIRE.error, message));
        peer.close(1008, "refused");
      };
      try {
        const headers = peer.request.headers;
        const handle = await openConsole(
          ctx,
          { url: peer.request.url, header: (n) => headers.get(n), ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim() },
          {
            data: (chunk) => peer.send(frame(WIRE.data, chunk)),
            stderr: (chunk) => peer.send(frame(WIRE.stderr, chunk)),
            exit: (code) => {
              const p = new Uint8Array(4);
              new DataView(p.buffer).setInt32(0, code);
              peer.send(frame(WIRE.exit, p));
            },
            error: (message) => peer.send(frame(WIRE.error, message)),
            closed: () => {
              sessions.delete(peer.id);
              peer.close(1000, "closed");
            },
          },
        );
        sessions.set(peer.id, handle);
        peer.send(frame(WIRE.ready, JSON.stringify(handle.info)));
      } catch (e) {
        refuse(e instanceof ApiError ? e.message : "could not open the console");
      }
    },
    message(peer: WirePeer, bytes: Uint8Array): void {
      const handle = sessions.get(peer.id);
      if (!handle) return;
      const body = bytes.subarray(1);
      if (bytes[0] === WIRE.data) handle.write(body);
      else if (bytes[0] === WIRE.resize && body.length === 4) {
        const view = new DataView(body.buffer, body.byteOffset, 4);
        handle.resize(view.getUint16(0), view.getUint16(2));
      } else if (bytes[0] === WIRE.eof) handle.end();
    },
    close(peer: WirePeer): void {
      sessions.get(peer.id)?.close();
      sessions.delete(peer.id);
    },
  };
}
