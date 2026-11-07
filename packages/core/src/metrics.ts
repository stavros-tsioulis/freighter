import type { Deps } from "./deps.ts";
import { listApps, loadCurrentManifest, resolveServiceUnit } from "./status.ts";

export interface MetricSample {
  app: string;
  service: string;
  unit: string;
  activeState: string;
  memoryBytes: number | null;
  cpuNanos: number | null;
  restarts: number;
}

/** One reading per service of every deployed app (units resolved to the live instance). */
export async function collectMetrics(d: Deps): Promise<MetricSample[]> {
  const out: MetricSample[] = [];
  for (const app of await listApps(d)) {
    let manifest;
    try {
      manifest = await loadCurrentManifest(d, app);
    } catch {
      continue; // not deployed (e.g. first deploy failed)
    }
    for (const service of Object.keys(manifest.services)) {
      const unit = await resolveServiceUnit(d, app, service);
      try {
        const st = await d.systemd.status(unit);
        out.push({ app, service, unit, activeState: st.activeState, memoryBytes: st.memoryCurrent, cpuNanos: st.cpuNanos, restarts: st.restarts });
      } catch {
        out.push({ app, service, unit, activeState: "unknown", memoryBytes: null, cpuNanos: null, restarts: 0 });
      }
    }
  }
  return out;
}
