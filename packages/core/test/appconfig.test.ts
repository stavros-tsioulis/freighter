import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configPath, deploy, getConfig, rollback, setConfig, setEnv } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

const yaml = (extra = "", cmd = "node server.mjs") => `name: shop\nservices:\n  web:\n    command: ${cmd}\n    port: 3100\n${extra}`;
const units = (h: Awaited<ReturnType<typeof makeDeps>>) => h.unitFiles().map((u) => h.unitText(u)).join("\n");

describe("app.yaml as an init file", () => {
  it("the first deploy sets the configuration, and later app.yaml files are ignored with a warning", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: yaml('    environment:\n      A: one\n'), source: await artifact() });
    expect(await getConfig(h.deps, "shop")).toContain("A: one");

    const r = await deploy(h.deps, { manifestText: yaml('    environment:\n      A: two\n', "node other.mjs"), source: await artifact() });
    expect(r.warnings.join()).toMatch(/app.yaml was not applied/);
    expect(units(h)).toContain('Environment="A=one"');
    expect(units(h)).toContain("node server.mjs");
    expect(await readFile(`${h.deps.layout.appsRoot}/shop/releases/${r.releaseId}/app.yaml`, "utf8")).toContain("A: one");

    const same = await deploy(h.deps, { manifestText: yaml('    environment:\n      A: one\n'), source: await artifact() });
    expect(same.warnings.join()).not.toMatch(/not applied/);
  });

  it("a failed first deploy keeps the services, so the secrets can be set and the deploy retried", async () => {
    const h = await makeDeps();
    const text = yaml("    secrets: [TOKEN]\n");
    await expect(deploy(h.deps, { manifestText: text, source: await artifact() })).rejects.toThrow(/missing secrets/);
    expect(await getConfig(h.deps, "shop")).toContain("TOKEN");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await expect(deploy(h.deps, { manifestText: text, source: await artifact() })).resolves.toBeTruthy();
  });

  it("an app deployed before configuration was kept takes its current release's app.yaml", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: yaml(), source: await artifact() });
    await rm(configPath(h.deps, "shop"));
    const r = await deploy(h.deps, { manifestText: yaml("", "node other.mjs"), source: await artifact() });
    expect(r.warnings.join()).toMatch(/not applied/);
    expect(units(h)).not.toContain("other.mjs");
  });

  it("setConfig replaces the configuration and redeploys the current release with it, and keeps what was entered even if that fails", async () => {
    const h = await makeDeps();
    const first = await deploy(h.deps, { manifestText: yaml(), source: await artifact() });
    const r = await setConfig(h.deps, "shop", yaml('    environment:\n      A: set\n'));
    expect(r.deploy?.releaseId).not.toBe(first.releaseId);
    expect(units(h)).toContain('Environment="A=set"');
    expect(await getConfig(h.deps, "shop")).toContain("A: set");

    // a deploy that fails does not lose what was entered: it is the configuration, whether or not it is running yet
    await expect(setConfig(h.deps, "shop", yaml("    secrets: [NOPE]\n"))).rejects.toThrow(/missing secrets/);
    expect(await getConfig(h.deps, "shop")).toContain("NOPE");
    await setConfig(h.deps, "shop", yaml('    environment:\n      A: set\n'));
    expect(await getConfig(h.deps, "shop")).toContain("A: set");
    await expect(setConfig(h.deps, "shop", yaml().replace("name: shop", "name: other"))).rejects.toThrow(/not "shop"/);
    await expect(setConfig(h.deps, "shop", "name: shop\nsecrets: [A]\nservices:\n  web:\n    command: x\n")).rejects.toThrow(/belong to each service/);
  });

  it("setConfig on an app that isn't deployed yet only saves it for the first deploy", async () => {
    const h = await makeDeps();
    expect((await setConfig(h.deps, "shop", yaml('    environment:\n      A: early\n'))).deploy).toBeNull();
    await deploy(h.deps, { manifestText: yaml('    environment:\n      A: file\n'), source: await artifact() });
    expect(units(h)).toContain('Environment="A=early"');
  });

  it("a rollback takes the configuration back with the release", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: yaml('    environment:\n      A: one\n'), source: await artifact() });
    await setConfig(h.deps, "shop", yaml('    environment:\n      A: two\n'));
    await rollback(h.deps, "shop", {});
    expect(await getConfig(h.deps, "shop")).toContain("A: one");
    expect(units(h)).toContain('Environment="A=one"');
  });
});
