/**
 * The byte stream of a console session (`console.open`), after the reply line. Both directions, and the pipe to the
 * PTY helper on the agent, speak the same frames: `[type: u8][length: u32 big-endian][payload]`.
 */
export const FRAME = {
  /** Terminal bytes: keystrokes towards the shell, output from it. */
  data: 0,
  /** Towards the shell: the terminal's new size, `[cols: u16][rows: u16]`. */
  resize: 1,
  /** From the shell, last: its exit code (`i32`; 128 + n when a signal ended it). */
  exit: 2,
  /** From the agent: why the session could not start or had to end, as UTF-8. */
  error: 3,
} as const;

export const MAX_FRAME_BYTES = 1_048_576;

export interface Frame {
  type: number;
  payload: Buffer;
}

export function encodeFrame(type: number, payload: Uint8Array | string = new Uint8Array()): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

export const resizeFrame = (cols: number, rows: number): Buffer => {
  const p = Buffer.alloc(4);
  p.writeUInt16BE(Math.max(1, Math.min(cols, 1000)), 0);
  p.writeUInt16BE(Math.max(1, Math.min(rows, 1000)), 2);
  return encodeFrame(FRAME.resize, p);
};

export const exitFrame = (code: number): Buffer => {
  const p = Buffer.alloc(4);
  p.writeInt32BE(code, 0);
  return encodeFrame(FRAME.exit, p);
};

export const parseResize = (payload: Buffer): { cols: number; rows: number } | null => (payload.length === 4 ? { cols: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) } : null);
export const parseExit = (payload: Buffer): number => (payload.length === 4 ? payload.readInt32BE(0) : -1);

/** Cuts a byte stream into frames. Throws on a frame that is larger than anything legitimate. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 5) return out;
      const length = this.buf.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`console frame of ${length} bytes`);
      if (this.buf.length < 5 + length) return out;
      out.push({ type: this.buf.readUInt8(0), payload: Buffer.from(this.buf.subarray(5, 5 + length)) });
      this.buf = this.buf.subarray(5 + length);
    }
  }
}
