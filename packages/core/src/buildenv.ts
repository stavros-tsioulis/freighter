import { findReferences, type AppFacts, type Manifest } from "@freighter/manifest";
import { readConnections } from "./connections.ts";
import type { Deps } from "./deps.ts";
import { readDomains } from "./domains.ts";
import { resolveEnvironmentEach } from "./references.ts";

const BUILD = "build";

/**
 * The environment the build commands get: `build.environment` with its references filled in. A build can read the
 * public address of a service of this app or of another app in its project (`@api.url`, `@shop/web.domain`), from the
 * domains as they are now, and nothing else: no ports, no credentials, no run-time values.
 */
export async function resolveBuildEnvironment(d: Deps, manifest: Pick<Manifest, "name" | "services" | "build">): Promise<{ environment: Record<string, string>; notes: string[] }> {
  const values = manifest.build?.environment ?? {};
  if (Object.values(values).every((v) => findReferences(v).length === 0)) return { environment: { ...values }, notes: [] };
  const conn = await readConnections(d, manifest.name);
  const self: AppFacts = {
    name: manifest.name,
    server: conn.server,
    services: Object.keys(manifest.services),
    domains: await readDomains(d, manifest.name),
    ports: {},
    environment: { [BUILD]: values },
  };
  const out: Record<string, string> = {};
  const notes: string[] = [];
  for (const [key, r] of Object.entries(resolveEnvironmentEach(self, BUILD, conn.peers, {}))) {
    if ("error" in r) throw new Error(`build environment: ${r.error}`);
    out[key] = r.value;
    if (r.value === "" && findReferences(values[key]!).length > 0) notes.push(`${key} is empty: ${findReferences(values[key]!).map((x) => x.text).join(", ")} has no domain yet`);
  }
  return { environment: out, notes };
}
