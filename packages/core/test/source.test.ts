import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BuildFailedError, getConfig, setConfig, buildLogChunk, buildLogPath, currentRelease, gitDeploy, readHistory, sandboxArgs, type Deps } from "../src/index.ts";
import { APP_YAML, makeRepo } from "./gitrepo.ts";
import { writeConnections, writeDomains, resolveBuildEnvironment } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const BUILD = `build:\n  commands:\n    - echo built > BUILT\n    - cat server.mjs > COPIED\n`;

async function setup(files?: Record<string, string>) {
  const h = await makeDeps();
  h.deps.dev = true; // builds run directly (no systemd in the test process)
  const repo = await makeRepo(files ?? { "app.yaml": APP_YAML("shop", "") + BUILD, "server.mjs": "// v1\n" });
  const run = (over: Partial<Parameters<typeof gitDeploy>[1]> = {}) =>
    gitDeploy(h.deps, { app: "shop", buildId: id(), repository: repo.url, branch: "main", ...over });
  return { ...h, repo, run };
}
const releaseOf = (d: Deps, rel: string) => `${d.layout.appsRoot}/shop/releases/${rel}`;

describe("gitDeploy", () => {
  it("fetches, builds and deploys a commit, recording where it came from", async () => {
    const t = await setup();
    const buildId = id();
    const r = await t.run({ buildId });
    expect(r.skipped).toBe(false);
    if (r.skipped) return;

    expect(r.commit).toMatchObject({ sha: t.repo.first, subject: "initial commit", author: "Ada Dev" });
    const rel = releaseOf(t.deps, r.deploy.releaseId);
    expect(await readFile(`${rel}/BUILT`, "utf8")).toBe("built\n"); // the build output is part of the release
    expect(await readFile(`${rel}/COPIED`, "utf8")).toBe("// v1\n");
    expect(JSON.parse(await readFile(`${rel}/.freighter-source.json`, "utf8"))).toMatchObject({ type: "git", sha: t.repo.first, ref: "refs/heads/main" });

    const hist = await readHistory(t.deps, "shop");
    expect(hist.at(-1)).toMatchObject({ action: "deploy", result: "success", source: { sha: t.repo.first, subject: "initial commit" } });
    expect(await currentRelease(t.deps, "shop")).toBe(r.deploy.releaseId);

    expect(existsSync(`${t.deps.config.git.buildDir}/${buildId}`)).toBe(false); // build dir removed
    const log = await readFile(buildLogPath(t.deps, buildId), "utf8"); // log kept for the UI
    expect(log).toContain("fetching main");
    expect(log).toContain("build finished");
    expect(log).toContain(`deployed ${r.deploy.releaseId}`);
  });

  it("skips an unchanged head when asked, but redeploys after a new commit", async () => {
    const t = await setup();
    await t.run();
    const again = await t.run({ skipIfUnchanged: true });
    expect(again).toMatchObject({ skipped: true, commit: { sha: t.repo.first } });
    expect(await readdir(`${t.deps.layout.appsRoot}/shop/releases`)).toHaveLength(1);

    const second = await t.repo.commit({ "server.mjs": "// v2\n" }, "second");
    const r = await t.run({ skipIfUnchanged: true });
    expect(r.skipped).toBe(false);
    expect(r.commit.sha).toBe(second);
    const forced = await t.run({ skipIfUnchanged: false }); // a manual "deploy latest" always deploys
    expect(forced.skipped).toBe(false);
  });

  it("does not touch the running release when the build fails, and keeps the log", async () => {
    const t = await setup({ "app.yaml": APP_YAML("shop", "") + "build:\n  commands:\n    - echo compiling\n    - exit 3\n", "server.mjs": "//\n" });
    const ok = await t.run({ fallbackManifest: APP_YAML("shop", "") });
    if (ok.skipped) throw new Error("unexpected");
    await t.repo.commit({ "BREAK": "x" }, "break the build");
    await setConfig(t.deps, "shop", APP_YAML("shop", "") + "build:\n  commands:\n    - echo compiling\n    - test ! -f BREAK\n", { skipVerify: true });
    const running = await currentRelease(t.deps, "shop");

    const buildId = id();
    const err = await t.run({ buildId }).catch((e) => e);
    expect(err).toBeInstanceOf(BuildFailedError);
    expect(err.message).toBe("build failed with exit code 1");
    expect(err.logTail).toContain("compiling");
    expect(await currentRelease(t.deps, "shop")).toBe(running); // still the old release
    expect(await readdir(`${t.deps.layout.appsRoot}/shop/releases`)).toHaveLength(2);
    expect(existsSync(`${t.deps.config.git.buildDir}/${buildId}`)).toBe(false);
    expect(await readFile(buildLogPath(t.deps, buildId), "utf8")).toContain("build failed with exit code 1");
  });

  it("keeps the settings of an app whose first build fails, so they can be fixed", async () => {
    const t = await setup({ "server.mjs": "//\n" });
    const fallback = APP_YAML("shop", "") + "build:\n  commands:\n    - exit 1\n";
    const err = await t.run({ fallbackManifest: fallback }).catch((e) => e);
    expect(err).toBeInstanceOf(BuildFailedError);
    expect(await getConfig(t.deps, "shop")).toContain("exit 1");
    expect(await currentRelease(t.deps, "shop")).toBeNull();
  });

  it("stops a build that runs past its time limit", async () => {
    const t = await setup({ "app.yaml": APP_YAML("shop", "") + "build:\n  timeout: 1s\n  commands:\n    - sleep 20\n", "server.mjs": "//\n" });
    const err = await t.run().catch((e) => e);
    expect(err).toBeInstanceOf(BuildFailedError);
    expect(err.message).toBe("build timed out after 1s");
  });

  it("deploys repositories without a build step", async () => {
    const t = await setup({ "app.yaml": APP_YAML(), "server.mjs": "//\n" });
    const r = await t.run();
    expect(r.skipped).toBe(false);
    if (!r.skipped) expect(r.buildSeconds).toBe(0);
  });

  it("rejects a manifest for another app, a missing manifest, and an invalid one", async () => {
    const other = await setup({ "app.yaml": APP_YAML("blog"), "server.mjs": "//\n" });
    await expect(other.run()).rejects.toThrow(/app.yaml is for "blog" but this app is "shop"/);
    const none = await setup({ "server.mjs": "//\n" });
    await expect(none.run()).rejects.toThrow(/app.yaml not found at the root of the repository, and no settings/);
    const bad = await setup({ "app.yaml": "name: shop\nservices: {}\nbuild: nope\n", "server.mjs": "//\n" });
    await expect(bad.run()).rejects.toThrow();
    for (const t of [other, none, bad]) expect(await readdir(t.deps.config.git.buildDir).then((f) => f.filter((x) => !x.endsWith(".log") && x !== "cache"))).toEqual([]);
  });

  it("starts a new app from the settings entered in Freighter, or else from app.yaml, and then keeps its own configuration", async () => {
    const fallback = APP_YAML("shop", "") + BUILD;
    const none = await setup({ "server.mjs": "// v1\n" });
    const buildId = id();
    const r = await none.run({ buildId, fallbackManifest: fallback });
    expect(r.skipped).toBe(false);
    if (!r.skipped) {
      expect(existsSync(`${releaseOf(none.deps, r.deploy.releaseId)}/BUILT`)).toBe(true); // its build commands ran
      expect(await readFile(buildLogPath(none.deps, buildId), "utf8")).toMatch(/settings entered in Freighter/);
    }
    // the form's values win over the file in the repository, which only fills the form in
    const has = await setup({ "app.yaml": APP_YAML("shop"), "server.mjs": "//\n" });
    const r2 = await has.run({ fallbackManifest: fallback });
    if (!r2.skipped) expect(existsSync(`${releaseOf(has.deps, r2.deploy.releaseId)}/BUILT`)).toBe(true);
    // without them the file starts the app
    const file = await setup({ "app.yaml": APP_YAML("shop", "") + BUILD, "server.mjs": "//\n" });
    const r3 = await file.run();
    if (!r3.skipped) expect(existsSync(`${releaseOf(file.deps, r3.deploy.releaseId)}/BUILT`)).toBe(true);
    // afterwards the repository's app.yaml (here a different one) and the settings given with the link are not read
    await file.repo.commit({ "app.yaml": APP_YAML("shop"), "server.mjs": "// v2\n" }, "drop the build");
    const buildId2 = id();
    const r4 = await file.run({ buildId: buildId2, fallbackManifest: APP_YAML("shop", "") });
    if (!r4.skipped) expect(existsSync(`${releaseOf(file.deps, r4.deploy.releaseId)}/BUILT`)).toBe(true);
    expect(await readFile(buildLogPath(file.deps, buildId2), "utf8")).toMatch(/configuration kept in Freighter/);
    // the settings are held to the app's name
    await expect((await setup({ "server.mjs": "//\n" })).run({ fallbackManifest: APP_YAML("blog") })).rejects.toThrow(/is for "blog" but this app is "shop"/);
  });

  it("deploys a subdirectory of a monorepo", async () => {
    const t = await setup({ "apps/web/app.yaml": APP_YAML(), "apps/web/server.mjs": "// web\n", "apps/api/app.yaml": APP_YAML("api") });
    const r = await t.run({ subpath: "apps/web" });
    expect(r.skipped).toBe(false);
    if (!r.skipped) expect(existsSync(`${releaseOf(t.deps, r.deploy.releaseId)}/server.mjs`)).toBe(true);
  });

  it("refuses unsafe inputs before doing anything", async () => {
    const t = await setup();
    await expect(t.run({ repository: "--upload-pack=x" })).rejects.toThrow();
    await expect(t.run({ branch: "-x" })).rejects.toThrow(/invalid branch/);
    await expect(t.run({ subpath: "../x" })).rejects.toThrow(/invalid subpath/);
    await expect(t.run({ buildId: "../../etc" })).rejects.toThrow(/invalid build id/);
  });

  it("reports the log in chunks and flags when the build is done", async () => {
    const t = await setup();
    const buildId = id();
    expect(await buildLogChunk(t.deps, buildId, 0)).toEqual({ text: "", next: 0, done: true });
    await t.run({ buildId });
    const all = await buildLogChunk(t.deps, buildId, 0);
    expect(all.done).toBe(true);
    expect(all.text).toContain("==> deploying");
    const rest = await buildLogChunk(t.deps, buildId, all.next - 10);
    expect(rest.text).toHaveLength(10);
    expect(await buildLogChunk(t.deps, buildId, all.next)).toMatchObject({ text: "", next: all.next });
  });
});

describe("production build sandbox", () => {
  it("runs builds as the unprivileged user in a locked-down, resource-limited transient unit", async () => {
    const t = await setup();
    t.deps.dev = false;
    const seen: { cmd: string; args: string[] }[] = [];
    t.deps.runLogged = async (cmd, args) => {
      seen.push({ cmd, args });
      return { code: 0, timedOut: false };
    };
    await t.run({ buildId: "11111111-2222-4333-8444-555555555555", skipVerify: true });

    expect(t.calls).toContainEqual(["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "freighter-build"]);
    expect(seen).toHaveLength(1);
    const { cmd, args } = seen[0]!;
    expect(cmd).toBe("systemd-run");
    expect(args).toEqual(expect.arrayContaining([
      "--wait", "--pipe", "--collect", "--uid=freighter-build", "--gid=freighter-build",
      "--property=MemoryMax=2G", "--property=CPUQuota=200%", "--property=RuntimeMaxSec=900", "--property=TasksMax=1024",
      "--property=PrivateTmp=yes", "--property=ProtectSystem=strict", "--property=NoNewPrivileges=yes", "--property=PrivateDevices=yes",
    ]));
    const inaccessible = args.find((a) => a.startsWith("--property=InaccessiblePaths="))!;
    for (const p of ["/srv/apps", "/etc/freighter", "/run/freighter", "/var/lib/freighter", "/etc/haproxy", t.deps.config.git.keyDir]) expect(inaccessible).toContain(`-${p}`);
    expect(args.find((a) => a.startsWith("--property=ReadWritePaths="))).toContain(`${t.deps.config.git.buildDir}/11111111-2222-4333-8444-555555555555/src`);
    expect(args.find((a) => a.startsWith("--working-directory="))).toContain("/src");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-ec", "set -e\necho built > BUILT\ncat server.mjs > COPIED"]);
    // secrets and other apps' data are not even named in the environment handed to the build
    expect(args.filter((a) => a.startsWith("--setenv=")).join(" ")).not.toMatch(/TOKEN|SECRET|PASSWORD/i);
  });

  it("sandboxArgs hands the build the app's build environment, but not where it keeps its files", async () => {
    const { deps } = await makeDeps();
    const args = sandboxArgs(deps, { app: "x", buildId: "abcdef12-0000-4000-8000-000000000000", dir: "/b/src", spec: { commands: ["true"], timeout: "5m", memory: "512M", cpu: 1, environment: { PUBLIC_API: "https://api.example.com", NODE_ENV: "production", HOME: "/root" } } });
    expect(args).toContain("--setenv=PUBLIC_API=https://api.example.com");
    expect(args).toContain("--setenv=NODE_ENV=production"); // a default the app may change
    expect(args).toContain(`--setenv=HOME=${deps.config.git.buildDir}/cache/x/home`); // and one it may not
    expect(args).not.toContain("--setenv=HOME=/root");
  });
  it("sandboxArgs scales limits from the manifest", async () => {
    const { deps } = await makeDeps();
    const args = sandboxArgs(deps, { app: "x", buildId: "abcdef12-0000-4000-8000-000000000000", dir: "/b/src", spec: { commands: ["true"], timeout: "5m", memory: "512M", cpu: 0.5, environment: {} } });
    expect(args).toEqual(expect.arrayContaining(["--property=MemoryMax=512M", "--property=CPUQuota=50%", "--property=RuntimeMaxSec=300", "--unit=freighter-build-abcdef12"]));
  });
});

describe("resolveBuildEnvironment", () => {
  const manifest = (env: Record<string, string>) => ({ name: "shop", services: { web: {} as never }, build: { commands: ["make"], timeout: "15m", memory: "2G", cpu: 2, environment: env } });
  it("fills in the public addresses of this app's services and of its project's other apps, from the domains as they are now", async () => {
    const { deps } = await makeDeps();
    await writeDomains(deps, "shop", [{ hostname: "shop.example.com", service: "web", tls: "auto" }]);
    await writeConnections(deps, "shop", { server: "s1", peers: { api: { name: "api", server: "s1", services: ["http"], domains: [{ hostname: "api.example.com", service: "http", tls: "off" }], ports: {}, environment: { http: {} } } } });
    const r = await resolveBuildEnvironment(deps, manifest({ SITE: "@web.url", API: "@api/http.url", HOST: "@api/http.domain", PLAIN: "x" }));
    expect(r.environment).toEqual({ SITE: "https://shop.example.com", API: "http://api.example.com", HOST: "api.example.com", PLAIN: "x" });
    expect(r.notes).toEqual([]);
  });
  it("says so when a service has no domain yet (the value is empty), and refuses what a build may not read", async () => {
    const { deps } = await makeDeps();
    const r = await resolveBuildEnvironment(deps, manifest({ SITE: "@web.url" }));
    expect(r.environment.SITE).toBe("");
    expect(r.notes[0]).toMatch(/SITE is empty: @web\.url has no domain yet/);
    await expect(resolveBuildEnvironment(deps, manifest({ X: "@ghost/api.url" }))).rejects.toThrow(/build environment: .*no app "ghost"/);
    expect((await resolveBuildEnvironment(deps, manifest({ A: "b" }))).environment).toEqual({ A: "b" });
  });
});

describe("gitDeploy of an app that also runs an image from a private registry", () => {
  it("logs in to the registry for the pull, like any other deploy", async () => {
    const yaml = "name: shop\nservices:\n  web:\n    command: node server.mjs\n  waline:\n    image: ghcr.io/me/waline:1\n";
    const t = await setup({ "app.yaml": yaml, "server.mjs": "// v1\n" });
    await t.run({ registryAuth: [{ host: "ghcr.io", username: "me", password: "ghp_secret" }] });
    const pull = t.calls.find((c) => c.includes("pull"));
    expect(pull).toBeTruthy();
    expect(pull).toContain("--authfile");
  });
});
