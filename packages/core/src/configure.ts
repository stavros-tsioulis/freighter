import { parseManifest } from "@freighter/manifest";
import { writeConfig, readConfig } from "./appconfig.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { currentRelease, releaseDir } from "./releases.ts";
import { currentSource } from "./source.ts";

export interface SetConfigResult {
  /** The current release was redeployed with the new configuration; null for an app that isn't deployed yet. */
  deploy: DeployResult | null;
}

/**
 * Replace an app's configuration. A deployed app is redeployed with its current release and the new configuration (new
 * instances, health check, rollback on failure); the configuration is only kept if that works.
 */
export async function setConfig(d: Deps, app: string, manifestText: string, opts: { skipVerify?: boolean; log?: DeployLog; signal?: AbortSignal } = {}): Promise<SetConfigResult> {
  const log = opts.log ?? noLog;
  const manifest = parseManifest(manifestText);
  if (manifest.name !== app) throw new Error(`this configuration is for "${manifest.name}", not "${app}"`);
  const release = await currentRelease(d, app);
  if (!release) {
    await writeConfig(d, app, manifestText);
    await log("==> the app isn't deployed yet, so the configuration is saved and used by its first deploy");
    return { deploy: null };
  }
  await log(`==> configuration of ${app} changed; redeploying the current release (${release}) with it`);
  const result = await deploy(d, {
    manifestText,
    source: releaseDir(d, app, release),
    meta: (await currentSource(d, app)) ?? undefined,
    skipVerify: opts.skipVerify,
    config: "replace",
    log,
    signal: opts.signal,
  });
  return { deploy: result };
}

/** The configuration as text, or null for an app that has none. */
export const getConfig = (d: Deps, app: string): Promise<string | null> => readConfig(d, app);
