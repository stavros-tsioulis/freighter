import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CanceledError, DeployFailedError, beginOperation, cancelOperation, deploy, readState } from "../src/index.ts";
import { artifact, makeDeps, routed } from "./helpers.ts";

describe("operations", () => {
  it("are stopped by the id they run under, once", () => {
    const op = beginOperation("0123abcd-0123");
    expect(op.signal?.aborted).toBe(false);
    expect(cancelOperation("0123abcd-0123")).toBe(true);
    expect(op.signal?.aborted).toBe(true);
    expect(op.settle(new Error("spawn killed"))).toBeInstanceOf(CanceledError); // what a killed command threw is just "canceled"
    op.end();
    expect(cancelOperation("0123abcd-0123")).toBe(false);
    expect(cancelOperation("nobody-here-123")).toBe(false);
    const none = beginOperation(undefined);
    expect(none.signal).toBeUndefined();
    expect(none.settle(new Error("x"))).toEqual(new Error("x"));
  });
});

describe("canceling a deploy", () => {
  it("stops before anything is switched and leaves no release behind", async () => {
    const h = await makeDeps();
    const ctl = new AbortController();
    ctl.abort();
    await expect(deploy(h.deps, { ...routed(), source: await artifact(), signal: ctl.signal })).rejects.toBeInstanceOf(CanceledError);
    expect(h.unitFiles()).toEqual([]);
    expect(await readdir(`${h.deps.layout.appsRoot}/shop/releases`)).toEqual([]);
  });

  it("stops waiting for health and rolls back to what was running", async () => {
    const h = await makeDeps();
    const a = await deploy(h.deps, { ...routed(), source: await artifact() });
    const ctl = new AbortController();
    h.deps.probe = async () => {
      ctl.abort(); // the user presses cancel while the new release is being checked
      return null;
    };
    const err = await deploy(h.deps, { ...routed(), source: await artifact({ v: "2" }), signal: ctl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeployFailedError);
    expect((err as DeployFailedError).message).toMatch(/canceled/);
    expect((err as DeployFailedError).rolledBackTo).toBe(a.releaseId);
    expect((await readState(h.deps, "shop")).routed.web?.release).toBe(a.releaseId);
  });
});
