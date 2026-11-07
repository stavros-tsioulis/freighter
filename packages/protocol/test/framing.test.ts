import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LineReader, MAX_LINE_BYTES } from "../src/index.ts";

function collector() {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  return { sink, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("LineReader", () => {
  it.each([1, 3, 7, 1000])("splits lines and raw bytes identically with %d-byte chunks", async (chunkSize) => {
    const socket = new PassThrough();
    const lines: string[] = [];
    const raw = collector();
    let rawDone: Promise<void> | undefined;
    new LineReader(socket, (line, reader) => {
      lines.push(line);
      if (line === '{"op":"put"}') rawDone = reader.readRaw(11, raw.sink); // bytes follow immediately
    }, () => { throw new Error("overflow"); });

    const wire = Buffer.concat([Buffer.from('{"op":"ping"}\n{"op":"put"}\n'), Buffer.from("raw\nbytes\n\0"), Buffer.from('{"op":"after"}\n')]);
    for (let i = 0; i < wire.length; i += chunkSize) socket.write(wire.subarray(i, i + chunkSize));
    await new Promise((r) => setTimeout(r, 20));
    await rawDone;

    expect(lines).toEqual(['{"op":"ping"}', '{"op":"put"}', '{"op":"after"}']);
    expect(raw.text()).toBe("raw\nbytes\n\0"); // raw data may itself contain newlines
  });

  it("reports an overlong line", async () => {
    const socket = new PassThrough();
    let overflow = 0;
    new LineReader(socket, () => {}, () => overflow++);
    socket.write(Buffer.alloc(MAX_LINE_BYTES + 10, 0x61));
    await new Promise((r) => setTimeout(r, 10));
    expect(overflow).toBe(1);
  });

  it("fails a pending raw read when the connection closes", async () => {
    const socket = new PassThrough();
    const reader = new LineReader(socket, () => {}, () => {});
    const p = reader.readRaw(100, collector().sink);
    socket.write(Buffer.from("short"));
    socket.destroy();
    await expect(p).rejects.toThrow(/closed during upload/);
  });
});
