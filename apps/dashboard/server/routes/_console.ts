import { ApiError, openConsole, sameOrigin, type ConsoleHandle } from "@freighter/api";
import { proxyConsole } from "../utils/console-proxy";

// The console's WebSocket: the browser's terminal on one side, the agent's shell on the other. Authentication, the
// admin check, the same-origin check and the audit log are in @freighter/api; this only moves bytes. The messages are
// binary: a byte for what it is, then its content (see app/utils/console.ts).
const DATA = 0;
const RESIZE = 1;
const EXIT = 2;
const ERROR = 3;
const READY = 4;

const frame = (type: number, payload: Uint8Array | string = new Uint8Array()) => {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};

/** Sessions by connection; a connection that is not here has none open (yet, or any more). */
const sessions = new Map<string, ConsoleHandle>();
/** The same, for a dashboard that uses another Freighter's API: its console is relayed there. */
const relays = new Map<string, ReturnType<typeof proxyConsole>>();

function end(id: string) {
  sessions.get(id)?.close();
  sessions.delete(id);
  relays.get(id)?.close();
  relays.delete(id);
}

export default defineWebSocketHandler({
  async open(peer) {
    const refuse = (message: string) => {
      peer.send(frame(ERROR, message));
      peer.close(1008, "refused");
    };
    try {
      const remote = remoteApiUrl();
      if (remote) {
        const headers = peer.request.headers;
        // The other Freighter sees this server as the page, so the check that the browser's page is this dashboard has to be made here.
        if (!/^Bearer fr_/.test(headers.get("authorization") ?? "") && !sameOrigin({ header: (n) => headers.get(n) }, true)) return refuse("the console must be opened from the dashboard itself");
        relays.set(peer.id, proxyConsole({ url: peer.request.url, header: (n) => headers.get(n), send: (d) => peer.send(d), close: (c, r) => peer.close(c, r) }, remote));
        return;
      }
      const { ctx } = await useFreighter();
      const headers = peer.request.headers;
      const handle = await openConsole(
        ctx,
        { url: peer.request.url, header: (n) => headers.get(n), ip: headers.get("x-forwarded-for")?.split(",")[0]?.trim() },
        {
          data: (chunk) => peer.send(frame(DATA, chunk)),
          exit: (code) => {
            const p = new Uint8Array(4);
            new DataView(p.buffer).setInt32(0, code);
            peer.send(frame(EXIT, p));
          },
          error: (message) => peer.send(frame(ERROR, message)),
          closed: () => {
            sessions.delete(peer.id);
            peer.close(1000, "closed");
          },
        },
      );
      sessions.set(peer.id, handle);
      peer.send(frame(READY, JSON.stringify(handle.info)));
    } catch (e) {
      refuse(e instanceof ApiError ? e.message : "could not open the console");
    }
  },

  message(peer, message) {
    const relay = relays.get(peer.id);
    if (relay) return relay.message(message.uint8Array());
    const handle = sessions.get(peer.id);
    if (!handle) return;
    const bytes = message.uint8Array();
    const body = bytes.subarray(1);
    if (bytes[0] === DATA) handle.write(body);
    else if (bytes[0] === RESIZE && body.length === 4) {
      const view = new DataView(body.buffer, body.byteOffset, 4);
      handle.resize(view.getUint16(0), view.getUint16(2));
    }
  },

  close(peer) {
    end(peer.id);
  },

  error(peer) {
    end(peer.id);
  },
});
