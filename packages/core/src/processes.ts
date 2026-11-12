import { readFile, readdir } from "node:fs/promises";
import { cpus } from "node:os";
import { identities } from "./files.ts";

/**
 * The processes running on the server, read from /proc, and a way to signal one. Processes that belong to Freighter are
 * recognised by the systemd unit they run in (`freighter-<app>--<service>.service`, a build, or Freighter's own
 * services) and, for containers, by the app's user.
 */
export type Managed =
  | { kind: "app"; app: string; service: string | null }
  | { kind: "storage"; app: string; service: string | null }
  | { kind: "build"; app: null; service: null }
  | { kind: "platform"; app: null; service: null };

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** The executable's name (up to 15 characters, as the kernel keeps it). */
  name: string;
  /** The whole command line, cut at 400 characters. */
  command: string;
  user: string;
  uid: number;
  /** R running, S sleeping, D waiting on disk, Z zombie, T stopped, ... */
  state: string;
  /** Share of one CPU core over the sampling interval, in percent (100 = one full core). */
  cpu: number;
  /** Resident memory, in bytes. */
  rss: number;
  threads: number;
  /** When it started, in epoch milliseconds. */
  startedMs: number;
  /** When it started, in clock ticks since boot: pairs with `pid` to name one process for good, even if the pid is reused. */
  starttime: number;
  unit: string | null;
  managed: Managed | null;
  kernel: boolean;
}

const CLK_TCK = 100;

/** The unit a process runs in, from its /proc/<pid>/cgroup. */
export function unitFromCgroup(cgroup: string): string | null {
  for (const line of cgroup.split("\n")) {
    const path = line.split(":").slice(2).join(":");
    const parts = path.split("/").filter(Boolean);
    const unit = parts.find((p) => /^freighter[a-z0-9-]*\.service$/.test(p));
    if (unit) return unit;
  }
  return null;
}

/** Whether a unit is Freighter's (an app's service, a build, or the platform itself). */
export function managedByUnit(unit: string | null): Managed | null {
  if (!unit) return null;
  if (/^freighter(-agent)?\.service$/.test(unit)) return { kind: "platform", app: null, service: null };
  if (/^freighter-build-[0-9a-f]+\.service$/.test(unit)) return { kind: "build", app: null, service: null };
  const m = /^freighter-(.+?)--(.+?)(?:--.+)?\.service$/.exec(unit);
  if (!m) return null;
  return { kind: m[1]!.startsWith("storage-") ? "storage" : "app", app: m[1]!, service: m[2]! };
}

/** `pid (name) S ppid ...` -> the fields after the name. The name may hold spaces and parentheses, so cut at the last `)`. */
export function parseStat(text: string): { name: string; fields: string[] } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  return { name: text.slice(open + 1, close), fields: text.slice(close + 2).trim().split(" ") };
}

interface Raw {
  pid: number;
  name: string;
  state: string;
  ppid: number;
  ticks: number;
  threads: number;
  starttime: number;
  rssPages: number;
}

async function readRaw(root: string, pid: number): Promise<Raw | null> {
  const text = await readFile(`${root}/${pid}/stat`, "utf8").catch(() => null);
  const parsed = text && parseStat(text);
  if (!parsed) return null;
  const f = parsed.fields; // f[0] is the state (field 3 of the file)
  const n = (i: number) => Number(f[i]);
  return { pid, name: parsed.name, state: f[0]!, ppid: n(1), ticks: n(11) + n(12), threads: n(17), starttime: n(19), rssPages: n(21) };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ListOptions {
  /** Where /proc is (a test points it at a fake). */
  procRoot?: string;
  /** How long to watch the processes to work out their CPU use. */
  sampleMs?: number;
  /** Users that are an app's: the processes of a container run as one. */
  appUsers?: ReadonlySet<string>;
  pageSize?: number;
}

export async function listProcesses(o: ListOptions = {}): Promise<{ processes: ProcessInfo[]; cpus: number; memTotal: number; uptimeSeconds: number }> {
  const root = o.procRoot ?? "/proc";
  const pids = (await readdir(root)).filter((n) => /^\d+$/.test(n)).map(Number);
  const before = new Map<number, Raw>();
  const t0 = Date.now();
  for (const pid of pids) {
    const r = await readRaw(root, pid);
    if (r) before.set(pid, r);
  }
  await wait(o.sampleMs ?? 400);
  const seconds = Math.max(0.05, (Date.now() - t0) / 1000);

  const [{ users }, stat, meminfo, uptime] = await Promise.all([
    identities(),
    readFile(`${root}/stat`, "utf8").catch(() => ""),
    readFile(`${root}/meminfo`, "utf8").catch(() => ""),
    readFile(`${root}/uptime`, "utf8").catch(() => ""),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const btime = Number(/^btime (\d+)/m.exec(stat)?.[1] ?? 0) * 1000;
  const memTotal = Number(/^MemTotal:\s+(\d+) kB/m.exec(meminfo)?.[1] ?? 0) * 1024;
  const pageSize = o.pageSize ?? 4096;

  const out: ProcessInfo[] = [];
  for (const pid of pids) {
    const a = before.get(pid);
    const b = a && (await readRaw(root, pid));
    if (!a || !b || a.starttime !== b.starttime) continue; // gone, or the pid was reused during the sample
    const [status, cmdline, cgroup] = await Promise.all([
      readFile(`${root}/${pid}/status`, "utf8").catch(() => ""),
      readFile(`${root}/${pid}/cmdline`, "utf8").catch(() => ""),
      readFile(`${root}/${pid}/cgroup`, "utf8").catch(() => ""),
    ]);
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    const user = names.get(uid) ?? String(uid);
    const kernel = b.ppid === 2 || pid === 2 || cmdline === "";
    const unit = unitFromCgroup(cgroup);
    let managed = managedByUnit(unit);
    if (!managed && !kernel && o.appUsers?.has(user)) managed = { kind: user.startsWith("storage-") ? "storage" : "app", app: user, service: null };
    out.push({
      pid,
      ppid: b.ppid,
      name: b.name,
      command: kernel ? `[${b.name}]` : cmdline.replace(/\0+$/, "").split("\0").join(" ").slice(0, 400),
      user,
      uid,
      state: b.state,
      cpu: Math.round(((b.ticks - a.ticks) / CLK_TCK / seconds) * 1000) / 10,
      rss: b.rssPages * pageSize,
      threads: b.threads,
      startedMs: btime + Math.round((b.starttime / CLK_TCK) * 1000),
      starttime: b.starttime,
      unit,
      managed,
      kernel,
    });
  }
  return { processes: out, cpus: cpus().length, memTotal, uptimeSeconds: Math.round(Number(uptime.split(" ")[0] ?? 0)) };
}

export class ProcessError extends Error {
  constructor(readonly code: "bad_request" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "ProcessError";
  }
}

export const SIGNALS = { TERM: "SIGTERM", KILL: "SIGKILL", HUP: "SIGHUP", INT: "SIGINT", STOP: "SIGSTOP", CONT: "SIGCONT" } as const;
export type SignalName = keyof typeof SIGNALS;

/**
 * Send a signal to one process. `starttime` (from the listing) must still match, so a pid that was reused since the
 * listing is never hit. Pid 1, kernel threads, the agent itself and Freighter's own services are refused.
 */
export async function signalProcess(pid: number, starttime: number, signal: SignalName, o: { procRoot?: string; self?: number; send?: (pid: number, sig: NodeJS.Signals) => void } = {}): Promise<void> {
  const root = o.procRoot ?? "/proc";
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcessError("bad_request", "that process can't be signaled");
  if (pid === (o.self ?? process.pid)) throw new ProcessError("bad_request", "that is the agent itself");
  const now = await readRaw(root, pid);
  if (!now) throw new ProcessError("not_found", `process ${pid} has already ended`);
  if (now.starttime !== starttime) throw new ProcessError("conflict", `process ${pid} is not the one that was listed (the pid was reused); refresh the list`);
  if (now.ppid === 2 || pid === 2) throw new ProcessError("bad_request", "kernel threads can't be signaled");
  const unit = unitFromCgroup(await readFile(`${root}/${pid}/cgroup`, "utf8").catch(() => ""));
  if (managedByUnit(unit)?.kind === "platform") throw new ProcessError("bad_request", "that is part of Freighter itself; restart it from the Software tab or with systemctl");
  try {
    (o.send ?? process.kill)(pid, SIGNALS[signal]);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ProcessError(code === "ESRCH" ? "not_found" : "bad_request", code === "ESRCH" ? `process ${pid} has already ended` : `could not signal ${pid}: ${(e as Error).message}`);
  }
}
