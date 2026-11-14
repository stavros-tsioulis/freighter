import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { PODMAN, containerHome, containerRuntimeDir, sharedDir } from "@freighter/systemd";
import type { Deps } from "./deps.ts";
import { PTY_HELPER } from "./pty-helper.ts";
import { loadCurrentManifest, resolveServiceUnit } from "./status.ts";

/** A console that cannot be opened, and why; `code` is the wire error it becomes. */
export class ConsoleError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

export interface ConsolePlan {
  kind: "host" | "container";
  /** Who the shell runs as: the app's user (the user of the container's processes, for an image: its root, the app's user). */
  user: string;
  /** Where it starts. For a container this is the image's own working directory. */
  cwd: string;
  /** The shell, for display. */
  shell: string;
  /** What the PTY helper runs, with the user switch included. */
  argv: string[];
  /** The environment of the shell, and nothing else of the agent's. */
  env: Record<string, string>;
}

const SHELL_SCRIPT = 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi';
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** What a unit file sets for its process: `Environment=` lines, the files it loads, and where it runs. */
export function parseUnitEnvironment(text: string): { env: Record<string, string>; files: string[]; workingDirectory?: string } {
  const env: Record<string, string> = {};
  const files: string[] = [];
  let workingDirectory: string | undefined;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "Environment") {
      const raw = value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1).replace(/\\(["\\])/g, "$1") : value;
      const assignment = raw.replace(/%%/g, "%");
      const i = assignment.indexOf("=");
      if (i > 0) env[assignment.slice(0, i)] = assignment.slice(i + 1);
    } else if (key === "EnvironmentFile") files.push(value.replace(/^-/, ""));
    else if (key === "WorkingDirectory") workingDirectory = value;
  }
  return { env, files, workingDirectory };
}

/** An env file as Freighter writes it: `KEY="value"` per line. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/\\(["\\])/g, "$1");
  }
  return out;
}

export interface ConsoleOptions {
  /** Run this (no shell in between) instead of an interactive shell. */
  command?: string[];
  /** On a terminal (default), or on plain pipes. */
  tty?: boolean;
  /** More variables for it, over the service's. Passed in the environment, never on a command line. */
  env?: Record<string, string>;
}

/**
 * What a console for a service runs. A host command service gets a shell as the app's user, in the directory its unit
 * runs in, with the environment of its unit (values and secrets). An image service gets `podman exec` into its running
 * container, as the app's rootless Podman user, with the container's own environment.
 */
export async function consolePlan(d: Deps, app: string, service: string, opts: ConsoleOptions = {}): Promise<ConsolePlan> {
  const tty = opts.tty !== false;
  const extra = opts.env ?? {};
  const manifest = await loadCurrentManifest(d, app);
  const def = manifest.services[service];
  if (!def) throw new ConsoleError("not_found", `unknown service "${service}" (have: ${Object.keys(manifest.services).join(", ")})`);
  const unit = await resolveServiceUnit(d, app, service);
  const status = await d.systemd.status(unit);
  if (status.activeState !== "active") throw new ConsoleError("conflict", `service ${service} is not running (${status.activeState}/${status.subState}): there is nothing to open a console in`);
  const user = app;
  const term: Record<string, string> = tty ? { TERM: "xterm-256color", LANG: "C.UTF-8", COLORTERM: "truecolor" } : { LANG: "C.UTF-8" };
  const tail = opts.command ?? ["/bin/sh", "-c", SHELL_SCRIPT];

  if (def.image !== undefined) {
    if (d.dev) throw new ConsoleError("bad_request", "containers are not available without a real server");
    const container = unit.replace(/\.service$/, "");
    const home = containerHome(d.layout, app);
    const env = { PATH: SAFE_PATH, HOME: home, XDG_RUNTIME_DIR: containerRuntimeDir(app), TMPDIR: `${home}/tmp`, ...term, ...extra };
    return {
      kind: "container",
      user,
      cwd: "/",
      shell: opts.command ? opts.command[0]! : "bash or sh in the container",
      env,
      // `runuser` puts the user's passwd home (which a system user does not have) in HOME, so it is set again after it
      argv: ["runuser", "-u", user, "--", "env", `HOME=${home}`, `XDG_RUNTIME_DIR=${containerRuntimeDir(app)}`, `TMPDIR=${home}/tmp`, PODMAN, "--cgroup-manager=cgroupfs", "exec", tty ? "-it" : "-i", ...(tty ? ["-e", "TERM", "-e", "COLORTERM"] : []), ...Object.keys(extra).flatMap((k) => ["-e", k]), container, ...tail],
    };
  }

  const text = await readFile(`${d.layout.unitDir}/${unit}`, "utf8").catch(() => "");
  const parsed = parseUnitEnvironment(text);
  const fromFiles: Record<string, string> = {};
  for (const file of parsed.files) Object.assign(fromFiles, parseEnvFile(await readFile(file, "utf8").catch(() => "")));
  const cwd = parsed.workingDirectory ?? sharedDir(d.layout, app);
  const env = { PATH: d.dev ? (process.env.PATH ?? SAFE_PATH) : SAFE_PATH, HOME: sharedDir(d.layout, app), USER: user, LOGNAME: user, ...parsed.env, ...fromFiles, ...term, ...extra };
  const base = tail;
  // runuser resets HOME, USER and LOGNAME (and nothing else), so those are set again after it. They hold no secrets,
  // which must never be on a command line: the rest of the environment, secrets included, passes through runuser as it is.
  const argv = d.dev ? base : ["runuser", "-u", user, "--", "env", `HOME=${env.HOME}`, `USER=${user}`, `LOGNAME=${user}`, ...base];
  return { kind: "host", user, cwd, shell: opts.command ? opts.command[0]! : "bash or sh", env, argv };
}

async function findPython(): Promise<string> {
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    for (const name of ["python3", "python"]) {
      const path = `${dir}/${name}`;
      if (await access(path).then(() => true, () => false)) return path;
    }
  }
  throw new ConsoleError("bad_request", "the console needs python3 on this server (apt install python3)");
}

/** Start the PTY helper for a plan. Its stdin and stdout carry console frames; stderr is only for trouble starting. */
export async function spawnConsole(plan: ConsolePlan, size: { cols: number; rows: number; /** false: plain pipes, for a command run without a terminal */ tty?: boolean }): Promise<ChildProcess> {
  const python = await findPython();
  return spawn(python, ["-c", PTY_HELPER, size.tty === false ? "pipe" : "tty", String(size.cols), String(size.rows), plan.cwd, ...plan.argv], { env: plan.env, stdio: ["pipe", "pipe", "pipe"] });
}
