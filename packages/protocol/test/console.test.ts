import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FRAME, FrameDecoder, LineReader, createAgentClient, encodeFrame, exitFrame, parseExit, parseResize, resizeFrame, ops, type Frame } from "../src/index.ts";

describe("console frames", () => {
  it("round-trips frames and cuts a stream anywhere", () => {
    const bytes = Buffer.concat([encodeFrame(FRAME.data, "héllo"), resizeFrame(120, 40), exitFrame(130)]);
    const d = new FrameDecoder();
    const got: Frame[] = [];
    for (let i = 0; i < bytes.length; i += 3) got.push(...d.push(bytes.subarray(i, i + 3))); // three bytes at a time
    expect(got.map((f) => f.type)).toEqual([FRAME.data, FRAME.resize, FRAME.exit]);
    expect(got[0]!.payload.toString("utf8")).toBe("héllo");
    expect(parseResize(got[1]!.payload)).toEqual({ cols: 120, rows: 40 });
    expect(parseExit(got[2]!.payload)).toBe(130);
  });

  it("refuses a frame that is far too large, and keeps a terminal size sane", () => {
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(50_000_000, 1);
    expect(() => new FrameDecoder().push(huge)).toThrow(/console frame/);
    expect(parseResize(resizeFrame(99999, 0).subarray(5))).toEqual({ cols: 1000, rows: 1 });
  });

  it("checks what console.open is asked", () => {
    expect(ops["console.open"].args.parse({ app: "shop", service: "web" })).toEqual({ app: "shop", service: "web", cols: 80, rows: 24, tty: true });
    expect(() => ops["console.open"].args.parse({ app: "Shop", service: "web" })).toThrow();
    expect(() => ops["console.open"].args.parse({ app: "shop", service: "web", cols: 0 })).toThrow();
  });
});

describe("console.open over a socket", () => {
  it("hands the connection to frames after the reply line, in both directions", async () => {
    const dir = await mkdtemp(`${tmpdir()}/fr-console-`);
    const path = `${dir}/agent.sock`;
    const echoed: string[] = [];
    const server = createServer((socket) => {
      new LineReader(
        socket,
        (_line, reader) => {
          socket.write(JSON.stringify({ id: JSON.parse(_line).id, ok: true, result: { kind: "host", user: "shop", cwd: "/srv/apps/shop/shared", shell: "bash" } }) + "\n");
          const dec = new FrameDecoder();
          reader.takeover((chunk) => {
            for (const f of dec.push(chunk)) {
              if (f.type === FRAME.data) {
                echoed.push(f.payload.toString());
                socket.write(encodeFrame(FRAME.data, `you said ${f.payload.toString()}`));
              } else if (f.type === FRAME.resize) echoed.push(`resize ${parseResize(f.payload)!.cols}x${parseResize(f.payload)!.rows}`);
            }
          });
          // frames that arrive in the same packet as the request line are not lost: simulated by the client writing at once
        },
        () => socket.destroy(),
      );
    });
    await new Promise<void>((r) => server.listen(path, r));
    try {
      const session = await createAgentClient(path).openConsole({ app: "shop", service: "web", cols: 100, rows: 30 });
      expect(session.result).toMatchObject({ kind: "host", user: "shop" });
      const heard = new Promise<string>((resolve) => session.onFrame((f) => f.type === FRAME.data && resolve(f.payload.toString())));
      session.resize(90, 20);
      session.write("ls\n");
      expect(await heard).toBe("you said ls\n");
      expect(echoed).toEqual(["resize 90x20", "ls\n"]);
      const closed = new Promise<void>((r) => session.onClose(r));
      session.close();
      await closed;
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("reports a refusal as an error", async () => {
    const dir = await mkdtemp(`${tmpdir()}/fr-console-`);
    const path = `${dir}/agent.sock`;
    const server = createServer((socket) => new LineReader(socket, (line) => socket.write(JSON.stringify({ id: JSON.parse(line).id, ok: false, error: { code: "conflict", message: "service web is not running" } }) + "\n"), () => {}));
    await new Promise<void>((r) => server.listen(path, r));
    try {
      await expect(createAgentClient(path).openConsole({ app: "shop", service: "web" })).rejects.toThrow(/not running/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
