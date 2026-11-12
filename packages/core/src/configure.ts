import { parseManifest } from "@freighter/manifest";
import { writeConfig, readConfig } from "./appconfig.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { reconfigure } from "./reconfigure.ts";
import type { RegistryAuth } from "./image.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { currentRelease, releaseDir } from "./releases.ts";
import { currentSource } from "./source.ts";

export interface SetConfigResult {
  /** The current release was redeployed with the new configuration; null for an app that isn't deployed yet. */
  deploy: DeployResult | null;
}

/**
 * Replace an app's configuration. It is saved first; a deployed app is then redeployed with its current release and the
 * new configuration (new instances, health check, rollback to the running release on failure).
 */
export async function setConfig(d: Deps, app: string, manifestText: string, opts: { skipVerify?: boolean; log?: DeployLog; signal?: AbortSignal; registryAuth?: RegistryAuth[] } = {}): Promise<SetConfigResult> {
  const log = opts.log ?? noLog;
  const manifest = parseManifest(manifestText);
  if (manifest.name !== app) throw new Error(`this configuration is for "${manifest.name}", not "${app}"`);
  const release = await currentRelease(d, app);
  if (!release) {
    await writeConfig(d, app, manifestText);
    await log("==> the app isn't deployed yet, so the configuration is saved and used by its first deploy");
    return { deploy: null };
  }
  // Kept at once, not only if the deploy works: what you entered stays what you see and edit, whatever the deploy does.
  // The running release keeps the app.yaml it started with (that is what a rollback goes back to).
  await writeConfig(d, app, manifestText);
  await log(`==> configuration of ${app} saved; redeploying the current release (${release}) with it`);
  // The same files with a new configuration: only the services that differ are touched, and nothing is copied or built.
  const meta = (await currentSource(d, app)) ?? undefined;
  const fast = await reconfigure(d, app, manifestText, { skipVerify: opts.skipVerify, log, signal: opts.signal, meta });
  if (fast) return { deploy: fast };
  const result = await deploy(d, {
    manifestText,
    source: releaseDir(d, app, release),
    meta,
    skipVerify: opts.skipVerify,
    config: "replace",
    log,
    signal: opts.signal,
    registryAuth: opts.registryAuth,
  });
  return { deploy: result };
}

/** The configuration as text, or null for an app that has none. */
export const getConfig = (d: Deps, app: string): Promise<string | null> => readConfig(d, app);
