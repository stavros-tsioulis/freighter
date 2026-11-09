import { rm, writeFile } from "node:fs/promises";
import { parseManifest, routedServices, routingProblems, routingWarnings, type Domain, type DomainInput } from "@freighter/manifest";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { ensureApp } from "./app.ts";
import { assertHostnamesFree, parseDomains, readDomains, writeDomains } from "./domains.ts";
import { goLive, liveTargets, ownedUnits, plannedUnits } from "./apply.ts";
import { missingSecrets } from "./env.ts";
import { containersAvailable, ensureContainerRuntime, imageServices, NO_CONTAINERS_MESSAGE, pruneImages, pullImages, writeContainerPorts, writeImages, type RegistryAuth } from "./image.ts";
import { recordHistory, type SourceMeta } from "./history.ts";
import { withLock } from "./lock.ts";
import { allocateReleaseId, currentRelease, newReleaseId, pruneReleases, releaseDir, stageEmptyRelease, stageRelease } from "./releases.ts";
import { describeFailures, verifyRelease } from "./verify.ts";
import { loadReleaseManifest } from "./apply.ts";

export interface DeployOptions {
  manifestText: string;
  /** Directory or .tar.gz/.tgz artifact. Optional for a manifest whose services are all images (nothing to stage). */
  source?: string;
  /** Credentials for the registry the images come from (only used while pulling). */
  registryAuth?: RegistryAuth[];
  dryRun?: boolean;
  /** Skip health verification (and therefore automatic rollback). */
  skipVerify?: boolean;
  /** Provenance of the artifact (recorded in the history and next to the release). */
  meta?: SourceMeta;
  /** The source directory is a throw-away build dir: move it into the release instead of copying. */
  moveSource?: boolean;
  /**
   * Replace the app's domains as part of this deploy. They are saved only if the release goes live; when it
   * fails, the previous domains are restored along with the previous release.
   */
  domains?: DomainInput[];
  /** Where to write what the deploy is doing (the dashboard shows it as the deployment's log). */
  log?: DeployLog;
}

export interface DeployResult {
  app: string;
  releaseId: string;
  previous: string | null;
  units: string[];
  removed: string[];
  pruned: string[];
  hostnames: string[];
  warnings: string[];
  verified: boolean;
  dryRun: boolean;
  /** Timestamp of the history entry this deploy wrote (links registry rows to history.jsonl). */
  historyAt?: string;
}

export class DeployFailedError extends Error {
  constructor(
    message: string,
    readonly rolledBackTo: string | null,
    readonly releaseId: string,
    readonly historyAt: string,
  ) {
    super(message);
    this.name = "DeployFailedError";
  }
}

export async function deploy(d: Deps, opts: DeployOptions): Promise<DeployResult> {
  if (!d.isRoot) throw new Error("deploy must run as root (or use --prefix for a dry local run)");
  const manifest = parseManifest(opts.manifestText);
  const app = manifest.name;

  const hasImages = Object.keys(imageServices(manifest)).length > 0;
  if (hasImages && !(await containersAvailable(d)).available) throw new Error(NO_CONTAINERS_MESSAGE);
  if (opts.source === undefined && Object.values(manifest.services).some((s) => s.image === undefined)) {
    throw new Error("an artifact is required: this app has services that run a command");
  }

  const missing = await missingSecrets(d, manifest);
  if (missing.length > 0) {
    throw new Error(`missing secrets for ${app}: ${missing.join(", ")} (set with: freighter env set ${app} KEY)`);
  }

  const previousDomains = await readDomains(d, app);
  const domains: Domain[] = opts.domains ? parseDomains(opts.domains) : previousDomains;
  const problems = routingProblems(manifest, domains);
  if (problems.length > 0) throw new Error(problems.join("; "));
  await assertHostnamesFree(d, app, domains);

  const routed = routedServices(domains);
  const warnings: string[] = routingWarnings(manifest, domains);
  if (manifest.build && !opts.meta) warnings.push("build commands only run for git deployments; this artifact is deployed as is");
  for (const [name, s] of Object.entries(manifest.services)) {
    if (s.replicas > 1) warnings.push(`service ${name}: replicas > 1 is not supported yet; running one instance`);
    if (routed.has(name) && s.port !== undefined) warnings.push(`service ${name}: port is ignored for routed services; listen on $PORT`);
  }
  const hostnames = domains.map((x) => x.hostname);

  const base: DeployResult = {
    app,
    releaseId: "",
    previous: await currentRelease(d, app),
    units: [],
    removed: [],
    pruned: [],
    hostnames,
    warnings,
    verified: false,
    dryRun: opts.dryRun ?? false,
  };
  if (opts.dryRun) {
    const releaseId = newReleaseId(d.now());
    const units = plannedUnits(app, manifest, releaseId, domains).map((p) => p.unit);
    const removed = (await ownedUnits(d, app)).filter((u) => !units.includes(u));
    return { ...base, releaseId, units, removed };
  }

  const log = opts.log ?? noLog;
  await ensureApp(d, app);
  return withLock(d, app, async () => {
    const previous = await currentRelease(d, app);
    const releaseId = await allocateReleaseId(d, app);
    await log(`==> staging release ${releaseId}${previous ? ` (current is ${previous})` : " (the first one)"}`);
    if (opts.source === undefined) await stageEmptyRelease(d, app, releaseId);
    else await stageRelease(d, app, opts.source, releaseId, { move: opts.moveSource });
    await writeFile(`${releaseDir(d, app, releaseId)}/app.yaml`, opts.manifestText);
    if (opts.meta) await writeFile(`${releaseDir(d, app, releaseId)}/.freighter-source.json`, JSON.stringify(opts.meta));

    const changesDomains = opts.domains !== undefined;
    let live;
    try {
      if (hasImages) {
        await ensureContainerRuntime(d, app, manifest);
        const { images, containerPorts } = await pullImages(d, app, manifest, { auth: opts.registryAuth, log });
        await writeImages(d, app, releaseId, images);
        await writeContainerPorts(d, app, releaseId, containerPorts);
      }
      if (changesDomains) await writeDomains(d, app, domains);
      live = await goLive(d, app, releaseId, { skipVerify: opts.skipVerify, previous, previousDomains, log });
    } catch (e) {
      if (changesDomains) await writeDomains(d, app, previousDomains);
      await rm(releaseDir(d, app, releaseId), { recursive: true, force: true });
      throw e;
    }
    const result: DeployResult = { ...base, releaseId, previous };

    if (live.ok) {
      await log(`==> release ${releaseId} is live`);
      const entry = await recordHistory(d, app, { action: "deploy", release: releaseId, previous, result: "success", source: opts.meta });
      result.historyAt = entry.at;
      result.units = live.units;
      result.removed = live.retired;
      result.verified = !opts.skipVerify;
      result.pruned = await pruneReleases(d, app, manifest.releases.keep, [releaseId, ...(previous ? [previous] : [])]);
      if (hasImages && result.pruned.length > 0) await pruneImages(d, app).catch(() => undefined);
      return result;
    }

    if (changesDomains) await writeDomains(d, app, previousDomains);
    await log(`==> release ${releaseId} failed${previous ? `; going back to ${previous}` : ""}`);
    const reason = live.failures.map((f) => `${f.service}: ${f.reason}`).join("; ");
    const failed = await recordHistory(d, app, { action: "deploy", release: releaseId, previous, result: "failed", reason, source: opts.meta });
    let tail: string;
    if (previous) {
      // goLive already put the previous release back; confirm it is healthy.
      const prev = await loadReleaseManifest(d, app, previous);
      const back = await verifyRelease(d, app, prev, await liveTargets(d, app, prev));
      await recordHistory(d, app, {
        action: "rollback",
        release: previous,
        previous: releaseId,
        result: back.ok ? "success" : "failed",
        reason: back.ok ? "automatic rollback after failed deploy" : back.failures.map((f) => `${f.service}: ${f.reason}`).join("; "),
      });
      await log(back.ok ? `    ${previous} is running again and healthy` : `    ${previous} is running again, but is NOT healthy either:\n${describeFailures(back.failures)}`);
      tail = back.ok
        ? `rolled back to ${previous}`
        : `rolled back to ${previous}, but it is NOT healthy either:\n${describeFailures(back.failures)}`;
    } else {
      tail = "first deploy: services stopped";
    }
    throw new DeployFailedError(`deploy of ${releaseId} failed:\n${describeFailures(live.failures)}\n${tail}`, previous, releaseId, failed.at);
  });
}
