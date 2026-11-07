import { mkdir, readlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { activate, currentRelease, newReleaseId } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

describe("releases", () => {
  it("formats ids as valid identifiers", () => {
    const id = newReleaseId(new Date(Date.UTC(2026, 10, 6, 13, 45, 0)));
    expect(id).toBe("r20261106-134500");
  });
  it("activate replaces an existing link", async () => {
    const { deps } = await makeDeps();
    const dir = `${deps.layout.appsRoot}/a`;
    await mkdir(`${dir}/releases/r1`, { recursive: true });
    await mkdir(`${dir}/releases/r2`, { recursive: true });
    await writeFile(`${dir}/releases/r2/f`, "x");
    expect(await currentRelease(deps, "a")).toBeNull();
    await activate(deps, "a", "r1");
    await activate(deps, "a", "r2");
    expect(await readlink(`${dir}/current`)).toBe("releases/r2");
    expect(await currentRelease(deps, "a")).toBe("r2");
  });
});
