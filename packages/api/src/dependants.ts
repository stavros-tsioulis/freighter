import { findReferences, parseManifest } from "@freighter/manifest";
import type { AppRow } from "@freighter/registry";
import type { ApiContext } from "./context.ts";
import { storedVariables } from "./connections.ts";

/** What changed, for finding who depends on it: an app's services (`@app/service...`) or an S3 storage (`@storage:name...`). */
export type Dependency = { app: string } | { storage: string };

/**
 * The deployed apps whose environment, from app.yaml or from variables added in the dashboard, refers to `dep`. An app's
 * references to its own services are handled when it is deployed, so it is never its own dependant.
 */
export async function dependantsOf(ctx: ApiContext, dep: Dependency): Promise<AppRow[]> {
  const out: AppRow[] = [];
  for (const row of ctx.registry.apps.list()) {
    if (!row.manifestText || !row.currentRelease || ("app" in dep && row.name === dep.app)) continue;
    let env: Record<string, string>;
    try {
      env = { ...parseManifest(row.manifestText, { legacy: true }).environment, ...(await storedVariables(ctx, row.server, row.name)) };
    } catch {
      continue;
    }
    const uses = Object.values(env).some((v) => findReferences(v).some((r) => ("storage" in dep ? r.storage === dep.storage : r.storage === undefined && r.app === dep.app)));
    if (uses) out.push(row);
  }
  return out;
}
