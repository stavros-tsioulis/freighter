import { createConsoleBridge, sameOrigin, WIRE, type WirePeer } from "@freighter/api";
import { proxyConsole } from "../utils/console-proxy";

// The console's WebSocket: a browser's terminal, or the CLI's `exec` and `shell`, on one side and the agent's shell or
// command on the other. Authentication, the admin check, the same-origin check and the audit log are in @freighter/api
// (see console.ts and console-wire.ts); this only hands connections to it. The messages are binary: a byte for what
// it is, then its content (see WIRE, and app/utils/console.ts for the browser's half).

/** Connections to another Freighter's console, for a dashboard that uses its API (`FREIGHTER_API_URL`). */
const relays = new Map<string, ReturnType<typeof proxyConsole>>();
let bridge: ReturnType<typeof createConsoleBridge> | undefined;

const text = (type: number, message: string) => {
  const body = new TextEncoder().encode(message);
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
};

export default defineWebSocketHandler({
  async open(peer) {
    const refuse = (message: string) => {
      peer.send(text(WIRE.error, message));
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
      bridge ??= createConsoleBridge(ctx);
      await bridge.open(peer as unknown as WirePeer);
    } catch {
      refuse("could not open the console");
    }
  },

  message(peer, message) {
    const relay = relays.get(peer.id);
    if (relay) return relay.message(message.uint8Array());
    bridge?.message(peer as unknown as WirePeer, message.uint8Array());
  },

  close(peer) {
    relays.get(peer.id)?.close();
    relays.delete(peer.id);
    bridge?.close(peer as unknown as WirePeer);
  },

  error(peer) {
    relays.get(peer.id)?.close();
    relays.delete(peer.id);
    bridge?.close(peer as unknown as WirePeer);
  },
});
