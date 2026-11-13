import { MSG, textMessage } from "../../app/utils/console";

/** What the proxy needs of the browser's side of the connection. */
export interface ProxyPeer {
  /** The request line of the upgrade (`/_console?app=...`). */
  url: string;
  header(name: string): string | null | undefined;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** The part of a WebSocket the proxy uses (so a test can stand in for the real one). */
export interface UpstreamSocket {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type MakeSocket = (url: string, headers: Record<string, string>) => UpstreamSocket;

export const realSocket: MakeSocket = (url, headers) => new (WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => UpstreamSocket)(url, { headers });

const OPEN = 1;
const MAX_QUEUED = 1_048_576;

/** The console's WebSocket address on another Freighter, with the query of the one the browser opened. */
export function upstreamUrl(origin: string, peerUrl: string): string {
  const u = new URL(origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/_console";
  u.search = new URL(peerUrl, "http://x").search;
  return u.toString();
}

/**
 * The console for a dashboard that uses another Freighter's API (`FREIGHTER_API_URL`): its WebSocket is relayed to the
 * other Freighter's own, byte for byte, as the messages are the same on both. Who may open a console, the same-origin
 * check and the audit log are all there, so this carries the session cookie (or token) and names the other Freighter as
 * the page the console is opened from, as its dashboard would.
 */
export function proxyConsole(peer: ProxyPeer, origin: string, make: MakeSocket = realSocket) {
  const headers: Record<string, string> = { origin };
  for (const name of ["cookie", "authorization"]) {
    const v = peer.header(name);
    if (v) headers[name] = v;
  }
  const forwarded = peer.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) headers["x-forwarded-for"] = forwarded;

  const fail = (message: string) => {
    peer.send(textMessage(MSG.error, message));
    peer.close(1011, "upstream");
  };
  let upstream: UpstreamSocket;
  try {
    upstream = make(upstreamUrl(origin, peer.url), headers);
  } catch (e) {
    fail(`cannot reach ${origin}: ${e instanceof Error ? e.message : String(e)}`);
    return { message() {}, close() {} };
  }
  upstream.binaryType = "arraybuffer";

  let queued: Uint8Array[] = [];
  let queuedBytes = 0;
  let done = false;
  upstream.onopen = () => {
    for (const m of queued) upstream.send(m);
    queued = [];
  };
  upstream.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) peer.send(new Uint8Array(e.data));
  };
  upstream.onclose = (e) => {
    if (done) return;
    done = true;
    // 1005 and 1006 mean "no code": a clean ending is the closest thing to say
    peer.close(e.code >= 1000 && e.code < 5000 && e.code !== 1005 && e.code !== 1006 ? e.code : 1000, e.reason || "closed");
  };
  upstream.onerror = () => {
    if (done) return;
    done = true;
    fail(`cannot reach ${origin}`);
  };

  return {
    message(bytes: Uint8Array) {
      if (upstream.readyState === OPEN) return upstream.send(bytes);
      if (queuedBytes + bytes.length > MAX_QUEUED) return;
      queued.push(bytes);
      queuedBytes += bytes.length;
    },
    close() {
      done = true;
      try {
        upstream.close(1000, "closed");
      } catch {
        /* already gone */
      }
    },
  };
}
