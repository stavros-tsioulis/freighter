import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { envFilePath, listEnvNames, setEnv } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

describe("env", () => {
  it("sets, replaces and lists names only", async () => {
    const { deps } = await makeDeps();
    expect(await listEnvNames(deps, "a", "web")).toEqual([]);
    await setEnv(deps, "a", "web", "TOKEN", 'p"w\\d');
    await setEnv(deps, "a", "web", "B", "1");
    await setEnv(deps, "a", "web", "TOKEN", "new");
    expect(await listEnvNames(deps, "a", "web")).toEqual(["B", "TOKEN"]);
    const text = await readFile(envFilePath(deps, "a", "web"), "utf8");
    expect(text).toBe('B="1"\nTOKEN="new"\n');
    expect((await stat(envFilePath(deps, "a", "web"))).mode & 0o777).toBe(0o600);
  });
  it("rejects bad keys and newlines", async () => {
    const { deps } = await makeDeps();
    await expect(setEnv(deps, "a", "web", "bad", "x")).rejects.toThrow(/invalid env key/);
    await expect(setEnv(deps, "a", "web", "OK", "x\ny")).rejects.toThrow(/newlines/);
  });
});
