import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deploy, listEnvNames, readVariables, setEnv, setVariables } from "../src/index.ts";
import { artifact, makeDeps } from "./helpers.ts";

const units = (h: Awaited<ReturnType<typeof makeDeps>>, service: string) => h.unitText(h.unitFiles().find((u) => u.includes(`--${service}.`))!);

describe("environment per service", () => {
  const manifest = `name: shop
services:
  web:
    command: node web.mjs
    environment:
      MODE: web
    secrets: [TOKEN]
  worker:
    command: node worker.mjs
    environment:
      MODE: worker
`;
  it("gives each service only its own values, secrets and variables", async () => {
    const h = await makeDeps();
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    expect(units(h, "web")).toContain('Environment="MODE=web"');
    expect(units(h, "web")).toContain(`EnvironmentFile=-${h.deps.layout.envDir}/shop/web.env`);
    expect(units(h, "worker")).toContain('Environment="MODE=worker"');
    expect(units(h, "worker")).toContain(`EnvironmentFile=-${h.deps.layout.envDir}/shop/worker.env`);
    expect(units(h, "worker")).not.toContain(`${h.deps.layout.envDir}/shop/web.env`);

    await setVariables(h.deps, "shop", "worker", { set: { EXTRA: "1" } });
    expect(units(h, "worker")).toContain('Environment="EXTRA=1"');
    expect(units(h, "web")).not.toContain("EXTRA");
    expect(await readVariables(h.deps, "shop")).toEqual({ worker: { EXTRA: "1" } });
    await expect(setVariables(h.deps, "shop", "nope", { set: { A: "1" } })).rejects.toThrow(/no service "nope"/);
  });

  it("asks for a secret by service", async () => {
    const h = await makeDeps();
    await expect(deploy(h.deps, { manifestText: manifest, source: await artifact() })).rejects.toThrow(/missing secrets for shop: web\/TOKEN/);
  });
});

describe("what an app had before environments belonged to services", () => {
  const legacy = `name: shop
services:
  web:
    command: node web.mjs
  worker:
    command: node worker.mjs
environment:
  MODE: prod
secrets:
  - TOKEN
`;
  it("moves secrets to the services that declare them, variables to every service, and drops the old files", async () => {
    const h = await makeDeps();
    const { envDir, appsRoot } = h.deps.layout;
    await mkdir(envDir, { recursive: true });
    await writeFile(`${envDir}/shop.env`, 'TOKEN="t"\nUNDECLARED="x"\n', { mode: 0o600 });
    await writeFile(`${envDir}/shop.refs.env`, 'S3="k"\n');
    await mkdir(`${appsRoot}/shop`, { recursive: true });
    await writeFile(`${appsRoot}/shop/variables.json`, JSON.stringify({ EXTRA: "1" }));

    await deploy(h.deps, { manifestText: legacy, legacy: true, source: await artifact() });
    expect(await readFile(`${envDir}/shop/web.env`, "utf8")).toBe('TOKEN="t"\n');
    expect(await readFile(`${envDir}/shop/worker.env`, "utf8")).toBe('TOKEN="t"\n');
    expect(existsSync(`${envDir}/shop.env`)).toBe(false);
    expect(existsSync(`${envDir}/shop.refs.env`)).toBe(false);
    expect(await readVariables(h.deps, "shop")).toEqual({ web: { EXTRA: "1" }, worker: { EXTRA: "1" } });
    expect(units(h, "worker")).toContain('Environment="MODE=prod"');
    expect(units(h, "worker")).toContain('Environment="EXTRA=1"');
  });

  it("is also done by the first look at a deployed app's secrets", async () => {
    const h = await makeDeps();
    const { envDir } = h.deps.layout;
    await mkdir(envDir, { recursive: true });
    await writeFile(`${envDir}/shop.env`, 'TOKEN="t"\n', { mode: 0o600 });
    await deploy(h.deps, { manifestText: legacy, legacy: true, source: await artifact() });
    await writeFile(`${envDir}/shop.env`, 'TOKEN="late"\n', { mode: 0o600 }); // an agent that wrote the old place after the move
    expect(await listEnvNames(h.deps, "shop", "web")).toEqual(["TOKEN"]);
    expect(existsSync(`${envDir}/shop.env`)).toBe(false);
  });
});
