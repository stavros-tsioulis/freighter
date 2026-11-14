import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

const execFileP = promisify(execFile);

export interface Packed {
  /** The `.tar.gz` to upload. */
  file: string;
  size: number;
  files: number;
  /** Delete the temporary archive (a no-op for one that was given). */
  cleanup(): Promise<void>;
  stream(): ReadableStream;
}

/** The files of a directory that belong in a deployment: what git tracks or doesn't ignore, else everything but `.git`. */
async function listFiles(dir: string): Promise<string[] | null> {
  try {
    const inside = await execFileP("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    if (inside.stdout.trim() !== "true") return null;
    const { stdout } = await execFileP("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/** An archive for a directory (packed into a temporary file) or a `.tar.gz` that is already one. */
export async function pack(source: string): Promise<Packed> {
  const info = await stat(source).catch(() => {
    throw new CliError(`${source} not found`);
  });
  const stream = (file: string) => () => Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
  if (!info.isDirectory()) return { file: source, size: info.size, files: 0, cleanup: async () => undefined, stream: stream(source) };

  const tmp = await mkdtemp(join(tmpdir(), "freighter-pack-"));
  const file = join(tmp, "artifact.tar.gz");
  const listed = await listFiles(source);
  const files = listed?.filter((f) => !f.startsWith(".git/")) ?? null;
  await new Promise<void>((resolve, reject) => {
    const args = files ? ["-czf", file, "-C", source, "--null", "-T", "-"] : ["-czf", file, "--exclude=.git", "-C", source, "."];
    const child = spawn("tar", args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new CliError(`could not pack ${source}: ${err.trim() || `tar exited with ${code}`}`))));
    if (files) child.stdin.end(files.join("\0") + "\0");
    else child.stdin.end();
  });
  let count = files?.length ?? 0;
  if (!files) count = (await execFileP("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n").filter((l) => l && !l.endsWith("/")).length;
  return { file, size: (await stat(file)).size, files: count, cleanup: () => rm(tmp, { recursive: true, force: true }), stream: stream(file) };
}

/** The text of `app.yaml` at the root of a `.tar.gz`. */
export async function appYamlOf(archive: string): Promise<string> {
  for (const name of ["app.yaml", "./app.yaml"]) {
    try {
      return (await execFileP("tar", ["-xzOf", archive, name])).stdout;
    } catch {
      /* try the other spelling */
    }
  }
  throw new CliError(`${archive} has no app.yaml at its root`);
}
