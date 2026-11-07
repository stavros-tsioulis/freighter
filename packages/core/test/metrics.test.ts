import { describe, expect, it } from "vitest";
import { collectMetrics, deploy } from "../src/index.ts";
import { artifact, makeDeps, routed } from "./helpers.ts";

describe("collectMetrics", () => {
  it("returns an empty list on a fresh host", async () => {
    const h = await makeDeps();
    expect(await collectMetrics(h.deps)).toEqual([]);
  });

  it("reports the live instance of routed services and in-place services", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed(), source: await artifact() });
    const b = await deploy(h.deps, { ...routed(), source: await artifact() });
    const samples = await collectMetrics(h.deps);
    expect(samples).toEqual([
      { app: "shop", service: "web", unit: `freighter-shop--web--${b.releaseId}.service`, activeState: "active", memoryBytes: 1024, cpuNanos: 2_000_000_000, restarts: 0 },
      { app: "shop", service: "worker", unit: "freighter-shop--worker.service", activeState: "active", memoryBytes: 1024, cpuNanos: 2_000_000_000, restarts: 0 },
    ]);
  });
});
