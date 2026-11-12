import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultLayout, type Layout } from "./layout.ts";
import { assertUnitName } from "./names.ts";

export interface RunResult {
  stdout: string;
  code: number;
  stderr?: string;
}
export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  /** Kill the command after this long (it then rejects like any other failure to run). */
  timeoutMs?: number;
  /** Kill the command when this fires (it then rejects). */
  signal?: AbortSignal;
}
export type Run = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const execFileP = promisify(execFile);

/** Runs a command without a shell. A non-zero exit resolves with its code rather than throwing. */
export const defaultRun: Run = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts?.timeoutMs,
      signal: opts?.signal,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof err.code !== "number") throw e;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
  }
};

export interface UnitStatus {
  activeState: string;
  subState: string;
  mainPid: number;
  memoryCurrent: number | null;
  restarts: number;
  /** Total CPU time used, in nanoseconds (null when accounting is off). */
  cpuNanos: number | null;
}

export interface Systemd {
  installUnit(name: string, content: string): Promise<void>;
  removeUnit(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
  status(name: string): Promise<UnitStatus>;
  logsArgs(name: string, opts?: { lines?: number; follow?: boolean }): string[];
}

export function createSystemd({ run = defaultRun, layout = defaultLayout }: { run?: Run; layout?: Layout } = {}): Systemd {
  const ctl = async (...args: string[]) => {
    const r = await run("systemctl", args);
    if (r.code !== 0) throw new Error(`systemctl ${args.join(" ")} failed with exit code ${r.code}`);
    return r.stdout;
  };
  const unitCmd = (verb: string) => async (name: string) => {
    await ctl(verb, assertUnitName(name));
  };

  return {
    async installUnit(name, content) {
      assertUnitName(name);
      await mkdir(layout.unitDir, { recursive: true });
      const tmp = join(layout.unitDir, `.${name}.tmp`);
      await writeFile(tmp, content, { mode: 0o644 });
      await rename(tmp, join(layout.unitDir, name));
      await ctl("daemon-reload");
    },
    async removeUnit(name) {
      assertUnitName(name);
      await rm(join(layout.unitDir, name), { force: true });
      await ctl("daemon-reload");
    },
    start: unitCmd("start"),
    stop: unitCmd("stop"),
    restart: unitCmd("restart"),
    enable: unitCmd("enable"),
    disable: unitCmd("disable"),
    async status(name) {
      const out = await ctl("show", "-p", "ActiveState,SubState,MainPID,MemoryCurrent,NRestarts,CPUUsageNSec", assertUnitName(name));
      const kv = Object.fromEntries(
        out
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1)] as const;
          }),
      );
      const mem = Number(kv.MemoryCurrent);
      const cpu = Number(kv.CPUUsageNSec);
      return {
        activeState: kv.ActiveState ?? "unknown",
        subState: kv.SubState ?? "unknown",
        mainPid: Number(kv.MainPID ?? 0),
        memoryCurrent: Number.isFinite(mem) ? mem : null, // "[not set]" when accounting is off
        restarts: Number(kv.NRestarts ?? 0),
        cpuNanos: Number.isFinite(cpu) && cpu < 2 ** 53 ? cpu : null, // "[not set]" / UINT64_MAX when accounting is off
      };
    },
    logsArgs(name, { lines = 100, follow = false } = {}) {
      return ["-u", assertUnitName(name), "-n", String(lines), "--no-pager", ...(follow ? ["-f"] : [])];
    },
  };
}
