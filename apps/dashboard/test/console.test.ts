import { describe, expect, it } from "vitest";
import { MSG, consoleUrl, dataMessage, exitMessage, exitText, parseServerMessage, pingMessage, resizeMessage, textMessage } from "../app/utils/console";

describe("console messages", () => {
  it("reads what the server sends", () => {
    expect(parseServerMessage(dataMessage(new TextEncoder().encode("hi")))).toEqual({ type: "data", bytes: new TextEncoder().encode("hi") });
    expect(parseServerMessage(exitMessage(130))).toEqual({ type: "exit", code: 130 });
    expect(parseServerMessage(exitMessage(-1))).toEqual({ type: "exit", code: -1 });
    expect(parseServerMessage(textMessage(MSG.error, "closed after 30 minutes without input"))).toEqual({ type: "error", message: "closed after 30 minutes without input" });
    const info = { kind: "host", user: "shop", cwd: "/srv/apps/shop/shared", shell: "bash or sh" };
    expect(parseServerMessage(textMessage(MSG.ready, JSON.stringify(info)))).toEqual({ type: "ready", info });
    expect(parseServerMessage(textMessage(MSG.ready, "{not json"))).toEqual({ type: "unknown" });
    expect(parseServerMessage(new Uint8Array([99, 1, 2]))).toEqual({ type: "unknown" });
  });

  it("writes what the server expects, with a terminal size it can trust", () => {
    expect([...resizeMessage(120, 40)]).toEqual([MSG.resize, 0, 120, 0, 40]);
    expect([...resizeMessage(0, 99999)]).toEqual([MSG.resize, 0, 1, 3, 232]); // 1 column, at most 1000 rows
    expect([...pingMessage()]).toEqual([MSG.ping]);
    expect([...dataMessage(new Uint8Array([3]))]).toEqual([MSG.data, 3]); // Ctrl+C is just a byte
  });

  it("opens the socket on the page's own origin, wss when the page is https", () => {
    expect(consoleUrl({ protocol: "https:", host: "freighter.example.com" }, "shop", "web", { cols: 100, rows: 30 })).toBe("wss://freighter.example.com/_console?app=shop&service=web&cols=100&rows=30");
    expect(consoleUrl({ protocol: "http:", host: "localhost:3000" }, "shop", "web", { cols: 80, rows: 24 })).toMatch(/^ws:\/\/localhost:3000\/_console\?/);
  });

  it("says how a shell ended", () => {
    expect(exitText(0)).toBe("The shell exited.");
    expect(exitText(137)).toBe("The shell was ended by a signal (9).");
    expect(exitText(2)).toBe("The shell exited with code 2.");
  });
});
