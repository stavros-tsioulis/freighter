import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessError, listProcesses, managedByUnit, parseStat, signalProcess, unitFromCgroup } from "../src/index.ts";

/** One line of /proc/<pid>/stat: pid (name) state ppid ... utime stime ... threads ... starttime vsize rss */
const stat = (pid: number, name: string, o: { state?: string; ppid?: number; ticks?: number; threads?: number; start?: number; rssPages?: number } = {}) => {
  const f = Array<string>(22).fill("0");
  f[0] = o.state ?? "S";
  f[1] = String(o.ppid ?? 1);
  f[11] = String(o.ticks ?? 0);
  f[17] = String(o.threads ?? 1);
  f[19] = String(o.start ?? 1000);
  f[21] = String(o.rssPages ?? 0);
  return `${pid} (${name}) ${f.join(" ")}\n`;
};

async function fakeProc(procs: { pid: number; name: string; cmd: string; cgroup: string; uid?: number; stat?: Parameters<typeof stat>[2] }[]) {
  const root = await mkdtemp(join(tmpdir(), "freighter-proc-"));
  await writeFile(`${root}/stat`, "cpu 1 2 3\nbtime 1700000000\n");
  await writeFile(`${root}/meminfo`, "MemTotal:       8000000 kB\nMemFree: 1 kB\n");
  await writeFile(`${root}/uptime`, "1234.56 99.0\n");
  for (const p of procs) {
    await mkdir(`${root}/${p.pid}`);
    await writeFile(`${root}/${p.pid}/stat`, stat(p.pid, p.name, p.stat));
    await writeFile(`${root}/${p.pid}/status`, `Name:\t${p.name}\nUid:\t${p.uid ?? 0}\t0\t0\t0\n`);
    await writeFile(`${root}/${p.pid}/cmdline`, p.cmd);
    await writeFile(`${root}/${p.pid}/cgroup`, p.cgroup);
  }
  return root;
}

describe("reading a process", () => {
  it("cuts the stat line at the last ')', so a name with spaces and brackets is safe", () => {
    const p = parseStat(stat(7, "weird (name) x"))!;
    expect(p.name).toBe("weird (name) x");
    expect(p.fields[0]).toBe("S");
    expect(p.fields[1]).toBe("1");
    expect(parseStat("garbage")).toBeNull();
  });

  it("finds the unit in the cgroup and says whose it is", () => {
    expect(unitFromCgroup("0::/system.slice/freighter-shop--web--r20261112-1.service\n")).toBe("freighter-shop--web--r20261112-1.service");
    expect(unitFromCgroup("0::/system.slice/nginx.service\n")).toBeNull();
    expect(unitFromCgroup("1:name=systemd:/a/freighter-shop--web.service/b\n0::/\n")).toBe("freighter-shop--web.service");
    expect(managedByUnit("freighter-shop--web--r1.service")).toEqual({ kind: "app", app: "shop", service: "web" });
    expect(managedByUnit("freighter-my-shop--web-api.service")).toEqual({ kind: "app", app: "my-shop", service: "web-api" });
    expect(managedByUnit("freighter-storage-uploads--s3.service")).toEqual({ kind: "storage", app: "storage-uploads", service: "s3" });
    expect(managedByUnit("freighter-build-1a2b3c4d.service")).toMatchObject({ kind: "build" });
    expect(managedByUnit("freighter.service")).toMatchObject({ kind: "platform" });
    expect(managedByUnit("freighter-agent.service")).toMatchObject({ kind: "platform" });
    expect(managedByUnit("nginx.service")).toBeNull();
    expect(managedByUnit(null)).toBeNull();
  });
});

describe("listProcesses", () => {
  it("lists what runs with its user, memory, CPU over the sample and who manages it", async () => {
    const root = await fakeProc([
      { pid: 2, name: "kthreadd", cmd: "", cgroup: "0::/\n", stat: { ppid: 0 } },
      { pid: 100, name: "node", cmd: "node\0server.mjs\0--port\x003100\0", cgroup: "0::/system.slice/freighter-shop--web--r1.service\n", uid: 0, stat: { ticks: 100, rssPages: 2560, threads: 7, start: 500 } },
      { pid: 200, name: "nginx", cmd: "nginx: master", cgroup: "0::/system.slice/nginx.service\n", uid: 0 },
      { pid: 300, name: "conmon", cmd: "conmon --api-version 1", cgroup: "0::/user.slice/user-1005.slice/session-3.scope\n", uid: 0 },
    ]);
    // pid 100 uses 20 more ticks while it is watched
    setTimeout(() => void writeFile(`${root}/100/stat`, stat(100, "node", { ticks: 120, rssPages: 2560, threads: 7, start: 500 })), 40);
    const r = await listProcesses({ procRoot: root, sampleMs: 200, appUsers: new Set(["shop"]) });

    expect(r.memTotal).toBe(8000000 * 1024);
    expect(r.uptimeSeconds).toBe(1235);
    const byPid = Object.fromEntries(r.processes.map((p) => [p.pid, p]));
    expect(byPid[100]).toMatchObject({ name: "node", command: "node server.mjs --port 3100", state: "S", ppid: 1, rss: 2560 * 4096, threads: 7, starttime: 500, unit: "freighter-shop--web--r1.service", managed: { kind: "app", app: "shop", service: "web" }, kernel: false });
    expect(byPid[100]!.startedMs).toBe(1700000000000 + 5000);
    expect(byPid[100]!.cpu).toBeGreaterThan(30); // 0.2 s of CPU in about 0.2 s
    expect(byPid[100]!.cpu).toBeLessThan(150);
    expect(byPid[200]).toMatchObject({ managed: null, unit: null, cpu: 0 });
    expect(byPid[2]).toMatchObject({ kernel: true, command: "[kthreadd]" });
  });

  it("takes the processes of an app's user (a container) as that app's", async () => {
    const root = await fakeProc([{ pid: 300, name: "grafana", cmd: "grafana server", cgroup: "0::/user.slice/user-1005.slice/libpod-abc.scope\n", uid: 1005 }]);
    const r = await listProcesses({ procRoot: root, sampleMs: 10, appUsers: new Set(["1005"]) });
    expect(r.processes[0]!.managed).toEqual({ kind: "app", app: "1005", service: null });
  });
});

describe("signalProcess", () => {
  const sent: [number, string][] = [];
  const send = (pid: number, sig: NodeJS.Signals) => void sent.push([pid, sig]);
  it("signals the process it was shown, and refuses the ones that must not be touched", async () => {
    const root = await fakeProc([
      { pid: 2, name: "kthreadd", cmd: "", cgroup: "0::/\n", stat: { ppid: 0 } },
      { pid: 100, name: "node", cmd: "node", cgroup: "0::/system.slice/freighter-shop--web.service\n", stat: { start: 500 } },
      { pid: 150, name: "kworker", cmd: "", cgroup: "0::/\n", stat: { ppid: 2 } },
      { pid: 400, name: "freighter-agent", cmd: "node agent", cgroup: "0::/system.slice/freighter-agent.service\n", stat: { start: 9 } },
    ]);
    await signalProcess(100, 500, "TERM", { procRoot: root, send });
    await signalProcess(100, 500, "KILL", { procRoot: root, send });
    expect(sent).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);

    const refused = (pid: number, start: number, code: ProcessError["code"], re: RegExp) =>
      expect(signalProcess(pid, start, "TERM", { procRoot: root, send, self: 999 })).rejects.toMatchObject({ code, message: expect.stringMatching(re) });
    await refused(100, 501, "conflict", /pid was reused/);
    await refused(1, 0, "bad_request", /can't be signaled/);
    await refused(0, 0, "bad_request", /can't be signaled/);
    await refused(777, 1, "not_found", /already ended/);
    await refused(2, 1000, "bad_request", /kernel/);
    await refused(150, 1000, "bad_request", /kernel/);
    await refused(400, 9, "bad_request", /part of Freighter itself/);
    await expect(signalProcess(999, 1, "TERM", { procRoot: root, send, self: 999 })).rejects.toThrow(/the agent itself/);
    expect(sent).toHaveLength(2);
  });
});
