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
    await setEnv(deps, "shop", "DB_URL", "postgres://x");
    const r = await deploy(deps, { manifestText: IMG("1"), registryAuth: undefined });
    expect(r.units).toEqual(["freighter-shop--web.service"]);

    const pinned = `ghcr.io/org/shop@sha256:${ctl.podman.digest}`;
    expect(await readImages(deps, "shop", r.releaseId)).toEqual({ web: pinned });
    const unit = unitText("freighter-shop--web.service");
    expect(unit).toContain(`ExecStart=/usr/bin/podman --cgroup-manager=cgroupfs run --rm --name freighter-shop--web `);
    expect(unit).toContain(` -e DB_URL `);
    expect(unit.split("\n").find((l) => l.startsWith("ExecStart="))).toMatch(new RegExp(`${pinned}$`));

    expect(calls.some((c) => c[0] === "runuser" && c.includes("pull") && c.at(-1) === "ghcr.io/org/shop:1")).toBe(true);
    expect(calls).toContainEqual(["loginctl", "enable-linger", "shop"]);
    expect((await readdir(`${deps.layout.appsRoot}/shop/current`)).sort()).toEqual([".freighter-images.json", "app.yaml"]);
  });

  it("fails cleanly, leaving no release behind, when the pull fails", async () => {
    const { deps, ctl } = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(deps, "shop", "DB_URL", "x");
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
    await setEnv(deps, "shop", "DB_URL", "x");
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
    await setEnv(deps, "shop", "DB_URL", "x");
    await deploy(deps, { manifestText: IMG("1") });
    await deleteApp(deps, "shop");
    expect(calls.some((c) => c[0] === "runuser" && c.includes("system") && c.includes("reset"))).toBe(true);
    expect(calls).toContainEqual(["loginctl", "disable-linger", "shop"]);
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
