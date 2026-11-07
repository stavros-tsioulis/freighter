import type { Deps } from "./deps.ts";
import { allStates } from "./state.ts";

/** Lowest free port in the configured range: unused by any app's state, not reserved in this run, and not bound. */
export async function allocatePort(d: Deps, reserved: Set<number>): Promise<number> {
  const used = new Set(reserved);
  for (const st of Object.values(await allStates(d))) for (const r of Object.values(st.routed)) used.add(r.port);
  const { min, max } = d.config.ports;
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && (await d.portFree(p))) {
      reserved.add(p);
      return p;
    }
  }
  throw new Error(`no free port in ${min}-${max}`);
}
