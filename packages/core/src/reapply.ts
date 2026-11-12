import { createHash } from "node:crypto";
import { reconfigure } from "./reconfigure.ts";
import type { RegistryAuth } from "./image.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { loadReleaseManifest, liveTargets, resolveAppEnvironment, withVariables, type ResolvedEnv } from "./apply.ts";
import { readConnections } from "./connections.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { readDomains } from "./domains.ts";
import { currentRelease, appDir, releaseDir } from "./releases.ts";
import { currentSource } from "./source.ts";
import { readVariables } from "./variables.ts";

/**
 * What an app's environment resolved to when it last went live, as a hash. Connections resolve to other apps' domains,
 * ports and credentials; when one of those moves, `reapply` compares against this to see whether the app has to be
 * redeployed, and leaves it alone when nothing it reads has changed.
 */
const hashPath = (d: Deps, app: string) => `${appDir(d, app)}/resolved.json`;

export function hashResolved(env: Record<string, ResolvedEnv>): string {
  const sorted = (m: Record<string, string>) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  const services = Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([service, e]) => [service, sorted(e.plain), sorted(e.secret)]);
  return createHash("sha256").update(JSON.stringify(services)).digest("hex");
}

export async function writeResolvedHash(d: Deps, app: string, hash: string): Promise<void> {
  await mkdir(appDir(d, app), { recursive: true });
  await writeFile(`${hashPath(d, app)}.tmp`, JSON.stringify({ hash }) + "\n");
  await rename(`${hashPath(d, app)}.tmp`, hashPath(d, app));
}

async function readResolvedHash(d: Deps, app: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(hashPath(d, app), "utf8")) as { hash?: string }).hash ?? null;
  } catch {
    return null;
  }
}

export interface ReapplyResult {
  changed: boolean;
  /** The redeploy of the current release, when something it reads had changed. */
  deploy: DeployResult | null;
}

/**
 * Re-resolve the connections of the live release against what the app knows now. If any value differs from what the
 * running services were given, the current release is redeployed unchanged (new instances, health check, rollback on
 * failure); if not, nothing happens. An app deployed before this was tracked just records its current state.
 */
export async function reapply(d: Deps, app: string, opts: { skipVerify?: boolean; log?: DeployLog; signal?: AbortSignal; registryAuth?: RegistryAuth[] } = {}): Promise<ReapplyResult> {
  const log = opts.log ?? noLog;
  const release = await currentRelease(d, app);
  if (!release) return { changed: false, deploy: null };
  const manifest = await loadReleaseManifest(d, app, release);
  const env = resolveAppEnvironment(d, withVariables(manifest, await readVariables(d, app)), await readDomains(d, app), await liveTargets(d, app, manifest), await readConnections(d, app));
  const hash = hashResolved(env);
  const before = await readResolvedHash(d, app);
  if (before === null) {
    await writeResolvedHash(d, app, hash);
    return { changed: false, deploy: null };
  }
  if (before === hash) return { changed: false, deploy: null };

  await log(`==> something ${app} connects to has changed; redeploying the current release (${release}) unchanged so its services pick it up`);
  const meta = (await currentSource(d, app)) ?? undefined;
  const fast = await reconfigure(d, app, await readFile(`${releaseDir(d, app, release)}/app.yaml`, "utf8"), { skipVerify: opts.skipVerify, log, signal: opts.signal, meta });
  if (fast) return { changed: true, deploy: fast };
  const dir = releaseDir(d, app, release);
  const result = await deploy(d, {
    manifestText: await readFile(`${dir}/app.yaml`, "utf8"),
    source: dir,
    meta,
    skipVerify: opts.skipVerify,
    log,
    signal: opts.signal,
    registryAuth: opts.registryAuth,
    legacy: true,
  });
  return { changed: true, deploy: result };
}
