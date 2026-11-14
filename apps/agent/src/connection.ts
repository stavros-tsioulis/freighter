import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Duplex } from "node:stream";
import type { Deps } from "@freighter/core";
import { FRAME, LineReader, encodeFrame, ops, request, type Reply, type WireError } from "@freighter/protocol";
import { classify, dispatch, explorer, type Handlers } from "./handlers.ts";
import { ConsoleError, consolePlan, createStorageUpload, createUpload, openForDownload, openStorageDownload, spawnConsole, zipStream } from "@freighter/core";

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

/** `fs.write`: a header line, then exactly `size` raw bytes, which become the file once they have all arrived. */
function handleFsWrite(d: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown) {
  const parsed = ops["fs.write"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, { code: "bad_request", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { path, size, overwrite, storage } = parsed.data;
  try {
    explorer(d, true);
  } catch (e) {
    return rejectAndClose(socket, id, classify(e));
  }
  // The bytes are already on their way; readRaw has to be called before the next line is read, so the sink is set up
  // behind a Writable that waits for it.
  let sink: Awaited<ReturnType<typeof createUpload>> | undefined;
  const ready = (storage ? createStorageUpload(d, storage, path, overwrite) : createUpload(path, overwrite)).then((s) => (sink = s));
  const dest = new Writable({
    write(chunk: Buffer, _enc, cb) {
      ready.then(() => (sink!.dest.write(chunk) ? cb() : void sink!.dest.once("drain", () => cb())), cb);
    },
    final(cb) {
      ready.then(() => sink!.dest.end(() => cb()), cb);
    },
  });
  dest.on("error", () => {}); // reported through the await below
  const received = reader.readRaw(size, dest);
  received.catch(() => {}); // reported through the await below
  (socket as unknown as { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout?.(120_000, () => socket.destroy());
  void (async () => {
    try {
      await ready; // a refused name or folder is reported even if the bytes are still coming
      await received;
      dest.end();
      await finished(dest);
      await sink!.commit();
      reply(socket, { id, ok: true, result: {} });
    } catch (e) {
      await sink?.abort().catch(() => {});
      rejectAndClose(socket, id, classify(e));
    }
  })();
}

/** `fs.read` and `fs.archive`: the reply line, then the bytes, then the connection is closed. */
function handleFsStream(d: Deps, socket: Duplex, id: string, op: "fs.read" | "fs.archive", rawArgs: unknown) {
  void (async () => {
    try {
      explorer(d);
      if (op === "fs.read") {
        const { path, storage } = ops["fs.read"].args.parse(rawArgs);
        const file = storage ? await openStorageDownload(d, storage, path) : await openForDownload(path);
        socket.write(JSON.stringify({ id, ok: true, result: { size: file.size, mtimeMs: file.mtimeMs } } satisfies Reply) + "\n");
        file.stream.on("error", () => socket.destroy());
        file.stream.pipe(socket as never);
      } else {
        const { paths } = ops["fs.archive"].args.parse(rawArgs);
        socket.write(JSON.stringify({ id, ok: true, result: {} } satisfies Reply) + "\n");
        const zip = zipStream(paths);
        zip.on("error", () => socket.destroy());
        zip.pipe(socket as never);
      }
      socket.on("close", () => undefined);
    } catch (e) {
      rejectAndClose(socket, id, classify(e));
    }
  })();
}

let consoles = 0;

/**
 * `console.open`: a shell for a service. The reply line is followed by frames both ways: the client's go to the PTY
 * helper as they are (it speaks the same format), and its output comes back the same way. The helper ends the shell
 * when its input closes, so a dropped connection never leaves one behind.
 */
function handleConsole(d: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown) {
  const parsed = ops["console.open"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, { code: "bad_request", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  const { app, service, cols, rows, command, tty, env } = parsed.data;
  const { enabled, idleMinutes, maxSessions } = d.config.agent.console;
  void (async () => {
    let counted = false;
    try {
      if (!enabled) throw new ConsoleError("bad_request", "the console is turned off on this server (agent.console.enabled in its config.yaml)");
      if (consoles >= maxSessions) throw new ConsoleError("conflict", `${maxSessions} consoles are already open on this server`);
      const plan = await consolePlan(d, app, service, { command, tty, env });
      const child = await spawnConsole(plan, { cols, rows, tty });
      consoles++;
      counted = true;
      let ended = false;
      const end = (message?: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(idle);
        if (message && !socket.destroyed) socket.write(encodeFrame(FRAME.error, message));
        child.stdin?.end();
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      };
      let idle: NodeJS.Timeout = setTimeout(() => end(`closed after ${idleMinutes} minutes without input`), idleMinutes * 60_000);
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => end(`closed after ${idleMinutes} minutes without input`), idleMinutes * 60_000);
      };
      let stderr = "";
      child.stderr?.on("data", (c: Buffer) => void (stderr = (stderr + c.toString()).slice(-2000)));
      child.stdin?.on("error", () => {});
      child.stdout?.on("data", (chunk: Buffer) => {
        if (socket.destroyed) return;
        if (!socket.write(chunk)) {
          child.stdout?.pause();
          socket.once("drain", () => child.stdout?.resume());
        }
      });
      child.once("close", (code) => {
        ended = true;
        clearTimeout(idle);
        if (!socket.destroyed) {
          // the helper sends the exit frame itself; only a helper that failed to run says why here
          if (code !== 0 && stderr.trim()) socket.write(encodeFrame(FRAME.error, stderr.trim()));
          socket.end();
        }
        if (counted) consoles--;
        counted = false;
      });
      socket.once("close", () => end());
      socket.write(JSON.stringify({ id, ok: true, result: { kind: plan.kind, user: plan.user, cwd: plan.cwd, shell: plan.shell } } satisfies Reply) + "\n");
      reader.takeover((chunk) => {
        touch();
        child.stdin?.write(chunk);
      });
    } catch (e) {
      if (counted) consoles--;
      rejectAndClose(socket, id, classify(e));
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
        if (req.op === "fs.write") return handleFsWrite(d, socket, reader, id, req.args);
        if (req.op === "fs.read" || req.op === "fs.archive") return handleFsStream(d, socket, id, req.op, req.args);
        if (req.op === "console.open") return handleConsole(d, socket, reader, id, req.args);
      } catch {
        /* fall through: dispatch() produces the proper error reply */
      }
      void dispatch(handlers, line).then((r) => reply(socket, r));
    },
    () => rejectAndClose(socket, "?", { code: "bad_request", message: "request too large" }),
  );
}
