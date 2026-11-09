import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appStatus, controlApp, deploy, setEnv } from "../src/index.ts";
import { MANIFEST, artifact, makeDeps } from "./helpers.ts";

describe("deploy", () => {
  it("performs a first deploy", async () => {
    const { deps, calls, mutating } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    const src = await artifact();
    const r = await deploy(deps, { manifestText: MANIFEST, source: src });

    expect(r.releaseId).toBe("r20261106-134500");
    expect(r.units).toEqual(["freighter-hello--web.service", "freighter-hello--worker.service"]);
    const app = `${deps.layout.appsRoot}/hello`;
    expect(await readlink(`${app}/current`)).toBe(`releases/${r.releaseId}`);
    expect(await readFile(`${app}/current/server.mjs`, "utf8")).toBe("// web\n");
    expect(await readFile(`${app}/current/app.yaml`, "utf8")).toBe(MANIFEST);

    const unit = await readFile(`${deps.layout.unitDir}/freighter-hello--web.service`, "utf8");
    expect(unit).toContain("X-Freighter-App=hello");
    expect(unit).toContain('Environment="GREETING=hi"');
    expect(unit).toContain("Environment=PORT=3100");

    const sys = mutating().filter((c) => c[0] === "systemctl").map((c) => c.slice(1).join(" "));
    expect(sys).toEqual([
      "daemon-reload",
      "enable freighter-hello--web.service",
      "daemon-reload",
      "enable freighter-hello--worker.service",
      "restart freighter-hello--web.service",
      "restart freighter-hello--worker.service",
    ]);
    expect(calls).toContainEqual(["useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "hello"]);
  });

  it("second deploy swaps current and keeps the old release", async () => {
    const { deps } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    const a = await deploy(deps, { manifestText: MANIFEST, source: await artifact() });
    const b = await deploy(deps, { manifestText: MANIFEST, source: await artifact({ "server.mjs": "// v2\n" }) });
    const app = `${deps.layout.appsRoot}/hello`;
    expect(b.releaseId).not.toBe(a.releaseId);
    expect(await readlink(`${app}/current`)).toBe(`releases/${b.releaseId}`);
    expect((await readdir(`${app}/releases`)).sort()).toEqual([a.releaseId, b.releaseId]);
  });

  it("aborts before any change when secrets are missing", async () => {
    const { deps, calls } = await makeDeps();
    await expect(deploy(deps, { manifestText: MANIFEST, source: await artifact() })).rejects.toThrow(/missing secrets.*TOKEN/);
    expect(calls).toEqual([]);
    await expect(readdir(deps.layout.appsRoot)).rejects.toThrow();
  });

  it("removes units for dropped services only for the same app", async () => {
    const { deps, calls } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    const other = MANIFEST.replace("name: hello", "name: hello-web"); // prefix-overlapping app name
    await setEnv(deps, "hello-web", "web", "TOKEN", "t");
    await deploy(deps, { manifestText: other, source: await artifact() });
    await deploy(deps, { manifestText: MANIFEST, source: await artifact() });
    const slim = MANIFEST.replace(/  worker:\n    command: node worker.mjs\n    environment:\n      GREETING: hi\n/, "");
    const r = await deploy(deps, { manifestText: slim, config: "replace", source: await artifact() });
    expect(r.removed).toEqual(["freighter-hello--worker.service"]);
    expect((await readdir(deps.layout.unitDir)).sort()).toEqual([
      "freighter-hello--web.service",
      "freighter-hello-web--web.service",
      "freighter-hello-web--worker.service",
    ]);
    expect(calls).toContainEqual(["systemctl", "stop", "freighter-hello--worker.service"]);
    expect(calls).toContainEqual(["systemctl", "disable", "freighter-hello--worker.service"]);
  });

  it("extracts a .tar.gz artifact", async () => {
    const { deps } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    const src = await artifact();
    const tgz = join(await mkdtemp(join(tmpdir(), "freighter-tgz-")), "a.tar.gz");
    execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
    await deploy(deps, { manifestText: MANIFEST, source: tgz });
    expect(await readFile(`${deps.layout.appsRoot}/hello/current/server.mjs`, "utf8")).toBe("// web\n");
  });

  it("dry run changes nothing; non-root is refused; bad source cleans up", async () => {
    const { deps, calls } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    const r = await deploy(deps, { manifestText: MANIFEST, source: await artifact(), dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(calls).toEqual([]);
    await expect(readdir(deps.layout.appsRoot)).rejects.toThrow();

    const nr = await makeDeps({ isRoot: false });
    await expect(deploy(nr.deps, { manifestText: MANIFEST, source: "." })).rejects.toThrow(/root/);

    await mkdir(deps.layout.appsRoot, { recursive: true });
    await expect(deploy(deps, { manifestText: MANIFEST, source: "/nonexistent" })).rejects.toThrow(/source not found/);
  });

  it("reports status and controls services of the current release", async () => {
    const { deps, calls } = await makeDeps();
    await setEnv(deps, "hello", "web", "TOKEN", "t");
    await expect(appStatus(deps, "hello")).rejects.toThrow(/not deployed/);
    await deploy(deps, { manifestText: MANIFEST, source: await artifact() });
    const s = await appStatus(deps, "hello");
    expect(Object.keys(s.services)).toEqual(["web", "worker"]);
    expect(s.release).toBe("r20261106-134500");
    expect(await controlApp(deps, "hello", "stop", "web")).toEqual(["freighter-hello--web.service"]);
    expect(calls.at(-1)).toEqual(["systemctl", "stop", "freighter-hello--web.service"]);
    expect(s.previous).toBeNull();
    await expect(controlApp(deps, "hello", "stop", "nope")).rejects.toThrow(/unknown service/);
  });
});
