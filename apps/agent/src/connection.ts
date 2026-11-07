import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Duplex } from "node:stream";
import type { Deps } from "@freighter/core";
import { LineReader, ops, request, type Reply, type WireError } from "@freighter/protocol";
import { dispatch, type Handlers } from "./handlers.ts";

const reply = (socket: Duplex, r: Reply) => {
  if (!socket.destroyed) socket.write(JSON.stringify(r) + "\n");
};

/** Reply with an error and drop the connection (used when the client may still be streaming bytes at us). */
function rejectAndClose(socket: Duplex, id: string, error: WireError) {
  if (socket.destroyed) return;
  socket.end(JSON.stringify({ id, ok: false, error } satisfies Reply) + "\n", () => setTimeout(() => socket.destroy(), 50));
}

/** `artifact.put`: a header line, then exactly `size` raw bytes, written into the spool and verified. */
function handlePut(d: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown) {
  const parsed = ops["artifact.put"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, { code: "bad_request", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { id: artifactId, size, sha256 } = parsed.data;
  const maxBytes = d.config.agent.maxArtifactMb * 1024 * 1024;
  if (size > maxBytes) return rejectAndClose(socket, id, { code: "bad_request", message: `artifact exceeds ${d.config.agent.maxArtifactMb} MiB` });

  const dir = d.config.agent.artifactsDir;
  const path = `${dir}/${artifactId}.tar.gz`;
  const hash = createHash("sha256");
  let file: ReturnType<typeof createWriteStream> | undefined;
  // Everything up to readRaw() must stay synchronous so no upload byte is mistaken for a request line.
  const ready = mkdir(dir, { recursive: true, mode: 0o770 });
  const dest = new Writable({
    construct(cb) {
      ready.then(() => {
        file = createWriteStream(path, { mode: 0o600 });
        file.once("open", () => cb()).once("error", cb);
      }, cb);
    },
    write(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      file!.write(chunk, cb);
    },
    final(cb) {
      file!.end(cb);
    },
  });
  const received = reader.readRaw(size, dest);
  (socket as unknown as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout?.(60_000, () => socket.destroy()); // a client that stops sending must not hold the connection forever

  void (async () => {
    try {
      await received;
      dest.end();
      await finished(dest);
      if (hash.digest("hex") !== sha256) throw new Error("sha256 mismatch");
      reply(socket, { id, ok: true, result: { path } });
    } catch (e) {
      await rm(path, { force: true });
      rejectAndClose(socket, id, { code: "bad_request", message: `upload failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  })();
}

/** Serve one client connection (unix or TLS): JSON request lines in, JSON replies out. */
export function serveConnection(socket: Duplex, d: Deps, handlers: Handlers): void {
  socket.on("error", () => {});
  new LineReader(
    socket,
    (line, reader) => {
      let id = "?";
      try {
        const req = request.parse(JSON.parse(line));
        id = req.id;
        if (req.op === "artifact.put") return handlePut(d, socket, reader, id, req.args);
      } catch {
        /* fall through: dispatch() produces the proper error reply */
      }
      void dispatch(handlers, line).then((r) => reply(socket, r));
    },
    () => rejectAndClose(socket, "?", { code: "bad_request", message: "request too large" }),
  );
}
