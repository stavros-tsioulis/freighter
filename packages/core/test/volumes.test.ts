import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deleteApp, deploy, setVolumePassword, volumeStatus } from "../src/index.ts";
import { parseManifest } from "@freighter/manifest";
import { artifact, makeDeps } from "./helpers.ts";

const yaml = (extra = "", svc = "    volumes:\n      media: /data/media\n      scratch: /data/scratch\n") =>
  `name: shop\nservices:\n  web:\n    command: node server.mjs\n${svc}${extra}`;
const SMB = "volumes:\n  media:\n    type: smb\n    host: nas.lan\n    share: media\n    user: svc\n    domain: WG\n";
const mountUnits = (h: Awaited<ReturnType<typeof makeDeps>>) => h.mutating().filter((c) => c[0] === "systemctl" && c[2]?.endsWith(".mount"));

describe("volumes", () => {
  it("creates the folders services attach and binds them where they asked", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: yaml(), source: await artifact() });
    expect((await stat(`${h.deps.layout.appsRoot}/shop/shared/volumes/media`)).isDirectory()).toBe(true);
    expect((await stat(`${h.deps.layout.appsRoot}/shop/shared/volumes/scratch`)).isDirectory()).toBe(true);
    const unit = h.unitText("freighter-shop--web.service");
    expect(unit).toContain(`BindPaths=${h.deps.layout.appsRoot}/shop/shared/volumes/media:/data/media`);
    expect(unit).not.toContain("RequiresMountsFor");
  });

  it("resolves @volume:name.path to what the service sees, and shared to the shared directory", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: yaml("", "    volumes:\n      media: /data/media\n    environment:\n      MEDIA: \"@volume:media.path\"\n      SHARED: \"@volume:shared.path/tmp\"\n"), source: await artifact() });
    const unit = h.unitText("freighter-shop--web.service");
    expect(unit).toContain('Environment="MEDIA=/data/media"');
    expect(unit).toContain(`Environment="SHARED=${h.deps.layout.appsRoot}/shop/shared/tmp"`);
  });

  it("a command service that attaches nothing still sees an app folder at its host path", async () => {
    const h = await makeDeps();
    const text = `name: shop\nservices:\n  web:\n    command: x\n    volumes:\n      up: /data/up\n  job:\n    command: y\n    environment:\n      UP: "@volume:up.path"\n`;
    await deploy(h.deps, { manifestText: text, source: await artifact() });
    expect(h.unitText("freighter-shop--job.service")).toContain(`Environment="UP=${h.deps.layout.appsRoot}/shop/shared/volumes/up"`);
  });

  it("an image can't see a volume it doesn't attach", async () => {
    const h = await makeDeps();
    const text = `name: shop\nservices:\n  web:\n    command: x\n    volumes:\n      up: /data/up\n  img:\n    image: ghcr.io/o/i:1\n    environment:\n      UP: "@volume:up.path"\n`;
    await expect(deploy(h.deps, { manifestText: text, source: await artifact() })).rejects.toThrow(/doesn't see volume "up"/);
  });
});

describe("remote volumes", () => {
  it("won't deploy until an SMB password is set, then mounts it as the app's user from a root-only credentials file", async () => {
    const h = await makeDeps();
    await expect(deploy(h.deps, { manifestText: yaml(SMB), source: await artifact() })).rejects.toThrow(/missing passwords for volumes of shop: media/);
    await setVolumePassword(h.deps, "shop", "media", "p@ss");
    await deploy(h.deps, { manifestText: yaml(SMB), source: await artifact() });

    const mounts = readdirSync(h.deps.layout.unitDir).filter((f) => f.endsWith(".mount"));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/shop-shared-volumes-media\.mount$/);
    expect(readFileSync(`${h.deps.layout.unitDir}/${mounts[0]}`, "utf8")).toContain("Type=cifs");
    const cred = `${h.deps.layout.envDir}/shop/volumes/media.cred`;
    expect(await readFile(cred, "utf8")).toBe("username=svc\npassword=p@ss\ndomain=WG\n");
    expect((await stat(cred)).mode & 0o777).toBe(0o600);
    expect(h.unitText("freighter-shop--web.service")).toContain("RequiresMountsFor=");
    expect(mountUnits(h).some((c) => c[1] === "enable")).toBe(true);
  });

  it("refuses to deploy on a server without the mount tools", async () => {
    const h = await makeDeps();
    await setVolumePassword(h.deps, "shop", "media", "x");
    const run = h.deps.run;
    h.deps.run = async (cmd, args, o) => (cmd === "sh" && args.join(" ").includes("command -v mount.cifs") ? { stdout: "", code: 1 } : run(cmd, args, o));
    await expect(deploy(h.deps, { manifestText: yaml(SMB), source: await artifact() })).rejects.toThrow(/can't mount remote volumes/);
  });

  it("reports the mount state, and drops the mount when the volume is no longer declared", async () => {
    const h = await makeDeps();
    await setVolumePassword(h.deps, "shop", "media", "x");
    await deploy(h.deps, { manifestText: yaml(SMB), source: await artifact() });
    const m = parseManifest(yaml(SMB));
    expect(await volumeStatus(h.deps, "shop", m)).toEqual({ media: { type: "smb", state: "mounted", password: true } });
    h.calls.length = 0;
    await deploy(h.deps, { manifestText: yaml(SMB.replace("host: nas.lan", "host: other.lan")), config: "replace", source: await artifact() });
    expect(h.unitText("freighter-shop--web.service")).toBeTruthy();
    await deploy(h.deps, { manifestText: yaml(""), config: "replace", source: await artifact() });
    expect(h.calls.some((c) => c[0] === "systemctl" && c[1] === "stop" && c[2]?.endsWith(".mount"))).toBe(true);
    expect(existsSync(`${h.deps.layout.envDir}/shop/volumes/media.cred`)).toBe(false);
  });

  it("unmounts before an app is deleted", async () => {
    const h = await makeDeps();
    await setVolumePassword(h.deps, "shop", "media", "x");
    await deploy(h.deps, { manifestText: yaml(SMB), source: await artifact() });
    h.calls.length = 0;
    await deleteApp(h.deps, "shop");
    const stop = h.calls.findIndex((c) => c[0] === "systemctl" && c[1] === "stop" && c[2]?.endsWith(".mount"));
    expect(stop).toBeGreaterThanOrEqual(0);
  });
});
