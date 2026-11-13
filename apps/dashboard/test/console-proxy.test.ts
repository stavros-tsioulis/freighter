import { describe, expect, it } from "vitest";
import { proxyConsole, upstreamUrl, type UpstreamSocket } from "../server/utils/console-proxy";
import { MSG, parseServerMessage } from "../app/utils/console";

function fake() {
  const made: { url: string; headers: Record<string, string> }[] = [];
  let sock!: UpstreamSocket & { sent: Uint8Array[]; closedWith?: [number | undefined, string | undefined]; open(): void; recv(b: Uint8Array): void; end(code: number, reason: string): void; fail(): void };
  const make = (url: string, headers: Record<string, string>) => {
    made.push({ url, headers });
    sock = {
      binaryType: "blob",
      readyState: 0,
      sent: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(d: Uint8Array) {
        sock.sent.push(d);
      },
      close(code?: number, reason?: string) {
        sock.closedWith = [code, reason];
      },
      open() {
        sock.readyState = 1;
        sock.onopen?.();
      },
      recv(b: Uint8Array) {
        sock.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      },
      end(code: number, reason: string) {
        sock.onclose?.({ code, reason });
      },
      fail() {
        sock.onerror?.();
      },
    };
    return sock;
  };
  return { make, made, sock: () => sock };
}

const peerOf = (headers: Record<string, string> = {}, url = "/_console?app=shop&service=web&cols=100&rows=30") => {
  const out = { sent: [] as Uint8Array[], closed: null as [number, string] | null };
  return { out, peer: { url, header: (n: string) => headers[n.toLowerCase()], send: (d: Uint8Array) => void out.sent.push(d), close: (c: number, r: string) => void (out.closed = [c, r]) } };
};

describe("the console of another Freighter", () => {
  it("builds the other Freighter's WebSocket address, with the same query", () => {
    expect(upstreamUrl("https://freighter.example.com", "/_console?app=shop&service=web&cols=100&rows=30")).toBe("wss://freighter.example.com/_console?app=shop&service=web&cols=100&rows=30");
    expect(upstreamUrl("http://localhost:4000", "/_console?app=a&service=b")).toBe("ws://localhost:4000/_console?app=a&service=b");
  });

  it("carries the session and names the other Freighter as the page, and relays bytes both ways", () => {
    const f = fake();
    const { peer, out } = peerOf({ cookie: "fr_session=fr_abc", "x-forwarded-for": "198.51.100.9, 10.0.0.1", host: "localhost:3000", origin: "http://localhost:3000" });
    const proxy = proxyConsole(peer, "https://freighter.example.com", f.make);
    expect(f.made[0]).toEqual({
      url: "wss://freighter.example.com/_console?app=shop&service=web&cols=100&rows=30",
      headers: { origin: "https://freighter.example.com", cookie: "fr_session=fr_abc", "x-forwarded-for": "198.51.100.9" }, // not the browser's own origin or host
    });
    expect(f.sock().binaryType).toBe("arraybuffer");

    proxy.message(new Uint8Array([MSG.data, 108, 115, 10])); // typed before the connection is up: held
    expect(f.sock().sent).toHaveLength(0);
    f.sock().open();
    expect(f.sock().sent.map((m) => [...m])).toEqual([[MSG.data, 108, 115, 10]]);
    proxy.message(new Uint8Array([MSG.resize, 0, 90, 0, 20]));
    expect(f.sock().sent).toHaveLength(2);

    f.sock().recv(new Uint8Array([MSG.data, 104, 105]));
    expect(out.sent.map((m) => [...m])).toEqual([[MSG.data, 104, 105]]);
  });

  it("passes on a token, and ends both sides together", () => {
    const f = fake();
    const { peer, out } = peerOf({ authorization: "Bearer fr_abc" });
    const proxy = proxyConsole(peer, "https://freighter.example.com", f.make);
    expect(f.made[0]!.headers.authorization).toBe("Bearer fr_abc");
    f.sock().open();
    f.sock().end(1008, "refused"); // the other side's refusal reaches the browser as it is
    expect(out.closed).toEqual([1008, "refused"]);
    proxy.close(); // the browser leaving closes the other side
    expect(f.sock().closedWith).toEqual([1000, "closed"]);

    const g = fake();
    const b = peerOf();
    proxyConsole(b.peer, "https://freighter.example.com", g.make);
    g.sock().end(1006, ""); // no code: a plain closing
    expect(b.out.closed).toEqual([1000, "closed"]);
  });

  it("says when the other Freighter cannot be reached", () => {
    const f = fake();
    const { peer, out } = peerOf();
    proxyConsole(peer, "https://freighter.example.com", f.make);
    f.sock().fail();
    const msg = parseServerMessage(out.sent[0]!);
    expect(msg).toEqual({ type: "error", message: "cannot reach https://freighter.example.com" });
    expect(out.closed?.[0]).toBe(1011);

    const h = peerOf();
    proxyConsole(h.peer, "https://freighter.example.com", () => {
      throw new Error("bad address");
    });
    expect(parseServerMessage(h.out.sent[0]!)).toMatchObject({ type: "error", message: expect.stringMatching(/bad address/) });
  });
});
