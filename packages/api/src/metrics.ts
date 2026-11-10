import type { MetricSampleRow } from "@freighter/registry";
import type { ApiContext } from "./context.ts";
import { reachableServers } from "./servers.ts";

export interface MetricPoint {
  at: string;
  memoryBytes: number | null;
  /** Share of one CPU core (100 = one full core) since the previous sample; null when it cannot be derived. */
  cpuPercent: number | null;
  restarts: number;
  active: string;
}

/** Turn raw samples (ordered by service, time) into points, deriving CPU % from the counter deltas. */
export function buildSeries(rows: MetricSampleRow[]): Record<string, MetricPoint[]> {
  const out: Record<string, MetricPoint[]> = {};
  let prev: MetricSampleRow | undefined;
  for (const r of rows) {
    if (prev && (prev.service !== r.service || prev.app !== r.app)) prev = undefined;
    let cpuPercent: number | null = null;
    if (prev && prev.unit === r.unit && prev.cpuNanos !== null && r.cpuNanos !== null) {
      const dt = (Date.parse(r.at) - Date.parse(prev.at)) / 1000;
      const dCpu = r.cpuNanos - prev.cpuNanos;
      // A new unit (new release) or a restarted counter makes the delta meaningless; skip those.
      if (dt > 0 && dCpu >= 0) cpuPercent = Math.round((dCpu / (dt * 1e9)) * 1000) / 10;
    }
    (out[r.service] ??= []).push({ at: r.at, memoryBytes: r.memoryBytes, cpuPercent, restarts: r.restarts, active: r.active });
    prev = r;
  }
  return out;
}

/** Snapshot every reachable server, store the samples, and drop those past the retention window. */
export async function sampleOnce(ctx: ApiContext): Promise<number> {
  const t = (ctx.now ?? (() => new Date()))();
  let total = 0;
  await Promise.all(
    reachableServers(ctx).map(async (server) => {
      try {
        const { samples } = await ctx.agents.forServer(server.name).call("metrics.snapshot", {}, { timeoutMs: 10_000 });
        ctx.registry.metrics.add(
          samples.map((s) => ({ app: s.app, service: s.service, unit: s.unit, active: s.activeState, memoryBytes: s.memoryBytes, cpuNanos: s.cpuNanos, restarts: s.restarts })),
          t.toISOString(),
        );
        total += samples.length;
        // and how the machine itself is doing (an agent without it just has no history)
        const host = await ctx.agents.forServer(server.name).call("host.status", {}, { timeoutMs: 10_000 }).catch(() => null);
        if (host) {
          ctx.registry.hostSamples.add(
            server.name,
            {
              load1: host.load1,
              cpus: host.cpus ?? null,
              memUsed: host.memTotal - host.memFree,
              memTotal: host.memTotal,
              diskUsed: host.diskTotalBytes !== null && host.diskFreeBytes !== null ? host.diskTotalBytes - host.diskFreeBytes : null,
              diskTotal: host.diskTotalBytes,
            },
            t.toISOString(),
          );
        }
      } catch {
        /* an unreachable server simply has no sample this round */
      }
    }),
  );
  const keepMs = (ctx.metricsRetentionHours ?? 6) * 3_600_000;
  ctx.registry.metrics.prune(new Date(t.getTime() - keepMs).toISOString());
  ctx.registry.hostSamples.prune(new Date(t.getTime() - keepMs).toISOString());
  return total;
}
