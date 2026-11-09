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
  it("are laid over app.yaml's environment, redeploy the release, and survive a rollback", async () => {
    const h = await makeDeps();
    const { setEnv } = await import("../src/index.ts");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    expect(units(h)).toContain('Environment="MODE=prod"');

    const r = await setVariables(h.deps, "shop", "web", { set: { MODE: "staging", EXTRA: "1 @web.PORT" } });
    expect(r.deploy).not.toBeNull();
    expect(units(h)).toContain('Environment="MODE=staging"');
    expect(units(h)).toContain('Environment="EXTRA=1 3000"');
    expect(units(h)).not.toContain('Environment="MODE=prod"');

    await deploy(h.deps, { manifestText: manifest, source: await artifact({ v: "2" }) });
    await rollback(h.deps, "shop", {});
    expect(units(h)).toContain('Environment="MODE=staging"');

    await setVariables(h.deps, "shop", "web", { remove: ["MODE", "EXTRA"] });
    expect(units(h)).toContain('Environment="MODE=prod"');
    expect(await readVariables(h.deps, "shop")).toEqual({});
  });

  it("refuses secrets, PORT, bad names and newlines, and keeps the old values when the redeploy fails", async () => {
    const h = await makeDeps();
    await expect(setVariables(h.deps, "shop", "web", { set: { A: "x" } })).resolves.toMatchObject({ deploy: null }); // not deployed yet: just saved
    const { setEnv } = await import("../src/index.ts");
    await setEnv(h.deps, "shop", "web", "TOKEN", "t");
    await deploy(h.deps, { manifestText: manifest, source: await artifact() });
    await expect(setVariables(h.deps, "shop", "web", { set: { TOKEN: "x" } })).rejects.toThrow(/is a secret/);
    await expect(setVariables(h.deps, "shop", "web", { set: { PORT: "1" } })).rejects.toThrow(/PORT/);
    await expect(setVariables(h.deps, "shop", "web", { set: { lower: "1" } })).rejects.toThrow(/UPPER_SNAKE_CASE/);
    await expect(setVariables(h.deps, "shop", "web", { set: { A: "a\nb" } })).rejects.toThrow(/newlines/);
    // a connection that can't resolve fails the redeploy and the values go back
    await expect(setVariables(h.deps, "shop", "web", { set: { BAD: "@ghost/x.url" } })).rejects.toThrow(/no app "ghost"/);
    expect(await readVariables(h.deps, "shop")).toEqual({ web: { A: "x" } });
  });
});
