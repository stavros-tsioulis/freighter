import type { Duplex, Writable } from "node:stream";
import { MAX_LINE_BYTES } from "./schemas.ts";

/**
 * Reads newline-delimited JSON lines from a socket and can switch, on demand, to consuming an exact number of raw
 * bytes (used by `artifact.put`). `onLine` runs synchronously, so a handler can call `readRaw` before the next byte
 * is interpreted.
 */
export class LineReader {
  private buf: Buffer = Buffer.alloc(0);
  private dead = false;
  private raw: { remaining: number; dest: Writable; done: () => void; fail: (e: Error) => void } | null = null;

  constructor(
    private readonly socket: Duplex,
    private readonly onLine: (line: string, reader: LineReader) => void,
    private readonly onOverflow: () => void,
  ) {
    socket.on("data", (chunk: Buffer) => {
      if (this.dead) return;
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on("close", () => this.raw?.fail(new Error("connection closed during upload")));
  }

  /** Consume the next `size` bytes (starting with anything already buffered) into `dest`. */
  readRaw(size: number, dest: Writable): Promise<void> {
    return new Promise((done, fail) => {
      this.raw = { remaining: size, dest, done, fail };
      queueMicrotask(() => this.drain());
    });
  }

  private drain(): void {
    for (;;) {
      if (this.raw) {
        const take = Math.min(this.raw.remaining, this.buf.length);
        if (take > 0) {
          const part = this.buf.subarray(0, take);
          this.buf = this.buf.subarray(take);
          this.raw.remaining -= take;
          if (!this.raw.dest.write(part)) {
            this.socket.pause();
            this.raw.dest.once("drain", () => this.socket.resume());
          }
        }
        if (this.raw.remaining > 0) return;
        const { done } = this.raw;
        this.raw = null;
        done();
        continue;
      }
      const i = this.buf.indexOf(0x0a);
      if (i === -1) {
        if (this.buf.length > MAX_LINE_BYTES) {
          this.dead = true;
          this.onOverflow();
        }
        return;
      }
      if (i > MAX_LINE_BYTES) {
        this.dead = true;
        this.onOverflow();
        return;
      }
      const line = this.buf.subarray(0, i).toString("utf8");
      this.buf = this.buf.subarray(i + 1);
      if (line.trim() !== "") this.onLine(line, this);
    }
  }
}

/** Back-compat helper for line-only consumers. */
export function readLines(socket: Duplex, onLine: (line: string) => void, onOverflow: () => void): LineReader {
  return new LineReader(socket, (line) => onLine(line), onOverflow);
}
