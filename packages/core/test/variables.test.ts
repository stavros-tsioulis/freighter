import { describe, expect, it } from "vitest";
import { deploy, readVariables, rollback, setVariables } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

const manifest = `name: shop
services:
  web:
    command: node server.mjs
    port: 3000
    environment:
      MODE: prod
      API: "@web.PORT"
    secrets:
      - TOKEN
`;

const units = (h: Awaited<ReturnType<typeof makeDeps>>) => h.unitFiles().map((u) => h.unitText(u)).join("\n");

describe("variables", () => {
  it("go into the service's configuration, restart just that service, and survive a rollback", async () => {
    const h = await makeDeps();
    const { setEnv, getConfig } = await import("../src/index.ts");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    expect(units(h)).toContain('Environment="MODE=prod"');

    const r = await setVariables(h.deps, "shop", "web", { set: { MODE: "staging", EXTRA: "1 @web.PORT" } });
    expect(r.deploy).not.toBeNull();
    expect(r.variables).toMatchObject({ MODE: "staging", EXTRA: "1 @web.PORT" });
    expect(units(h)).toContain('Environment="MODE=staging"');
    expect(units(h)).toContain('Environment="EXTRA=1 3000"');
    expect(units(h)).not.toContain('Environment="MODE=prod"');
    // it is in the configuration, where the Settings tab and the edit dialog read it, and in the new release's app.yaml
    const config = await getConfig(h.deps, "shop");
    expect(config).toMatch(/EXTRA: 1 @web\.PORT/);
    expect(config).toMatch(/MODE: staging/);
    expect(await readVariables(h.deps, "shop")).toEqual({});

    await deploy(h.deps, { manifestText: manifest, source: await artifact({ v: "2" }) });
    await rollback(h.deps, "shop", {});
    expect(units(h)).toContain('Environment="MODE=staging"');

    await setVariables(h.deps, "shop", "web", { remove: ["MODE", "EXTRA"] });
    expect(units(h)).not.toContain("EXTRA=");
    expect(await getConfig(h.deps, "shop")).not.toContain("EXTRA");
  });

  it("kept apart by an older version show in the configuration as soon as it is read, and change nothing that runs", async () => {
    const h = await makeDeps();
    const { setEnv, getConfig } = await import("../src/index.ts");
    const { writeVariables } = await import("../src/variables.ts");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    await writeVariables(h.deps, "shop", { web: { LEGACY: "yes" } });
    const config = (await getConfig(h.deps, "shop"))!;
    expect(config).toMatch(/LEGACY: ['"]?yes/);
    expect(await readVariables(h.deps, "shop")).toEqual({});
  });

  it("move what an older version kept apart into the configuration on the first change", async () => {
    const h = await makeDeps();
    const { setEnv, getConfig } = await import("../src/index.ts");
    const { writeVariables } = await import("../src/variables.ts");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    await writeVariables(h.deps, "shop", { web: { OLD: "kept" } });
    await setVariables(h.deps, "shop", "web", { set: { NEW: "1" } });
    const config = (await getConfig(h.deps, "shop"))!;
    expect(config).toMatch(/OLD: kept/);
    expect(config).toMatch(/NEW: ['"]?1/);
    expect(await readVariables(h.deps, "shop")).toEqual({});
    expect(units(h)).toContain('Environment="OLD=kept"');
  });

  it("refuses secrets, PORT, bad names and newlines, and keeps what was entered when the redeploy fails", async () => {
    const h = await makeDeps();
    const { setEnv, getConfig } = await import("../src/index.ts");
    await expect(setVariables(h.deps, "shop", "web", { set: { A: "x" } })).rejects.toThrow(/no configuration yet/);
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    await expect(setVariables(h.deps, "shop", "web", { set: { TOKEN: "x" } })).rejects.toThrow(/is a secret/);
    await expect(setVariables(h.deps, "shop", "web", { set: { PORT: "1" } })).rejects.toThrow(/PORT/);
    await expect(setVariables(h.deps, "shop", "web", { set: { lower: "1" } })).rejects.toThrow(/UPPER_SNAKE_CASE/);
    await expect(setVariables(h.deps, "shop", "web", { set: { A: "a\nb" } })).rejects.toThrow(/newlines/);
    await expect(setVariables(h.deps, "shop", "ghost", { set: { A: "1" } })).rejects.toThrow(/no service "ghost"/);
    // a connection to something that does not exist is refused like it would be in app.yaml, and nothing is saved
    await expect(setVariables(h.deps, "shop", "web", { set: { BAD: "@nope.url" } })).rejects.toThrow(/no service/);
    expect(await getConfig(h.deps, "shop")).not.toContain("BAD");
    // one that only fails when it is applied stays, so it can be fixed
    await expect(setVariables(h.deps, "shop", "web", { set: { BAD: "@ghost/x.url" } })).rejects.toThrow(/no app "ghost"/);
    expect(await getConfig(h.deps, "shop")).toContain("BAD");
  });
});
