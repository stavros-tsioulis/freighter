import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemd, defaultLayout, type Run } from "../src/index.ts";

function fake(stdout = "", code = 0) {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout, code };
  };
  return { calls, run };
}

describe("createSystemd", () => {
  it("installs atomically then reloads", async () => {
    const unitDir = await mkdtemp(join(tmpdir(), "freighter-"));
    const { calls, run } = fake();
    const sd = createSystemd({ run, layout: { ...defaultLayout, unitDir } });
    await sd.installUnit("freighter-a-b.service", "[Unit]\n");
    expect(await readFile(join(unitDir, "freighter-a-b.service"), "utf8")).toBe("[Unit]\n");
    expect(await readdir(unitDir)).toEqual(["freighter-a-b.service"]);
    expect(calls).toEqual([["systemctl", "daemon-reload"]]);
  });
  it("runs lifecycle verbs", async () => {
    const { calls, run } = fake();
    const sd = createSystemd({ run });
    await sd.restart("freighter-a-b.service");
    expect(calls).toEqual([["systemctl", "restart", "freighter-a-b.service"]]);
  });
  it("parses status", async () => {
    const { run } = fake("ActiveState=active\nSubState=running\nMainPID=42\nMemoryCurrent=1024\nNRestarts=2\nCPUUsageNSec=5000000\n");
    expect(await createSystemd({ run }).status("freighter-a-b.service")).toEqual({
      activeState: "active",
      subState: "running",
      mainPid: 42,
      memoryCurrent: 1024,
      restarts: 2,
      cpuNanos: 5000000,
    });
  });
  it("handles unset memory accounting", async () => {
    const { run } = fake("ActiveState=inactive\nSubState=dead\nMainPID=0\nMemoryCurrent=[not set]\nNRestarts=0\n");
    const st = await createSystemd({ run }).status("freighter-a-b.service");
    expect(st.memoryCurrent).toBeNull();
    expect(st.cpuNanos).toBeNull();
    const off = fake("ActiveState=active\nSubState=running\nMainPID=1\nMemoryCurrent=1\nNRestarts=0\nCPUUsageNSec=18446744073709551615\n").run;
    expect((await createSystemd({ run: off }).status("freighter-a-b.service")).cpuNanos).toBeNull();
  });
  it("validates names before running anything", async () => {
    const { calls, run } = fake();
    const sd = createSystemd({ run });
    await expect(sd.stop("sshd.service")).rejects.toThrow(/invalid unit name/);
    expect(() => sd.logsArgs("../x")).toThrow();
    expect(calls).toEqual([]);
  });
  it("throws on non-zero exit and builds journalctl args", async () => {
    const { run } = fake("", 5);
    const sd = createSystemd({ run });
    await expect(sd.start("freighter-a-b.service")).rejects.toThrow(/exit code 5/);
    expect(sd.logsArgs("freighter-a-b.service", { lines: 20, follow: true })).toEqual([
      "-u", "freighter-a-b.service", "-n", "20", "--no-pager", "-f",
    ]);
  });
});
