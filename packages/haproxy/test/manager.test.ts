import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@freighter/systemd";
import { describe, expect, it } from "vitest";
import { createHaproxy } from "../src/index.ts";

async function setup(checkCode = 0) {
  const dir = await mkdtemp(join(tmpdir(), "freighter-hap-"));
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd === "haproxy" ? { stdout: "", stderr: "[ALERT] bad config", code: checkCode } : { stdout: "", code: 0 };
  };
  const hap = createHaproxy({
    run,
    config: { dir, mainConfig: "/etc/haproxy/haproxy.cfg", bin: "haproxy", reloadCommand: ["systemctl", "reload", "haproxy"] },
  });
  return { dir, calls, hap, checkFail: checkCode !== 0 };
}
const files = (n: number) => ({ hostnameMap: `m${n}\n`, httpsMap: `h${n}\n`, backends: `b${n}\n` });

describe("haproxy manager", () => {
  it("writes files, validates the whole config, then reloads", async () => {
    const { dir, calls, hap } = await setup();
    expect(await hap.apply(files(1))).toEqual({ changed: true });
    expect(await readFile(`${dir}/hostnames.map`, "utf8")).toBe("m1\n");
    expect(calls).toEqual([
      ["haproxy", "-c", "-f", "/etc/haproxy/haproxy.cfg", "-f", `${dir}/backends.cfg`],
      ["systemctl", "reload", "haproxy"],
    ]);
    expect((await readdir(dir)).sort()).toEqual(["backends.cfg", "certs", "hostnames.map", "https.map"]);
  });

  it("does nothing when the files are unchanged", async () => {
    const { calls, hap } = await setup();
    await hap.apply(files(1));
    calls.length = 0;
    expect(await hap.apply(files(1))).toEqual({ changed: false });
    expect(calls).toEqual([]);
  });

  it("restores the previous files and does not reload when the check fails", async () => {
    const good = await setup();
    await good.hap.apply(files(1));
    // same dir, but now the check fails
    const calls: string[][] = [];
    const run: Run = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "[ALERT] bad config", code: cmd === "haproxy" ? 1 : 0 };
    };
    const hap = createHaproxy({
      run,
      config: { dir: good.dir, mainConfig: "/m", bin: "haproxy", reloadCommand: ["systemctl", "reload", "haproxy"] },
    });
    await expect(hap.apply(files(2))).rejects.toThrow(/config check failed.*bad config/);
    expect(await readFile(`${good.dir}/backends.cfg`, "utf8")).toBe("b1\n");
    expect(calls.some((c) => c[0] === "systemctl")).toBe(false);
  });

  it("removes files that did not exist before when the first check fails", async () => {
    const { dir, hap } = await setup(1);
    await expect(hap.apply(files(1))).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(["certs"]);
  });

  it("surfaces reload failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "freighter-hap-"));
    const run: Run = async (cmd) => ({ stdout: "", stderr: "nope", code: cmd === "systemctl" ? 3 : 0 });
    const hap = createHaproxy({ run, config: { dir, mainConfig: "/m", bin: "haproxy", reloadCommand: ["systemctl", "reload", "haproxy"] } });
    await expect(hap.apply(files(1))).rejects.toThrow(/reload failed.*nope/);
    await writeFile(`${dir}/x`, "");
  });
});
