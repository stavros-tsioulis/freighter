import { readFile, rm, writeFile } from "node:fs/promises";
import { parseManifest, routingProblems, type Manifest } from "@freighter/manifest";
import { unitName } from "@freighter/systemd";
import { loadReleaseManifest, plannedUnits, render, resolveAppEnvironment, retire, withVariables, writeRoutes, type ResolvedEnv } from "./apply.ts";
import { readConnections } from "./connections.ts";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { DeployFailedError, type DeployResult } from "./deploy.ts";
import { readDomains } from "./domains.ts";
import { missingSecrets, refsEnvPath, refsEnvText } from "./env.ts";
import { readContainerPorts, readImages } from "./image.ts";
import { recordHistory, type SourceMeta } from "./history.ts";
import { withLock } from "./lock.ts";
import { stopIfCanceled } from "./operations.ts";
import { allocatePort, assignedPort } from "./ports.ts";
import { hashResolved, writeResolvedHash } from "./reapply.ts";
import { activate, allocateReleaseId, cloneRelease, currentRelease, pruneReleases, releaseDir } from "./releases.ts";
import { readState, releasesInUse, writeState, type RoutedService } from "./state.ts";
import { describeFailures, verifyRelease, type Target, type VerifyFailure } from "./verify.ts";
import { readVariables } from "./variables.ts";
import { missingVolumePasswords } from "./volumes.ts";
import { writeRefsEnv } from "./env.ts";

/**
 * Change an app's services without a deploy of its code: the same files, a new `app.yaml`. The new release is a link
 * farm of the running one (no copy, no build), and only the services whose unit would actually differ are touched: a
 * new service is started, a changed one is restarted (a routed one as a new instance, health-checked before HAProxy
 * switches), and the rest keep running exactly as they are, from the release they were started from. If a changed
 * service does not come up, only those are put back.
 *
 * Returns null when the change is more than a configuration (an image to pull, remote volumes) or the app is not in a
 * state this can reason about; the caller then does a full deploy. It never does less than a deploy would: anything it
 * cannot tell is the same counts as changed.
 */
export async function reconfigure(
  d: Deps,
  app: string,
  manifestText: string,
  opts: { skipVerify?: boolean; log?: DeployLog; signal?: AbortSignal; meta?: SourceMeta; connections?: Awaited<ReturnType<typeof readConnections>> } = {},
): Promise<DeployResult | null> {
  if (!d.isRoot) return null;
  const log = opts.log ?? noLog;
  const current = await currentRelease(d, app);
  if (!current) return null;
  const incoming = parseManifest(manifestText, { legacy: true });
  if (incoming.name !== app) return null;
  const running = await loadReleaseManifest(d, app, current);
  if (!fastEnough(running, incoming)) return null;
  const domains = await readDomains(d, app);
  const problems = routingProblems(incoming, domains);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const state0 = await readState(d, app);
  for (const [name, def] of Object.entries(incoming.services)) {
    if (def === undefined) continue;
    const wantsRoute = domains.some((x) => x.service === name);
    if (wantsRoute && !(name in state0.routed)) return null; // not running as a routed instance yet: a deploy sets that up
  }
  const missing = await missingSecrets(d, incoming);
  if (missing.length > 0) throw new Error(`missing secrets for ${app}: ${missing.join(", ")} (set with: freighter env set ${app} SERVICE KEY)`);
  const noPassword = await missingVolumePasswords(d, incoming);
  if (noPassword.length > 0) throw new Error(`missing passwords for volumes of ${app}: ${noPassword.join(", ")} (set them on the app's Settings tab)`);

  return withLock(d, app, async () => {
    const previous = (await currentRelease(d, app))!;
    const state = await readState(d, app);
    const id = await allocateReleaseId(d, app);
    await log(`==> new release ${id} from ${previous}: the same files, a new configuration`);
    await cloneRelease(d, app, previous, id);
    const dir = releaseDir(d, app, id);
    // The files are shared with the running release, so app.yaml is replaced, never written through.
    await rm(`${dir}/app.yaml`, { force: true });
    await writeFile(`${dir}/app.yaml`, manifestText);
    const cleanup = () => rm(dir, { recursive: true, force: true });

    try {
      stopIfCanceled(opts.signal);
      const manifest = await loadReleaseManifest(d, app, id);
      const images = await readImages(d, app, id);
      const containerPorts = await readContainerPorts(d, app, id);
      const vars = await readVariables(d, app);
      const conn = opts.connections ?? (await readConnections(d, app));
      const plan = plannedUnits(app, manifest, id, domains);

      // What is installed now, to tell what would change.
      const installed = new Map<string, string>();
      for (const unit of new Set([...Object.values(state.routed).map((r) => r.unit), ...Object.keys(running.services).map((s) => unitName({ app, service: s }))])) {
        const text = await readFile(`${d.layout.unitDir}/${unit}`, "utf8").catch(() => null);
        if (text !== null) installed.set(unit, text);
      }
      const oldRefs = new Map<string, string | null>();
      for (const s of new Set([...Object.keys(running.services), ...Object.keys(manifest.services)])) oldRefs.set(s, await readFile(refsEnvPath(d, app, s), "utf8").catch(() => null));

      // Where each service stands: its unit, port and the release its unit is written for. Everything starts unchanged.
      interface Slot { service: string; routed: boolean; unit: string; port: number | undefined; release: string; changed: boolean; isNew: boolean }
      const reserved = new Set<number>();
      const assigned: Record<string, number> = {};
      const slots = new Map<string, Slot>();
      for (const p of plan) {
        const def = manifest.services[p.service]!;
        const isNew = !(p.service in running.services);
        if (p.routed) {
          const old = state.routed[p.service]!;
          slots.set(p.service, { service: p.service, routed: true, unit: old.unit, port: old.port, release: old.release, changed: false, isNew: false });
        } else {
          const port = def.port ?? (isNew ? undefined : state.assigned?.[p.service]);
          const slot: Slot = { service: p.service, routed: false, unit: p.unit, port, release: state.at?.[p.service] ?? previous, changed: isNew, isNew };
          if (def.port === undefined) slot.port = assigned[p.service] = await assignedPort(d, app, port, reserved);
          else slot.port = def.port;
          if (isNew) slot.release = id;
          slots.set(p.service, slot);
        }
      }
      const targets = () => Object.fromEntries([...slots.values()].map((s) => [s.service, { unit: s.unit, port: s.port } satisfies Target]));
      const textOf = (env: Record<string, ResolvedEnv>, s: Slot) => render(d, app, manifest, env, s.service, s.release, { routed: s.routed }, images, containerPorts, s.port);

      // A service whose unit (or credentials) would differ is changed. A routed one that changes gets a new instance on a
      // new port, which can change what others read of it, so this repeats until nothing more moves.
      let env: Record<string, ResolvedEnv> = {};
      for (let round = 0; round <= slots.size + 1; round++) {
        env = resolveAppEnvironment(d, withVariables(manifest, vars), domains, targets(), conn);
        let moved = false;
        for (const s of slots.values()) {
          if (s.changed) continue;
          const differs = textOf(env, s) !== installed.get(s.unit) || refsEnvText(env[s.service]!.secret) !== oldRefs.get(s.service);
          if (!differs) continue;
          s.changed = true;
          s.release = id;
          if (s.routed) {
            s.unit = unitName({ app, service: s.service, instance: id });
            s.port = await allocatePort(d, reserved);
          }
          moved = true;
        }
        if (!moved) break;
      }

      const changed = [...slots.values()].filter((s) => s.changed);
      const removedServices = Object.keys(running.services).filter((s) => !(s in manifest.services));
      await log(
        changed.length || removedServices.length
          ? `==> ${[changed.length ? `${changed.map((s) => s.service).join(", ")} ${changed.length === 1 ? "changes" : "change"}` : "", removedServices.length ? `${removedServices.join(", ")} ${removedServices.length === 1 ? "is" : "are"} removed` : ""].filter(Boolean).join("; ")}; the other services keep running as they are`
          : "==> no service is affected: only the configuration is recorded",
      );

      stopIfCanceled(opts.signal);
      // Credentials first (changed services read them when they start), remembered for putting back.
      for (const [service, e] of Object.entries(env)) await writeRefsEnv(d, app, service, e.secret);
      const restoreRefs = async () => {
        for (const [service, text] of oldRefs) {
          if (text === null) await rm(refsEnvPath(d, app, service), { force: true });
          else await writeFile(refsEnvPath(d, app, service), text, { mode: 0o600 });
        }
      };

      const created: string[] = [];
      const touched: Slot[] = [];
      const fail = async (failures: VerifyFailure[]) => {
        await log("==> the changed services did not come up; putting them back and leaving the rest alone");
        await restoreRefs(); // before they are started again, so they read what they read before
        for (const unit of created) {
          await d.systemd.stop(unit);
          await d.systemd.disable(unit);
          await d.systemd.removeUnit(unit);
        }
        for (const s of touched) {
          if (s.routed) continue;
          const before = installed.get(s.unit);
          if (before === undefined) {
            await d.systemd.stop(s.unit);
            await d.systemd.disable(s.unit);
            await d.systemd.removeUnit(s.unit);
          } else {
            await d.systemd.installUnit(s.unit, before);
            await d.systemd.enable(s.unit);
            await d.systemd.restart(s.unit);
          }
        }
        return failures;
      };

      const routed: Record<string, RoutedService> = {};
      try {
      for (const s of changed) {
        touched.push(s);
        await d.systemd.installUnit(s.unit, textOf(env, s));
        await d.systemd.enable(s.unit);
      }
      for (const s of changed) {
        if (s.routed) {
          await log(`==> starting ${s.service} as a new instance (${s.unit}) on port ${s.port}`);
          await d.systemd.start(s.unit);
          created.push(s.unit);
        } else {
          await log(`==> ${s.isNew ? "starting" : "restarting"} ${s.service} (${s.unit})`);
          await d.systemd.restart(s.unit);
        }
      }

      if (!opts.skipVerify && changed.length > 0) {
        await log(`==> waiting for ${changed.length === 1 ? "the service" : `${changed.length} services`} to be healthy`);
        const subset: Manifest = { ...manifest, services: Object.fromEntries(changed.map((s) => [s.service, manifest.services[s.service]!])) };
        const check = await verifyRelease(d, app, subset, targets(), opts.signal);
        if (!check.ok) {
          await log(describeFailures(check.failures));
          const failures = await fail(check.failures);
          const reason = failures.map((f) => `${f.service}: ${f.reason}`).join("; ");
          const entry = await recordHistory(d, app, { action: "deploy", release: id, previous, result: "failed", reason, source: opts.meta });
          throw new DeployFailedError(`deploy of ${id} failed:\n${describeFailures(failures)}\nthe changed services were put back; the others were not touched`, previous, id, entry.at);
        }
        await log("    healthy");
      }

      // Live: traffic follows the services that moved, and every unit's release is on record.
      for (const s of slots.values()) {
        if (!s.routed) continue;
        const def = manifest.services[s.service]!;
        routed[s.service] = {
          unit: s.unit,
          port: s.port!,
          release: s.release,
          hostnames: domains.filter((x) => x.service === s.service).map((x) => ({ hostname: x.hostname, tls: x.tls })),
          healthPath: def.healthcheck?.path,
          timeout: def.proxy?.timeout,
        };
      }
      if (JSON.stringify(routed) !== JSON.stringify(state.routed)) {
        try {
          await log("==> updating HAProxy (checked, then reloaded)");
          await writeRoutes(d, app, routed);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          await log(`    HAProxy refused the change: ${reason}`);
          const failures = await fail([{ service: "haproxy", reason, logs: "" }]);
          const entry = await recordHistory(d, app, { action: "deploy", release: id, previous, result: "failed", reason, source: opts.meta });
          throw new DeployFailedError(`deploy of ${id} failed:\n${describeFailures(failures)}`, previous, id, entry.at);
        }
      }
      await writeState(d, app, { routed, assigned, at: Object.fromEntries([...slots.values()].filter((s) => !s.routed).map((s) => [s.service, s.release])) });
      } catch (e) {
        // Something unexpected part-way: put the changed services back before reporting it.
        if (!(e instanceof DeployFailedError)) await fail([]).catch(() => undefined);
        throw e;
      }
      await activate(d, app, id);
      await writeResolvedHash(d, app, hashResolved(env));

      const replaced = Object.values(state.routed).filter((r) => !Object.values(routed).some((n) => n.unit === r.unit));
      if (replaced.length > 0) {
        await log(`==> letting requests in flight finish on the old instance${replaced.length === 1 ? "" : "s"} (${d.config.drainSeconds}s)`);
        await d.sleep(d.config.drainSeconds * 1000);
      }
      const retired = await retire(d, app, new Set([...slots.values()].map((s) => s.unit)));
      if (retired.length > 0) await log(`==> stopped and removed ${retired.join(", ")}`);

      const entry = await recordHistory(d, app, { action: "deploy", release: id, previous, result: "success", source: opts.meta });
      await log(`==> release ${id} is live`);
      const pruned = await pruneReleases(d, app, manifest.releases.keep, [id, previous, ...releasesInUse(await readState(d, app))]);
      return {
        app,
        releaseId: id,
        previous,
        units: [...slots.values()].map((s) => s.unit),
        removed: retired,
        pruned,
        hostnames: domains.map((x) => x.hostname),
        warnings: [],
        verified: !opts.skipVerify,
        dryRun: false,
        historyAt: entry.at,
      };
    } catch (e) {
      // Nothing of the new release is left when it did not go live (a deploy that failed has already put its units back).
      if ((await currentRelease(d, app)) !== id) await cleanup();
      throw e;
    }
  });
}

/** Whether the difference between two configurations needs nothing but unit changes: no image to pull, no volumes to mount. */
export function fastEnough(old: Manifest, next: Manifest): boolean {
  if (JSON.stringify(old.volumes) !== JSON.stringify(next.volumes)) return false;
  for (const [name, def] of Object.entries(next.services)) {
    if (def.image !== undefined && old.services[name]?.image !== def.image) return false;
  }
  return true;
}
