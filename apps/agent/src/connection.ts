import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable, type Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import type { Deps, UploadSink } from "@freighter/core";
import {
  ConsoleError,
  consolePlan,
  createStorageUpload,
  createUpload,
  openForDownload,
  openStorageDownload,
  spawnConsole,
  zipStream,
} from "@freighter/core";
import { FRAME, LineReader, encodeFrame, ops, request, type Reply, type WireError } from "@freighter/protocol";
import { badRequest, describeError, formatIssues } from "./errors.ts";
import { classify, dispatch, explorer, type Handlers } from "./handlers.ts";

const CLOSE_DRAIN_DELAY_MS = 50;
const ARTIFACT_UPLOAD_TIMEOUT_MS = 60_000;
const FILE_WRITE_TIMEOUT_MS = 120_000;
const CONSOLE_KILL_DELAY_MS = 3_000;
const CONSOLE_STDERR_TAIL_BYTES = 2_000;
const UPLOAD_FILE_MODE = 0o600;
const ARTIFACTS_DIRECTORY_MODE = 0o770;
const BYTES_PER_MIB = 1024 * 1024;

type SocketWithTimeout = Duplex & { setTimeout?: (ms: number, callback: () => void) => void };

function armIdleTimeout(socket: Duplex, timeoutMs: number): void {
  (socket as SocketWithTimeout).setTimeout?.(timeoutMs, () => socket.destroy());
}

function writeReply(socket: Duplex, reply: Reply): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
}

/** Reply with an error and drop the connection (used when the client may still be streaming bytes at us). */
function rejectAndClose(socket: Duplex, id: string, error: WireError): void {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify({ id, ok: false, error } satisfies Reply)}\n`, () =>
    setTimeout(() => socket.destroy(), CLOSE_DRAIN_DELAY_MS),
  );
}

function createVerifiedDownload(path: string, ready: Promise<unknown>, hash: Hash): Writable {
  let file: ReturnType<typeof createWriteStream> | undefined;
  return new Writable({
    construct(callback) {
      ready.then(() => {
        file = createWriteStream(path, { mode: UPLOAD_FILE_MODE });
        file.once("open", () => callback()).once("error", callback);
      }, callback);
    },
    write(chunk: Buffer, _encoding, callback) {
      if (!file) return callback(new Error("upload destination is not open"));
      hash.update(chunk);
      file.write(chunk, callback);
    },
    final(callback) {
      if (!file) return callback(new Error("upload destination is not open"));
      file.end(callback);
    },
  });
}

/** `artifact.put`: a header line, then exactly `size` raw bytes, written into the spool and verified. */
function handleArtifactPut(deps: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown): void {
  const parsed = ops["artifact.put"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, badRequest(formatIssues(parsed.error.issues)));

  const { id: artifactId, size, sha256 } = parsed.data;
  const { artifactsDir, maxArtifactMb } = deps.config.agent;
  const maxBytes = maxArtifactMb * BYTES_PER_MIB;
  if (size > maxBytes) return rejectAndClose(socket, id, badRequest(`artifact exceeds ${maxArtifactMb} MiB`));

  const path = join(artifactsDir, `${artifactId}.tar.gz`);
  const hash = createHash("sha256");
  // Everything up to readRaw() must stay synchronous so no upload byte is mistaken for a request line.
  const ready = mkdir(artifactsDir, { recursive: true, mode: ARTIFACTS_DIRECTORY_MODE });
  const destination = createVerifiedDownload(path, ready, hash);
  const received = reader.readRaw(size, destination);
  // A client that stops sending must not hold the connection forever.
  armIdleTimeout(socket, ARTIFACT_UPLOAD_TIMEOUT_MS);

  void (async () => {
    try {
      await received;
      destination.end();
      await finished(destination);
      if (hash.digest("hex") !== sha256) throw new Error("sha256 mismatch");
      writeReply(socket, { id, ok: true, result: { path } });
    } catch (error) {
      await rm(path, { force: true });
      rejectAndClose(socket, id, badRequest(`upload failed: ${describeError(error)}`));
    }
  })();
}

function openUploadSink(deps: Deps, options: { path: string; overwrite: boolean; storage?: string }): Promise<UploadSink> {
  return options.storage
    ? createStorageUpload(deps, options.storage, options.path, options.overwrite)
    : createUpload(options.path, options.overwrite);
}

function createUploadWriter(sinkReady: Promise<unknown>, sink: () => UploadSink | undefined): Writable {
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sinkReady.then(() => {
        const upload = sink();
        if (!upload) return callback(new Error("upload destination is not open"));
        if (upload.dest.write(chunk)) callback();
        else upload.dest.once("drain", () => callback());
      }, callback);
    },
    final(callback) {
      sinkReady.then(() => {
        const upload = sink();
        if (!upload) return callback(new Error("upload destination is not open"));
        upload.dest.end(() => callback());
      }, callback);
    },
  });
  destination.on("error", () => {}); // reported through the await below
  return destination;
}

/** `fs.write`: a header line, then exactly `size` raw bytes, which become the file once they have all arrived. */
function handleFsWrite(deps: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown): void {
  const parsed = ops["fs.write"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, badRequest(formatIssues(parsed.error.issues)));

  const { path, size, overwrite, storage } = parsed.data;
  try {
    explorer(deps, true);
  } catch (error) {
    return rejectAndClose(socket, id, classify(error));
  }

  // The bytes are already on their way; readRaw has to be called before the next line is read, so the sink opens behind
  // a Writable that waits for it.
  let sink: UploadSink | undefined;
  const sinkReady = openUploadSink(deps, { path, overwrite, storage }).then((opened) => {
    sink = opened;
  });
  const destination = createUploadWriter(sinkReady, () => sink);
  const received = reader.readRaw(size, destination);
  received.catch(() => {}); // reported through the await below
  armIdleTimeout(socket, FILE_WRITE_TIMEOUT_MS);

  void (async () => {
    try {
      await sinkReady; // a refused name or folder is reported even if the bytes are still coming
      await received;
      destination.end();
      await finished(destination);
      if (!sink) throw new Error("upload destination is not open");
      await sink.commit();
      writeReply(socket, { id, ok: true, result: {} });
    } catch (error) {
      await sink?.abort().catch(() => {});
      rejectAndClose(socket, id, classify(error));
    }
  })();
}

/** `fs.read`: the reply line, then the file bytes, then the connection is closed. */
function handleFsRead(deps: Deps, socket: Duplex, id: string, rawArgs: unknown): void {
  void (async () => {
    try {
      explorer(deps);
      const { path, storage } = ops["fs.read"].args.parse(rawArgs);
      const file = storage ? await openStorageDownload(deps, storage, path) : await openForDownload(path);
      writeReply(socket, { id, ok: true, result: { size: file.size, mtimeMs: file.mtimeMs } });
      file.stream.on("error", () => socket.destroy());
      file.stream.pipe(socket);
    } catch (error) {
      rejectAndClose(socket, id, classify(error));
    }
  })();
}

/** `fs.archive`: the reply line, then a zip of the requested paths. */
function handleFsArchive(deps: Deps, socket: Duplex, id: string, rawArgs: unknown): void {
  void (async () => {
    try {
      explorer(deps);
      const { paths } = ops["fs.archive"].args.parse(rawArgs);
      writeReply(socket, { id, ok: true, result: {} });
      const zip = zipStream(paths);
      zip.on("error", () => socket.destroy());
      zip.pipe(socket);
    } catch (error) {
      rejectAndClose(socket, id, classify(error));
    }
  })();
}

let openConsoleCount = 0;

/**
 * `console.open`: a shell for a service. The reply line is followed by frames both ways: the client's go to the PTY
 * helper as they are (it speaks the same format), and its output comes back the same way. The helper ends the shell
 * when its input closes, so a dropped connection never leaves one behind.
 */
function handleConsole(deps: Deps, socket: Duplex, reader: LineReader, id: string, rawArgs: unknown): void {
  const parsed = ops["console.open"].args.safeParse(rawArgs);
  if (!parsed.success) return rejectAndClose(socket, id, badRequest(formatIssues(parsed.error.issues)));

  const { app, service, cols, rows, command, tty, env } = parsed.data;
  const { enabled, idleMinutes, maxSessions } = deps.config.agent.console;

  void (async () => {
    let counted = false;
    try {
      if (!enabled) throw new ConsoleError("bad_request", "the console is turned off on this server (agent.console.enabled in its config.yaml)");
      if (openConsoleCount >= maxSessions) throw new ConsoleError("conflict", `${maxSessions} consoles are already open on this server`);

      const plan = await consolePlan(deps, app, service, { command, tty, env });
      const child = await spawnConsole(plan, { cols, rows, tty });
      openConsoleCount++;
      counted = true;

      let ended = false;
      let stderrTail = "";
      let idleTimer: NodeJS.Timeout | undefined;
      const end = (message?: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(idleTimer);
        if (message && !socket.destroyed) socket.write(encodeFrame(FRAME.error, message));
        child.stdin?.end();
        setTimeout(() => child.kill("SIGKILL"), CONSOLE_KILL_DELAY_MS).unref();
      };
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => end(`closed after ${idleMinutes} minutes without input`), idleMinutes * 60_000);
      };
      resetIdleTimer();

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-CONSOLE_STDERR_TAIL_BYTES);
      });
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
        clearTimeout(idleTimer);
        if (!socket.destroyed) {
          // The helper sends the exit frame itself; only a helper that failed to run says why here.
          if (code !== 0 && stderrTail.trim()) socket.write(encodeFrame(FRAME.error, stderrTail.trim()));
          socket.end();
        }
        if (counted) openConsoleCount--;
        counted = false;
      });
      socket.once("close", () => end());
      writeReply(socket, { id, ok: true, result: { kind: plan.kind, user: plan.user, cwd: plan.cwd, shell: plan.shell } });
      reader.takeover((chunk) => {
        resetIdleTimer();
        child.stdin?.write(chunk);
      });
    } catch (error) {
      if (counted) openConsoleCount--;
      rejectAndClose(socket, id, classify(error));
    }
  })();
}

interface RawRequestContext {
  socket: Duplex;
  reader: LineReader;
  id: string;
  args: unknown;
}

type RawRequestHandler = (context: RawRequestContext) => void;

function createRawHandlers(deps: Deps): Record<string, RawRequestHandler> {
  return {
    "artifact.put": ({ socket, reader, id, args }) => handleArtifactPut(deps, socket, reader, id, args),
    "fs.write": ({ socket, reader, id, args }) => handleFsWrite(deps, socket, reader, id, args),
    "fs.read": ({ socket, id, args }) => handleFsRead(deps, socket, id, args),
    "fs.archive": ({ socket, id, args }) => handleFsArchive(deps, socket, id, args),
    "console.open": ({ socket, reader, id, args }) => handleConsole(deps, socket, reader, id, args),
  };
}

function handleLine(
  socket: Duplex,
  handlers: Handlers,
  rawHandlers: Record<string, RawRequestHandler>,
  line: string,
  reader: LineReader,
): void {
  try {
    const req = request.parse(JSON.parse(line));
    const rawHandler = rawHandlers[req.op];
    if (rawHandler) {
      rawHandler({ socket, reader, id: req.id, args: req.args });
      return;
    }
  } catch {
    // Not a raw request: dispatch() produces the proper error reply.
  }
  void dispatch(handlers, line).then((reply) => writeReply(socket, reply));
}

/** Serve one client connection (unix or TLS): JSON request lines in, JSON replies out. */
export function serveConnection(socket: Duplex, deps: Deps, handlers: Handlers): void {
  socket.on("error", () => {});
  const rawHandlers = createRawHandlers(deps);
  new LineReader(
    socket,
    (line, reader) => handleLine(socket, handlers, rawHandlers, line, reader),
    () => rejectAndClose(socket, "?", badRequest("request too large")),
  );
}
