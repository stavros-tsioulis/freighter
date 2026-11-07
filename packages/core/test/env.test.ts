import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { envFilePath, listEnvNames, setEnv } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

describe("env", () => {
  it("sets, replaces and lists names only", async () => {
    const { deps } = await makeDeps();
    expect(await listEnvNames(deps, "a")).toEqual([]);
    await setEnv(deps, "a", "TOKEN", 'p"w\\d');
    await setEnv(deps, "a", "B", "1");
    await setEnv(deps, "a", "TOKEN", "new");
    expect(await listEnvNames(deps, "a")).toEqual(["B", "TOKEN"]);
    const text = await readFile(envFilePath(deps, "a"), "utf8");
    expect(text).toBe('B="1"\nTOKEN="new"\n');
    expect((await stat(envFilePath(deps, "a"))).mode & 0o777).toBe(0o600);
  });
  it("rejects bad keys and newlines", async () => {
    const { deps } = await makeDeps();
    await expect(setEnv(deps, "a", "bad", "x")).rejects.toThrow(/invalid env key/);
    await expect(setEnv(deps, "a", "OK", "x\ny")).rejects.toThrow(/newlines/);
  });
});
