import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutCommit, confirmUpgrade, haproxyMode, renderUpgradeScript, startUpgrade, upgradeStatus, validRef } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A "server": origin repo with an old and a new version of the installer, a checkout of the old one, a fake systemctl. */
async function server(installer: { good: string; bad: string }) {
  const root = await mkdtemp(join(tmpdir(), "freighter-up-"));
  const origin = `${root}/origin`;
  mkdirSync(`${origin}/infra`, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(`${origin}/infra/install.sh`, "#!/bin/sh\n# old installer\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "old");
  const old = git(origin, "rev-parse", "HEAD");
  // `good`: the new version installs; `bad`: its installer fails halfway, after replacing the built agent.
  for (const [branch, script] of [["good", installer.good], ["bad", installer.bad]] as const) {
    git(origin, "checkout", "-q", "-b", branch, "main");
    writeFileSync(`${origin}/infra/install.sh`, script);
    git(origin, "commit", "-qam", branch);
  }
  git(origin, "checkout", "-q", "main");

  const dir = `${root}/opt`;
  git(root, "clone", "-q", "--depth", "1", `file://${origin}`, dir);
  for (const [app, file] of [["agent", "main.js"], ["cli", "cli.js"]]) {
    mkdirSync(`${dir}/apps/${app}/dist`, { recursive: true });
    writeFileSync(`${dir}/apps/${app}/dist/${file}`, "OLD\n");
  }
  const units = `${root}/units`;
  mkdirSync(units);
  writeFileSync(`${units}/freighter-agent.service`, "OLD unit\n");
  const bin = `${root}/bin`;
  mkdirSync(bin);
  writeFileSync(`${bin}/systemctl`, `#!/bin/sh\necho "systemctl $*" >>"${root}/systemctl.log"\nexit 0\n`);
  chmodSync(`${bin}/systemctl`, 0o755);

  const t = await makeDeps({ config: { agent: { upgradeDir: `${root}/state` } } });
  t.deps.installDir = dir;
  const run = (ref: string, confirmSeconds = 30) => {
    mkdirSync(`${root}/state`, { recursive: true });
    writeFileSync(
      `${root}/upgrade.sh`,
      renderUpgradeScript({ stateDir: `${root}/state`, installDir: dir, ref, haproxy: "dedicated", haproxyMain: `${root}/haproxy.cfg`, haproxyReload: ["systemctl", "reload", "x"], confirmSeconds }),
    );
    const child = spawn("sh", [`${root}/upgrade.sh`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FREIGHTER_UNIT_DIR: units, FREIGHTER_POLL_SECONDS: "1" },
      stdio: "ignore",
    });
    return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  };
  const read = (p: string) => readFileSync(`${root}/${p}`, "utf8").trim();
  const waitState = async (want: string) => {
    for (let i = 0; i < 200 && !(existsSync(`${root}/state/state`) && read("state/state") === want); i++) await sleep(50);
  };
  return { ...t, root, dir, old, units, run, read, waitState };
}

// What the real installer leaves behind: the new commit checked out, the agent rebuilt, a unit updated.
const installs = (marker: string) => `#!/bin/sh
while [ $# -gt 0 ]; do case $1 in --dir) DIR=$2; shift 2;; *) shift;; esac; done
git -C "$DIR" checkout --quiet --force FETCH_HEAD
echo ${marker} >"$DIR/apps/agent/dist/main.js"
echo ${marker} >"$DIR/apps/cli/dist/cli.js"
echo "${marker} unit" >"$FREIGHTER_UNIT_DIR/freighter-agent.service"
`;

describe("renderUpgradeScript", () => {
  it("is valid shell, and quotes whatever it is given", () => {
    const script = renderUpgradeScript({ stateDir: "/s", installDir: "/o'pt", ref: "v1.2", haproxy: "existing", haproxyMain: "/etc/haproxy/haproxy.cfg", haproxyReload: ["systemctl", "reload", "haproxy"], confirmSeconds: 180 });
    execFileSync("sh", ["-n"], { input: script });
    expect(script).toContain(`DIR='/o'\\''pt'`);
    expect(script).toContain('--haproxy "$MODE"');
  });
  it("accepts branches, tags and commits, and nothing that could be an option or a path trick", () => {
    for (const ok of ["main", "v1.2.3", "release/2026-11", "a".repeat(40)]) expect(validRef(ok), ok).toBe(true);
    for (const bad of ["", "-x", "--upload-pack=sh", "a..b", "a b", "a;b", "$(id)", "a".repeat(101)]) expect(validRef(bad), bad).toBe(false);
  });
});

describe("the upgrade script on a fake server", () => {
  it("installs the new version, waits for the control plane's confirmation, and finishes", async () => {
    const s = await server({ good: installs("NEW"), bad: installs("NEW") });
    const done = s.run("good");
    await s.waitState("verifying");
    expect(s.read("state/message")).toMatch(/Waiting for the control plane/);
    expect(s.read("state/from")).toBe(s.old);
    writeFileSync(`${s.root}/state/confirmed`, "ok\n");
    expect(await done).toBe(0);
    expect(s.read("state/state")).toBe("done");
    expect(s.read("state/to")).not.toBe(s.old);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("NEW");
  });

  it("puts the old version back when the control plane never confirms", async () => {
    const s = await server({ good: installs("NEW"), bad: installs("NEW") });
    expect(await s.run("good", 2)).toBe(1);
    expect(s.read("state/state")).toBe("rolled-back");
    expect(s.read("state/message")).toMatch(/did not confirm.*Restored/);
    expect(git(s.dir, "rev-parse", "HEAD")).toBe(s.old);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("OLD");
    expect(s.read("opt/apps/cli/dist/cli.js")).toBe("OLD");
    expect(readFileSync(`${s.units}/freighter-agent.service`, "utf8").trim()).toBe("OLD unit");
    expect(readFileSync(`${s.root}/systemctl.log`, "utf8")).toContain("systemctl restart freighter-agent");
  });

  it("rolls back when the new installer fails halfway", async () => {
    const s = await server({ good: installs("NEW"), bad: `${installs("HALF")}exit 1\n` });
    expect(await s.run("bad")).toBe(1);
    expect(s.read("state/state")).toBe("rolled-back");
    expect(s.read("state/message")).toMatch(/installer failed/);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("OLD");
    expect(readFileSync(`${s.units}/freighter-agent.service`, "utf8").trim()).toBe("OLD unit");
  });

  it("changes nothing when the ref can't be fetched", async () => {
    const s = await server({ good: installs("NEW"), bad: installs("NEW") });
    expect(await s.run("nope")).toBe(1);
    expect(s.read("state/state")).toBe("failed");
    expect(s.read("state/message")).toMatch(/Could not fetch nope.*nothing was changed/);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("OLD");
    expect(existsSync(`${s.root}/systemctl.log`)).toBe(false); // the running agent was never touched
  });
});

describe("agent side of an upgrade", () => {
  it("won't start unless it is a root-run installer checkout, with a sane ref, one at a time", async () => {
    const t = await makeDeps({ config: { agent: { upgradeDir: (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up" } } });
    await expect(startUpgrade(t.deps, "main", null)).rejects.toThrow(/not installed by the installer/);
    t.deps.installDir = t.root;
    await expect(startUpgrade(t.deps, "--evil", null)).rejects.toThrow(/invalid ref/);
    await startUpgrade(t.deps, "v1.0.0", "abc");
    const launch = t.calls.find((c) => c[0] === "systemd-run")!;
    expect(launch).toEqual(expect.arrayContaining(["--unit=freighter-upgrade", "--collect", "/bin/sh"]));
    expect(readFileSync(launch.at(-1)!, "utf8")).toContain("REF='v1.0.0'");
    await expect(startUpgrade(t.deps, "v1.0.0", "abc")).rejects.toThrow(/already in progress/);
    t.deps.isRoot = false;
    await expect(startUpgrade(t.deps, "main", null)).rejects.toThrow(/root/);
  });

  it("reports an upgrade whose unit has vanished as failed, and only confirms a verifying one", async () => {
    const upgradeDir = (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up";
    const t = await makeDeps({ config: { agent: { upgradeDir } } });
    t.deps.installDir = t.root;
    mkdirSync(upgradeDir, { recursive: true });
    writeFileSync(`${upgradeDir}/state`, "verifying\n");
    expect((await upgradeStatus(t.deps, "abc")).upgrade?.state).toBe("verifying");
    expect(await confirmUpgrade(t.deps)).toBe(true);
    expect(existsSync(`${upgradeDir}/confirmed`)).toBe(true);
    writeFileSync(`${upgradeDir}/state`, "done\n");
    expect(await confirmUpgrade(t.deps)).toBe(false);

    const real = t.deps.run;
    t.deps.run = async (cmd, args, o) => (cmd === "systemctl" && args[0] === "is-active" ? { stdout: "", code: 3 } : real(cmd, args, o));
    writeFileSync(`${upgradeDir}/state`, "running\n");
    const st = await upgradeStatus(t.deps, "abc");
    expect(st.upgrade).toMatchObject({ state: "failed", message: expect.stringMatching(/interrupted/) });
    await expect(startUpgrade(t.deps, "main", null)).resolves.toBeUndefined(); // a dead upgrade doesn't block the next one
  });

  it("reads the checked-out commit", async () => {
    const s = await server({ good: installs("NEW"), bad: installs("NEW") });
    expect(await checkoutCommit(s.dir)).toBe(s.old.slice(0, 12));
    expect(await checkoutCommit(s.root)).toBeNull();
    expect(await checkoutCommit(null)).toBeNull();
  });

  it("knows whose HAProxy it is from what the installer recorded, and guesses for older installs", async () => {
    const t = await makeDeps({ config: { agent: { upgradeDir: (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up" } } });
    t.deps.installDir = t.root;
    // not recorded (installed before it was): a main config outside Freighter's directory means the operator's own
    expect(await haproxyMode(t.deps)).toBe("existing");
    t.deps.config.haproxy.mainConfig = "/etc/freighter/haproxy/haproxy.cfg";
    expect(await haproxyMode(t.deps)).toBe("dedicated");
    // recorded: that wins, wherever the config is
    mkdirSync(t.deps.config.haproxy.dir, { recursive: true });
    writeFileSync(`${t.deps.config.haproxy.dir}/mode`, "existing\n");
    expect(await haproxyMode(t.deps)).toBe("existing");
    writeFileSync(`${t.deps.config.haproxy.dir}/mode`, "nonsense\n");
    expect(await haproxyMode(t.deps)).toBe("dedicated");
  });

  it("hands the operator their instructions only when the HAProxy is theirs, and tells the installer which it is", async () => {
    const upgradeDir = (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up";
    const t = await makeDeps({ config: { agent: { upgradeDir }, haproxy: { dir: `${upgradeDir}/hap`, httpPort: 8080, httpsPort: 8443, trustCloudflare: true } } });
    t.deps.installDir = t.root;
    mkdirSync(`${upgradeDir}/hap`, { recursive: true });
    writeFileSync(`${upgradeDir}/hap/mode`, "existing\n");
    const mine = await upgradeStatus(t.deps, "abc");
    expect(mine.haproxy.mode).toBe("existing");
    expect(mine.haproxy.instructions).toMatch(/:8080 and in the one listening on :8443/);
    expect(mine.haproxy.instructions).toContain("CF-Connecting-IP");
    await startUpgrade(t.deps, "main", "abc");
    expect(readFileSync(`${upgradeDir}/upgrade.sh`, "utf8")).toContain("MODE='existing'");

    writeFileSync(`${upgradeDir}/hap/mode`, "dedicated\n");
    const ours = await upgradeStatus(t.deps, "abc");
    expect(ours.haproxy).toEqual({ mode: "dedicated", instructions: null });
  });
});
