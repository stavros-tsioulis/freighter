import { lstat, open, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";

const nodeCrc32 = (zlib as unknown as { crc32?: (data: Buffer, value?: number) => number }).crc32;

/**
 * A streaming ZIP writer: files are read once, deflated and sent as they come, so an archive of any size needs no
 * memory or disk. Sizes are not known when an entry starts, so each entry carries a data descriptor. Entries over
 * 4 GiB, or archives with more than 65535 entries, use ZIP64. Symbolic links and special files are left out and
 * listed in `_NOT_INCLUDED.txt` inside the archive, as is anything that could not be read.
 */
const U32 = 0xffffffff;
const U16 = 0xffff;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (chunk: Buffer, prev: number): number => {
  if (nodeCrc32) return nodeCrc32(chunk, prev);
  let c = ~prev >>> 0;
  for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
};

function dos(date: Date): { time: number; date: number } {
  const y = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

interface Done {
  name: Buffer;
  offset: number;
  crc: number;
  csize: number;
  usize: number;
  mtime: Date;
  mode: number;
  dir: boolean;
  zip64: boolean;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

class Out {
  offset = 0;
  done: Done[] = [];
  emit(...parts: Buffer[]): Buffer {
    const b = Buffer.concat(parts);
    this.offset += b.length;
    return b;
  }
}

function localHeader(name: Buffer, mtime: Date, zip64: boolean, dir: boolean): Buffer {
  const t = dos(mtime);
  const extra = zip64 ? Buffer.concat([u16(1), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
  return Buffer.concat([
    u32(0x04034b50),
    u16(zip64 ? 45 : 20),
    u16(0x0800 | (dir ? 0 : 0x0008)), // UTF-8 names; sizes follow the data
    u16(dir ? 0 : 8),
    u16(t.time),
    u16(t.date),
    u32(0), u32(0), u32(0),
    u16(name.length),
    u16(extra.length),
    name,
    extra,
  ]);
}

function centralEntry(e: Done): Buffer {
  const t = dos(e.mtime);
  const big = [e.usize >= U32 || e.zip64, e.csize >= U32 || e.zip64, e.offset >= U32];
  const extraParts: Buffer[] = [];
  if (big[0]) extraParts.push(u64(e.usize));
  if (big[1]) extraParts.push(u64(e.csize));
  if (big[2]) extraParts.push(u64(e.offset));
  const extra = extraParts.length ? Buffer.concat([u16(1), u16(extraParts.length * 8), ...extraParts]) : Buffer.alloc(0);
  const attr = ((e.mode & 0xffff) << 16) >>> 0;
  return Buffer.concat([
    u32(0x02014b50),
    u16((3 << 8) | 63), // made by: Unix
    u16(extraParts.length ? 45 : e.dir ? 20 : 20),
    u16(0x0800 | (e.dir ? 0 : 0x0008)),
    u16(e.dir ? 0 : 8),
    u16(t.time),
    u16(t.date),
    u32(e.crc),
    u32(big[1] ? U32 : e.csize),
    u32(big[0] ? U32 : e.usize),
    u16(e.name.length),
    u16(extra.length),
    u16(0), u16(0), u16(0),
    u32((attr | (e.dir ? 0x10 : 0)) >>> 0),
    u32(big[2] ? U32 : e.offset),
    e.name,
    extra,
  ]);
}

function trailer(out: Out): Buffer[] {
  const parts: Buffer[] = [];
  const start = out.offset;
  const central = out.done.map(centralEntry);
  const size = central.reduce((n, b) => n + b.length, 0);
  parts.push(...central);
  const needs64 = out.done.length >= U16 || start >= U32 || size >= U32;
  if (needs64) {
    const eocd64At = start + size;
    parts.push(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(out.done.length), u64(out.done.length), u64(size), u64(start)]));
    parts.push(Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64At), u32(1)]));
  }
  parts.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(needs64 ? U16 : out.done.length), u16(needs64 ? U16 : out.done.length), u32(needs64 ? U32 : size), u32(needs64 ? U32 : start), u16(0)]));
  return parts;
}

/** The archive of `roots` (files and folders; each is stored under its own name). */
export function zipStream(roots: string[]): Readable {
  const out = new Out();
  const skipped: string[] = [];

  async function* addFile(path: string, name: string, size: number, mtime: Date, mode: number): AsyncGenerator<Buffer> {
    const handle = await open(path, "r").catch((e: NodeJS.ErrnoException) => {
      skipped.push(`${path}: ${e.code === "EACCES" || e.code === "EPERM" ? "permission denied" : (e.code ?? e.message)}`);
      return null;
    });
    if (!handle) return;
    const nameBuf = Buffer.from(name);
    const zip64 = size >= U32;
    const offset = out.offset;
    yield out.emit(localHeader(nameBuf, mtime, zip64, false));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const src = handle.createReadStream();
    const deflate = createDeflateRaw({ level: 6 });
    src.on("data", (c: string | Buffer) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      crc = crc32(b, crc);
      usize += b.length;
    });
    src.on("error", (e) => deflate.destroy(e));
    src.pipe(deflate);
    for await (const chunk of deflate) {
      csize += (chunk as Buffer).length;
      yield out.emit(chunk as Buffer);
    }
    const bigNow = zip64 || usize >= U32 || csize >= U32;
    yield out.emit(Buffer.concat([u32(0x08074b50), u32(crc >>> 0), bigNow ? u64(csize) : u32(csize), bigNow ? u64(usize) : u32(usize)]));
    out.done.push({ name: nameBuf, offset, crc: crc >>> 0, csize, usize, mtime, mode, dir: false, zip64: bigNow });
  }

  async function* walk(path: string, name: string): AsyncGenerator<Buffer> {
    const info = await lstat(path).catch(() => null);
    if (!info) return void skipped.push(`${path}: not found`);
    if (info.isSymbolicLink()) return void skipped.push(`${path}: symbolic link`);
    if (info.isDirectory()) {
      const nameBuf = Buffer.from(`${name}/`);
      const offset = out.offset;
      yield out.emit(localHeader(nameBuf, info.mtime, false, true));
      out.done.push({ name: nameBuf, offset, crc: 0, csize: 0, usize: 0, mtime: info.mtime, mode: info.mode, dir: true, zip64: false });
      const children = await readdir(path).catch((e: NodeJS.ErrnoException) => {
        skipped.push(`${path}: ${e.code === "EACCES" || e.code === "EPERM" ? "permission denied" : (e.code ?? e.message)}`);
        return [] as string[];
      });
      for (const child of children.sort()) yield* walk(posix.join(path, child), `${name}/${child}`);
      return;
    }
    if (info.isFile()) return yield* addFile(path, name, info.size, info.mtime, info.mode);
    skipped.push(`${path}: not a regular file`);
  }

  async function* all(): AsyncGenerator<Buffer> {
    const taken = new Set<string>();
    for (const root of roots) {
      let name = posix.basename(root) || "root";
      for (let n = 2; taken.has(name); n++) name = `${posix.basename(root)}-${n}`;
      taken.add(name);
      yield* walk(root, name);
    }
    if (skipped.length > 0) {
      const text = Buffer.from(`These were not included:\n${skipped.join("\n")}\n`);
      const nameBuf = Buffer.from("_NOT_INCLUDED.txt");
      const offset = out.offset;
      const mtime = new Date();
      yield out.emit(localHeader(nameBuf, mtime, false, false));
      const deflated = deflateRawSync(text);
      yield out.emit(deflated);
      yield out.emit(Buffer.concat([u32(0x08074b50), u32(crc32(text, 0) >>> 0), u32(deflated.length), u32(text.length)]));
      out.done.push({ name: nameBuf, offset, crc: crc32(text, 0) >>> 0, csize: deflated.length, usize: text.length, mtime, mode: 0o100644, dir: false, zip64: false });
    }
    for (const part of trailer(out)) yield part;
  }

  return Readable.from(all(), { objectMode: false });
}
