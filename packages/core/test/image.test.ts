import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deploy, deleteApp, imageHost, readImages, rollback } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

const IMG = (tag: string) => `name: shop
services:
  web:
    image: ghcr.io/org/shop:${tag}
    port: 3000
    healthcheck:
      path: /health
      timeout: 5s
    secrets:
      - DB_URL
`;

const digest = (c: string) => c.repeat(64);

describe("image deploys", () => {
  it("pulls the image, pins its digest and runs it with podman", async () => {
    const { deps, calls, unitText, ctl } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "web", "DB_URL", "postgres://x");
    const r = await deploy(deps, { manifestText: IMG("1"), registryAuth: undefined });
    expect(r.units).toEqual(["freighter-shop--web.service"]);

    const pinned = `ghcr.io/org/shop@sha256:${ctl.podman.digest}`;
    expect(await readImages(deps, "shop", r.releaseId)).toEqual({ web: pinned });
    const unit = unitText("freighter-shop--web.service");
    expect(unit).toContain(`ExecStart=/usr/bin/podman --cgroup-manager=cgroupfs run --rm --replace --name freighter-shop--web `);
    expect(unit).toContain(` -e DB_URL `);
    expect(unit.split("\n").find((l) => l.startsWith("ExecStart="))).toMatch(new RegExp(`${pinned}$`));

    expect(calls.some((c) => c[0] === "systemd-run" && c.includes("pull") && c.at(-1) === "ghcr.io/org/shop:1")).toBe(true);
    // no login session (linger / systemd-logind) is involved: the runtime directory is made directly
    expect(calls.some((c) => c[0] === "loginctl")).toBe(false);
    expect(calls).toContainEqual(["install", "-d", "-o", "shop", "-g", "shop", "-m", "0700", "/run/freighter-shop"]);
    expect(unitText("freighter-shop--web.service")).toContain("Environment=XDG_RUNTIME_DIR=/run/freighter-shop");
    expect(calls.find((c) => c[0] === "systemd-run" && c.includes("pull"))).toContain("--setenv=XDG_RUNTIME_DIR=/run/freighter-shop");
    expect((await readdir(`${deps.layout.appsRoot}/shop/current`)).sort()).toEqual([".freighter-images.json", "app.yaml"]);
  });

  it("runs podman for the app in a unit of its own, and never chowns what a container keeps in its volumes or image store", async () => {
    const { deps, calls } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "web", "DB_URL", "x");
    await deploy(deps, { manifestText: IMG("1") + "    volumes:\n      data: /var/lib/data\n" });
    const pull = calls.find((c) => c[0] === "systemd-run" && c.includes("pull"))!;
    expect(pull).toEqual(expect.arrayContaining(["--wait", "--pipe", "--collect", "--uid=shop", "--gid=shop", "--property=RuntimeMaxSec=900"]));
    expect(calls.some((c) => c[0] === "runuser")).toBe(false); // not as a child of the agent, whose private /tmp the containers would inherit
    const recursive = calls.filter((c) => c[0] === "chown" && c.includes("-R")).map((c) => c.at(-1)!);
    expect(recursive.some((p) => p.includes("/volumes") || p.endsWith("/container") || p.endsWith("/shared"))).toBe(false);
    expect(calls).toContainEqual(["chown", "shop:shop", `${deps.layout.appsRoot}/shop/shared/volumes`]);
  });

  describe("the port inside the container", () => {
    const publish = (unit: string) => /-p (\S+) /.exec(unit.split("\n").find((l) => l.startsWith("ExecStart="))!)![1];
    const deployWith = async (exposed: number[], extra = "", tag = "1") => {
      const t = await makeDeps();
      const { setEnv } = await import("../src/index.ts");
      await setEnv(t.deps, "shop", "web", "DB_URL", "x");
      t.ctl.podman.exposed = exposed;
      const logs: string[] = [];
      const r = await deploy(t.deps, { manifestText: IMG(tag).replace("    port: 3000\n", `    port: 3000\n${extra}`), log: (l) => void logs.push(l) });
      return { ...t, r, logs };
    };

    it("uses the one port the image declares when containerPort is not set (Grafana listens on 3000, ignoring $PORT)", async () => {
      const t = await deployWith([8080]);
      expect(publish(t.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:8080");
      expect(t.logs.join("\n")).toMatch(/web: the image listens on 8080 inside the container/);
      expect(JSON.parse(await readFile(`${t.deps.layout.appsRoot}/shop/current/.freighter-container-ports.json`, "utf8"))).toEqual({ web: 8080 });
    });
    it("lets containerPort win over the image", async () => {
      const t = await deployWith([8080], "    containerPort: 9000\n");
      expect(publish(t.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:9000");
    });
    it("says so, and keeps the published port, when the image declares several or none", async () => {
      const many = await deployWith([80, 443]);
      expect(publish(many.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:3000");
      expect(many.logs.join("\n")).toMatch(/declares ports 80, 443; set containerPort/);
      const none = await deployWith([]);
      expect(publish(none.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:3000");
      expect(none.logs.join("\n")).toMatch(/declares no port/);
    });
    it("rolls back to the port that release was deployed with", async () => {
      const t = await deployWith([3000]);
      const { setEnv } = await import("../src/index.ts");
      void setEnv;
      t.ctl.podman.exposed = [8081]; // the next image moved
      const second = await deploy(t.deps, { manifestText: IMG("2") });
      expect(publish(t.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:8081");
      await rollback(t.deps, "shop", { target: t.r.releaseId });
      expect(publish(t.unitText("freighter-shop--web.service"))).toBe("127.0.0.1:3000:3000");
      void second;
    });
  });

  it("fails cleanly, leaving no release behind, when the pull fails", async () => {
    const { deps, ctl } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "web", "DB_URL", "x");
    ctl.podman.failPull = true;
    await expect(deploy(deps, { manifestText: IMG("nope") })).rejects.toThrow(/pulling ghcr.io\/org\/shop:nope failed.*manifest unknown/);
    expect(await readdir(`${deps.layout.appsRoot}/shop/releases`)).toEqual([]);
  });

  it("refuses a server without podman", async () => {
    const { deps, ctl } = await makeDeps();
    ctl.podman.installed = false;
    await expect(deploy(deps, { manifestText: IMG("1") })).rejects.toThrow(/cannot run images/);
  });

  it("rolls back to the digest the old release was verified with", async () => {
    const { deps, ctl, unitText } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "web", "DB_URL", "x");
    ctl.podman.digest = digest("a");
    const first = await deploy(deps, { manifestText: IMG("latest") });
    ctl.podman.digest = digest("b"); // the tag moved
    const second = await deploy(deps, { manifestText: IMG("latest") });
    expect(await readImages(deps, "shop", second.releaseId)).toEqual({ web: `ghcr.io/org/shop@sha256:${digest("b")}` });

    await rollback(deps, "shop", { target: first.releaseId });
    const run = unitText("freighter-shop--web.service").split("\n").find((l) => l.startsWith("ExecStart="))!;
    expect(run).toContain(`ghcr.io/org/shop@sha256:${digest("a")}`);
  });

  it("does not need an artifact, but a command service still does", async () => {
    const { deps } = await makeDeps();
    await expect(deploy(deps, { manifestText: "name: x\nservices:\n  web:\n    command: run\n" })).rejects.toThrow(/artifact is required/);
  });

  it("removes containers and the app's directory when the app is deleted", async () => {
    const { deps, calls } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "web", "DB_URL", "x");
    await deploy(deps, { manifestText: IMG("1") });
    await deleteApp(deps, "shop");
    expect(calls.some((c) => c[0] === "systemd-run" && c.includes("system") && c.includes("reset"))).toBe(true);
    expect(calls).toContainEqual(["rm", "-rf", "/run/freighter-shop"]);
  });
});

describe("imageHost", () => {
  it("finds the registry of a reference", () => {
    expect(imageHost("ghcr.io/org/app:1")).toBe("ghcr.io");
    expect(imageHost("localhost:5000/app")).toBe("localhost:5000");
    expect(imageHost("nginx")).toBe("docker.io");
    expect(imageHost("org/app:1")).toBe("docker.io");
  });
});
