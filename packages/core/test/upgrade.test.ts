import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdates, checkoutCommit, checkoutCommitFull, commitFromEnv, confirmUpgrade, findInstallDir, haproxyMode, renderUpgradeScript, startUpgrade, upgradeStatus, validRef } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A "server": origin repo with an old and a new version of the installer, a checkout of the old one, a fake systemctl. */
async function server(installer: { good: string; bad: string }, installed = "#!/bin/sh\n# old installer\n") {
  const root = await mkdtemp(join(tmpdir(), "freighter-up-"));
  const origin = `${root}/origin`;
  mkdirSync(`${origin}/infra`, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(`${origin}/infra/install.sh`, installed);
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
  const run = (ref: string, confirmSeconds = 30, withContainers = false) => {
    mkdirSync(`${root}/state`, { recursive: true });
    writeFileSync(
      `${root}/upgrade.sh`,
      renderUpgradeScript({ stateDir: `${root}/state`, installDir: dir, ref, haproxy: "dedicated", haproxyMain: `${root}/haproxy.cfg`, haproxyReload: ["systemctl", "reload", "x"], confirmSeconds, withContainers }),
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
    execFileSync("sh", ["-n"], { input: renderUpgradeScript({ stateDir: "/s", installDir: "/opt", ref: "main", haproxy: "existing", haproxyMain: "/m", haproxyReload: ["x"], confirmSeconds: 1, withContainers: true }) });
    expect(script).toContain("WITH_CONTAINERS=0");
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

  it("adds container support at the installed version: same commit, installer run with --with-containers", async () => {
    // The installer that is already installed is the one that runs; it just records how it was called.
    const s = await server({ good: installs("NEW"), bad: installs("NEW") }, `#!/bin/sh\necho "$@" >"$(dirname "$0")/args.log"\n`);
    const done = s.run("good", 30, true); // the ref is ignored: adding Podman is not an upgrade
    await s.waitState("verifying");
    writeFileSync(`${s.root}/state/confirmed`, "ok\n");
    expect(await done).toBe(0);
    expect(s.read("state/state")).toBe("done");
    expect(s.read("state/message")).toMatch(/Container support added/);
    expect(s.read("state/ref")).toBe(s.old);
    expect(s.read("state/to")).toBe(s.old);
    expect(git(s.dir, "rev-parse", "HEAD")).toBe(s.old);
    expect(s.read("state/args.log")).toBe(`--role agent --ref ${s.old} --dir ${s.dir} --haproxy dedicated --with-containers`);
  });

  it("rolls back when the new installer fails halfway", async () => {
    const s = await server({ good: installs("NEW"), bad: `${installs("HALF")}exit 1\n` });
    expect(await s.run("bad")).toBe(1);
    expect(s.read("state/state")).toBe("rolled-back");
    expect(s.read("state/message")).toMatch(/installer failed/);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("OLD");
    expect(readFileSync(`${s.units}/freighter-agent.service`, "utf8").trim()).toBe("OLD unit");
  });

  it("upgrades to a commit given in full, and to one given as the short hash the dashboard shows", async () => {
    for (const abbreviate of [false, true]) {
      const s = await server({ good: installs("NEW"), bad: installs("NEW") });
      const tip = git(`${s.root}/origin`, "rev-parse", "good");
      const done = s.run(abbreviate ? tip.slice(0, 12) : tip);
      await s.waitState("verifying");
      writeFileSync(`${s.root}/state/confirmed`, "ok\n");
      expect(await done, abbreviate ? "short hash" : "full hash").toBe(0);
      expect(s.read("state/state")).toBe("done");
      expect(s.read("state/to")).toBe(tip);
      expect(s.read("state/ref")).toBe(tip); // the abbreviation was resolved, and the installer got the full hash
      expect(s.read("opt/apps/agent/dist/main.js")).toBe("NEW");
      expect(git(s.dir, "for-each-ref", "refs/freighter-resolve")).toBe(""); // nothing left behind
    }
  });

  it("says what git said when a commit can't be found, instead of only that it couldn't be fetched", async () => {
    const s = await server({ good: installs("NEW"), bad: installs("NEW") });
    expect(await s.run("deadbeefcafe")).toBe(1);
    expect(s.read("state/state")).toBe("failed");
    expect(s.read("state/message")).toMatch(/Could not fetch deadbeefcafe.*nothing was changed.*git said: .*(couldn't find remote ref|not our ref|deadbeefcafe)/);
    expect(s.read("opt/apps/agent/dist/main.js")).toBe("OLD");
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

  it("starts a new run from nothing: the previous run's log, versions and result are gone", async () => {
    const upgradeDir = (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up";
    const t = await makeDeps({ config: { agent: { upgradeDir } } });
    t.deps.installDir = t.root;
    mkdirSync(upgradeDir, { recursive: true });
    for (const [f, v] of Object.entries({ state: "done", from: "aaa", to: "bbb", message: "Upgraded from aaa to bbb", log: "[x] old run output\n", confirmed: "ok" })) writeFileSync(`${upgradeDir}/${f}`, `${v}\n`);
    await startUpgrade(t.deps, "main", "abc");
    expect(readFileSync(`${upgradeDir}/log`, "utf8")).toBe("");
    for (const f of ["from", "to", "confirmed"]) expect(existsSync(`${upgradeDir}/${f}`), f).toBe(false);
    const s = await upgradeStatus(t.deps, "abc");
    expect(s.log).toBe("");
    expect(s.upgrade).toMatchObject({ state: "running", from: null, to: null, message: "Starting" });
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
    expect(await checkoutCommitFull(s.dir)).toBe(s.old);
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

  it("tells the installer which HAProxy it is, so it never switches a server from one kind to the other", async () => {
    const upgradeDir = (await mkdtemp(join(tmpdir(), "freighter-us-"))) + "/up";
    const t = await makeDeps({ config: { agent: { upgradeDir }, haproxy: { dir: `${upgradeDir}/hap` } } });
    t.deps.installDir = t.root;
    mkdirSync(`${upgradeDir}/hap`, { recursive: true });
    writeFileSync(`${upgradeDir}/hap/mode`, "existing\n");
    expect((await upgradeStatus(t.deps, "abc")).haproxy).toEqual({ mode: "existing" });
    await startUpgrade(t.deps, "main", "abc");
    expect(readFileSync(`${upgradeDir}/upgrade.sh`, "utf8")).toContain("MODE='existing'");
    writeFileSync(`${upgradeDir}/hap/mode`, "dedicated\n");
    expect((await upgradeStatus(t.deps, "abc")).haproxy).toEqual({ mode: "dedicated" });
  });

  it("treats a missing git binary as 'not a checkout' instead of failing (a container image has none)", async () => {
    const noGit = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const exec = async () => {
      throw noGit;
    };
    expect(await findInstallDir(process.argv[1], exec)).toBeNull();
    expect(await checkoutCommit("/app", exec)).toBeNull();
  });

  it("takes the control plane's commit from the environment when there is no checkout", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect(commitFromEnv({ FREIGHTER_COMMIT: full })).toBe(full); // kept whole: a server can only fetch the full hash
    expect(commitFromEnv({ RAILWAY_GIT_COMMIT_SHA: "ABCDEF0123456789" })).toBe("abcdef0123456789");
    expect(commitFromEnv({ FREIGHTER_COMMIT: "main", RAILWAY_GIT_COMMIT_SHA: "0123456789abcdef" })).toBe("0123456789abcdef");
    expect(commitFromEnv({ FREIGHTER_COMMIT: "not a sha" })).toBeNull();
    expect(commitFromEnv({})).toBeNull();
  });

  describe("checking for updates with the server's own git", () => {
    it("reports up to date, behind (with what's new), and ahead", async () => {
      const s = await server({ good: installs("NEW"), bad: installs("NEW") });
      const same = await checkForUpdates(s.deps, "main");
      expect(same).toMatchObject({ ref: "main", state: "up-to-date", behind: 0, commits: [] });
      expect(same.installed?.commit).toBe(s.old);

      // two new commits land on origin's main
      const origin = `${s.root}/origin`;
      for (const n of ["one", "two"]) {
        writeFileSync(`${origin}/${n}.txt`, n);
        git(origin, "add", ".");
        git(origin, "commit", "-qm", `feature ${n}`);
      }
      const behind = await checkForUpdates(s.deps, "main");
      expect(behind).toMatchObject({ state: "behind", behind: 2 });
      expect(behind.commits.map((c) => c.subject)).toEqual(["feature two", "feature one"]);
      expect(behind.latest.subject).toBe("feature two");
      expect(behind.installed?.commit).toBe(s.old); // the checkout itself is untouched
      expect(git(s.dir, "rev-parse", "HEAD")).toBe(s.old);

      // a branch that's a sibling of what's installed
      expect((await checkForUpdates(s.deps, "good")).state).toBe("behind");
      git(origin, "checkout", "-q", "-b", "side", s.old);
      writeFileSync(`${origin}/side.txt`, "x");
      git(origin, "add", ".");
      git(origin, "commit", "-qm", "side");
      expect((await checkForUpdates(s.deps, "side")).state).toBe("behind");
      git(origin, "checkout", "-q", "main");

      // after installing main's newest commit: up to date with main, ahead of an older branch, unrelated to a sibling
      git(origin, "branch", "stale", s.old);
      git(s.dir, "fetch", "-q", "--depth", "1", "origin", "main");
      git(s.dir, "checkout", "-q", "--force", "FETCH_HEAD");
      expect((await checkForUpdates(s.deps, "main")).state).toBe("up-to-date");
      expect((await checkForUpdates(s.deps, "stale")).state).toBe("ahead");
      expect((await checkForUpdates(s.deps, "side")).state).toBe("different");
    });

    it("says why it can't, without changing anything", async () => {
      const s = await server({ good: installs("NEW"), bad: installs("NEW") });
      await expect(checkForUpdates(s.deps, "nope")).rejects.toThrow(/could not fetch nope from origin/);
      await expect(checkForUpdates(s.deps, "--evil")).rejects.toThrow(/invalid ref/);
      const t = await makeDeps();
      await expect(checkForUpdates(t.deps, "main")).rejects.toThrow(/not installed by the installer/);
      mkdirSync(`${s.root}/state`, { recursive: true });
      writeFileSync(`${s.root}/state/state`, "running\n");
      await expect(checkForUpdates(s.deps, "main")).rejects.toThrow(/upgrade is in progress/);
    });
  });
});
