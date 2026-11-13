/**
 * What the browser and the dashboard's server say to each other over the console's WebSocket. Every message is binary:
 * one byte for what it is, then its content.
 */
export const MSG = {
  /** Both ways: terminal bytes. Keystrokes going in, output coming out. */
  data: 0,
  /** Browser to server: the terminal's size, `[cols: u16][rows: u16]`. */
  resize: 1,
  /** Server to browser: the shell ended; its exit code as an `i32`. */
  exit: 2,
  /** Server to browser: something to read (a refusal, an idle timeout), as UTF-8. */
  error: 3,
  /** Server to browser: the shell is open; `{ kind, user, cwd, shell }` as JSON. */
  ready: 4,
  /** Browser to server: still here. Keeps the connection from being dropped as idle; the shell does not see it. */
  ping: 5,
} as const;

export interface ConsoleInfo {
  kind: "host" | "container";
  user: string;
  cwd: string;
  shell: string;
}

export type ServerMessage =
  | { type: "data"; bytes: Uint8Array }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "ready"; info: ConsoleInfo }
  | { type: "unknown" };

const message = (type: number, payload: Uint8Array = new Uint8Array()) => {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
};

export const dataMessage = (bytes: Uint8Array) => message(MSG.data, bytes);
export const textMessage = (type: number, text: string) => message(type, new TextEncoder().encode(text));
export const pingMessage = () => message(MSG.ping);
export function resizeMessage(cols: number, rows: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint16(0, Math.max(1, Math.min(Math.round(cols), 1000)));
  view.setUint16(2, Math.max(1, Math.min(Math.round(rows), 1000)));
  return message(MSG.resize, new Uint8Array(view.buffer));
}
export function exitMessage(code: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setInt32(0, code);
  return message(MSG.exit, new Uint8Array(view.buffer));
}

export function parseServerMessage(raw: Uint8Array): ServerMessage {
  const body = raw.subarray(1);
  switch (raw[0]) {
    case MSG.data:
      return { type: "data", bytes: body };
    case MSG.exit:
      return body.length === 4 ? { type: "exit", code: new DataView(body.buffer, body.byteOffset, 4).getInt32(0) } : { type: "unknown" };
    case MSG.error:
      return { type: "error", message: new TextDecoder().decode(body) };
    case MSG.ready:
      try {
        return { type: "ready", info: JSON.parse(new TextDecoder().decode(body)) as ConsoleInfo };
      } catch {
        return { type: "unknown" };
      }
    default:
      return { type: "unknown" };
  }
}

/** The WebSocket address of the console of a service, on the page's own origin. */
export function consoleUrl(origin: { protocol: string; host: string }, app: string, service: string, size: { cols: number; rows: number }): string {
  const scheme = origin.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ app, service, cols: String(size.cols), rows: String(size.rows) });
  return `${scheme}://${origin.host}/_console?${q}`;
}

/** What to tell the person about how a session ended. */
export function exitText(code: number): string {
  if (code === 0) return "The shell exited.";
  if (code > 128 && code < 160) return `The shell was ended by a signal (${code - 128}).`;
  return `The shell exited with code ${code}.`;
}
