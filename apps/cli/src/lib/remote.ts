import { CliError, EXIT } from "./errors.ts";

/** The console's WebSocket messages (see `WIRE` in @freighter/api): a byte for what it is, then its content. */
const MSG = { data: 0, resize: 1, exit: 2, error: 3, ready: 4, ping: 5, eof: 6, stderr: 7 } as const;

export interface RemoteOptions {
  url: string;
  token: string;
  app: string;
  service: string;
  /** A command to run; none means an interactive shell. */
  command?: string[];
  tty: boolean;
  /** Pass this process's standard input to it. */
  stdin: boolean;
  env?: Record<string, string>;
  /** Where its output goes (standard output and error, unless a test says otherwise). */
  out?: { write(b: Uint8Array): unknown };
  err?: { write(b: Uint8Array): unknown };
  /** The terminal, when `tty`. */
  terminal?: { cols: number; rows: number; raw(on: boolean): void; onResize(cb: (cols: number, rows: number) => void): () => void };
  input?: NodeJS.ReadableStream;
}

/** The WebSocket address of a service's console on a Freighter. */
export function consoleAddress(o: Pick<RemoteOptions, "url" | "app" | "service" | "command" | "tty" | "env">, size = { cols: 80, rows: 24 }): string {
  const u = new URL(o.url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/_console";
  const q = new URLSearchParams({ app: o.app, service: o.service, cols: String(size.cols), rows: String(size.rows), tty: o.tty ? "1" : "0" });
  if (o.command) q.set("cmd", JSON.stringify(o.command));
  if (o.env && Object.keys(o.env).length) q.set("env", JSON.stringify(o.env));
  u.search = q.toString();
  return u.toString();
}

const size = (cols: number, rows: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint16(0, cols);
  view.setUint16(2, rows);
  return new Uint8Array([MSG.resize, ...new Uint8Array(view.buffer)]);
};

/**
 * Run a command (or a shell) in a service, over the console's WebSocket, and resolve with its exit code. A refusal or a
 * dropped connection is an error. With `tty` the local terminal is put in raw mode, so every key goes to the far end.
 */
export function runRemote(o: RemoteOptions): Promise<number> {
  const out = o.out ?? process.stdout;
  const err = o.err ?? process.stderr;
  return new Promise((resolve, reject) => {
    const term = o.terminal;
    const ws = new WebSocket(consoleAddress(o, term ? { cols: term.cols, rows: term.rows } : undefined), { headers: { authorization: `Bearer ${o.token}` } } as never);
    ws.binaryType = "arraybuffer";
    let code: number | undefined;
    let reason = "";
    let stopResize: (() => void) | undefined;
    let pinger: ReturnType<typeof setInterval> | undefined;
    const send = (b: Uint8Array) => ws.readyState === WebSocket.OPEN && ws.send(b);
    const cleanup = () => {
      clearInterval(pinger);
      stopResize?.();
      term?.raw(false);
      input?.removeListener("data", onInput);
      input?.removeListener("end", onEnd);
    };
    const input = o.stdin || o.tty ? (o.input ?? process.stdin) : undefined;
    const onInput = (chunk: Buffer | string) => send(new Uint8Array([MSG.data, ...Buffer.from(chunk)]));
    const onEnd = () => send(new Uint8Array([MSG.eof]));

    ws.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer);
      const body = b.subarray(1);
      switch (b[0]) {
        case MSG.ready:
          pinger = setInterval(() => send(new Uint8Array([MSG.ping])), 15_000);
          if (term) {
            term.raw(true);
            stopResize = term.onResize((c, r) => send(size(c, r)));
          }
          if (input) {
            input.on("data", onInput);
            if (!o.tty) input.on("end", onEnd);
            (input as { resume?: () => void }).resume?.();
          } else send(new Uint8Array([MSG.eof])); // nothing to send: the command's input ends at once
          break;
        case MSG.data:
          out.write(body);
          break;
        case MSG.stderr:
          err.write(body);
          break;
        case MSG.error:
          reason = new TextDecoder().decode(body);
          break;
        case MSG.exit:
          if (body.length === 4) code = new DataView(body.buffer, body.byteOffset, 4).getInt32(0);
          break;
      }
    };
    ws.onclose = () => {
      cleanup();
      if (code !== undefined) return resolve(code);
      reject(new CliError(reason || "the connection closed before the command ended", EXIT.failed));
    };
    ws.onerror = () => {
      cleanup();
      reject(new CliError(`cannot reach ${o.url}`, EXIT.failed, "check the URL, and your network; the console needs a WebSocket"));
    };
  });
}
