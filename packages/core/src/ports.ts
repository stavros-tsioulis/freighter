import type { Deps } from "./deps.ts";
import { allStates } from "./state.ts";

/** Every port some app holds: its routed instances and the ports given to services that set none. */
async function portsInUse(d: Deps, except?: string): Promise<Set<number>> {
  const used = new Set<number>();
  for (const [app, st] of Object.entries(await allStates(d))) {
    if (app === except) continue;
    for (const r of Object.values(st.routed)) used.add(r.port);
    for (const p of Object.values(st.assigned ?? {})) used.add(p);
  }
  return used;
}

/**
 * A free port in the configured range, chosen at random: unused by any app's state, not reserved in this run, and not
 * bound. It starts at a random place and walks on (wrapping around), so it only fails when the range is full.
 */
export async function allocatePort(d: Deps, reserved: Set<number>): Promise<number> {
  const used = new Set([...reserved, ...(await portsInUse(d))]);
  const { min, max } = d.config.ports;
  const size = max - min + 1;
  const start = d.pickPort ? d.pickPort(min, max) - min : Math.floor(Math.random() * size);
  for (let i = 0; i < size; i++) {
    const p = min + ((start + i) % size);
    if (!used.has(p) && (await d.portFree(p))) {
      reserved.add(p);
      return p;
    }
  }
  throw new Error(`no free port in ${min}-${max}`);
}

/**
 * The port of a service that sets none and isn't routed: the one it was given before when that is still unclaimed (so
 * `@service.port` doesn't change from one deploy to the next), otherwise a new one. The service is already listening
 * on its old port, so that one is not tested for being free, only for being held by someone else.
 */
export async function assignedPort(d: Deps, app: string, previous: number | undefined, reserved: Set<number>): Promise<number> {
  const { min, max } = d.config.ports;
  if (previous !== undefined && previous >= min && previous <= max && !reserved.has(previous) && !(await portsInUse(d, app)).has(previous)) {
    reserved.add(previous);
    return previous;
  }
  return allocatePort(d, reserved);
}
