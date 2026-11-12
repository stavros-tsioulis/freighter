import { readFile, readdir } from "node:fs/promises";
import { ensureChallengeToken, renderHostnameMap, renderHttpsMap, renderBackends } from "@freighter/haproxy";
import { parseManifest, routedServices, volumePaths, type Connections, type Domain, type Manifest } from "@freighter/manifest";
import { renderUnit, sharedDir, unitName } from "@freighter/systemd";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { assertHostnamesFree, readDomains } from "./domains.ts";
import { readContainerPorts, readImages } from "./image.ts";
import { allocatePort, assignedPort } from "./ports.ts";
import { readConnections } from "./connections.ts";
import { readVariables, type Variables } from "./variables.ts";
import { resolveEnvironmentSplit } from "./references.ts";
import { writeRefsEnv } from "./env.ts";
import { retireMounts, syncVolumes } from "./volumes.ts";
import { hashResolved, writeResolvedHash } from "./reapply.ts";
import { activate, releaseDir } from "./releases.ts";
import { allStates, readState, routesFrom, writeState, type AppState, type RoutedService } from "./state.ts";
import { defaultTargets, describeFailures, verifyRelease, type Target, type VerifyFailure } from "./verify.ts";

/** Units on disk that carry this app's ownership marker (see renderUnit). */
export async function ownedUnits(d: Deps, app: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(d.layout.unitDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const owned: string[] = [];
  for (const f of files.filter((f) => /^freighter-.*\.service$/.test(f))) {
    const text = await readFile(`${d.layout.unitDir}/${f}`, "utf8");
    if (text.split("\n").includes(`X-Freighter-App=${app}`)) owned.push(f);
  }
  return owned;
}

export async function loadReleaseManifest(d: Deps, app: string, id: string): Promise<Manifest> {
  return parseManifest(await readFile(`${releaseDir(d, app, id)}/app.yaml`, "utf8"), { legacy: true });
}

/** Unit names a release would use (routed services get an instance unit per release). */
export function plannedUnits(app: string, manifest: Manifest, id: string, domains: readonly Domain[]): { service: string; unit: string; routed: boolean }[] {
  const routed = routedServices(domains);
  return Object.keys(manifest.services).map((service) => {
    const isRouted = routed.has(service);
    return { service, routed: isRouted, unit: unitName({ app, service, instance: isRouted ? id : undefined }) };
  });
}

/** Stop, disable and delete every owned unit that is not in `keep`. Returns what was removed. */
export async function retire(d: Deps, app: string, keep: Set<string>): Promise<string[]> {
  const doomed = (await ownedUnits(d, app)).filter((u) => !keep.has(u));
  for (const unit of doomed) {
    await d.systemd.stop(unit);
    await d.systemd.disable(unit);
    await d.systemd.removeUnit(unit);
  }
  return doomed;
}

export async function writeRoutes(d: Deps, app: string, routed: Record<string, RoutedService>): Promise<void> {
  const states = await allStates(d);
  states[app] = { routed };
  const routes = routesFrom(states);
  await d.haproxy.apply({
    hostnameMap: renderHostnameMap(routes),
    httpsMap: renderHttpsMap(routes),
    backends: renderBackends(routes, { acmePort: d.config.acme.challengePort, challengeToken: await ensureChallengeToken(d.config.haproxy.dir) }),
  });
}

/** Regenerate and apply the HAProxy files from the recorded state of every app. */
export async function haproxySync(d: Deps): Promise<{ changed: boolean; routes: number }> {
  const routes = routesFrom(await allStates(d));
  const { changed } = await d.haproxy.apply({
    hostnameMap: renderHostnameMap(routes),
    httpsMap: renderHttpsMap(routes),
    backends: renderBackends(routes, { acmePort: d.config.acme.challengePort, challengeToken: await ensureChallengeToken(d.config.haproxy.dir) }),
  });
  return { changed, routes: routes.length };
}

/** Targets for the services that are live right now (routed ones from state, the rest in place). */
export async function liveTargets(d: Deps, app: string, manifest: Manifest): Promise<Record<string, Target>> {
  const state = await readState(d, app);
  const targets = defaultTargets(app, manifest);
  for (const [service, port] of Object.entries(state.assigned ?? {})) if (service in targets && targets[service]!.port === undefined) targets[service] = { ...targets[service]!, port };
  for (const [service, r] of Object.entries(state.routed)) if (service in targets) targets[service] = { unit: r.unit, port: r.port };
  return targets;
}

/** The manifest with the variables added on the server laid over each service's `environment:` (which gives the initial values). */
export const withVariables = (manifest: Manifest, vars: Variables): Manifest => ({
  ...manifest,
  services: Object.fromEntries(Object.entries(manifest.services).map(([name, def]) => [name, { ...def, environment: { ...def.environment, ...vars[name] } }])),
});

/** What a service's environment resolved to: plain values for its unit, credentials for its root-only file. */
export type ResolvedEnv = { plain: Record<string, string>; secret: Record<string, string> };

/** Each service's environment with its connections (`@api.url`, ...) filled in, for the ports and domains in force. */
export function resolveAppEnvironment(d: Deps, manifest: Manifest, domains: readonly Domain[], targets: Record<string, Target>, conn: Connections = { peers: {} }): Record<string, ResolvedEnv> {
  const self = {
    name: manifest.name,
    server: conn.server,
    services: Object.keys(manifest.services),
    domains: [...domains],
    ports: Object.fromEntries(Object.entries(targets).map(([s, t]) => [s, t.port])),
    environment: Object.fromEntries(Object.entries(manifest.services).map(([s, def]) => [s, def.environment])),
    volumePaths: volumePaths(manifest, sharedDir(d.layout, manifest.name)),
  };
  return Object.fromEntries(Object.keys(manifest.services).map((service) => [service, resolveEnvironmentSplit(self, service, conn.peers, conn.storages)]));
}

/** Write each service's credentials from connections, removing the file of a service that has none. */
export async function writeRefsEnvs(d: Deps, app: string, env: Record<string, ResolvedEnv>): Promise<void> {
  for (const [service, e] of Object.entries(env)) await writeRefsEnv(d, app, service, e.secret);
}

export function render(d: Deps, app: string, manifest: Manifest, env: Record<string, ResolvedEnv>, service: string, id: string, unit: { routed: boolean }, images: Record<string, string>, containerPorts: Record<string, number>, port?: number) {
  return renderUnit({
    containerPort: containerPorts[service],
    image: images[service],
    secrets: manifest.services[service]!.secrets,
    app,
    service,
    def: manifest.services[service]!,
    layout: d.layout,
    release: id,
    instance: unit.routed ? id : undefined,
    port,
    loopback: unit.routed,
    environment: env[service]!.plain,
    refSecrets: Object.keys(env[service]!.secret),
    remoteVolumes: Object.keys(manifest.volumes),
  });
}

/** Put the previous release's in-place services back and drop units that only the failed release introduced. */
async function restoreInPlace(d: Deps, app: string, previous: string, domains: readonly Domain[], conn: Connections): Promise<void> {
  const manifest = await loadReleaseManifest(d, app, previous);
  const images = await readImages(d, app, previous);
  const containerPorts = await readContainerPorts(d, app, previous);
  const state = await readState(d, app);
  const keep = new Set(Object.values(state.routed).map((r) => r.unit));
  const environment = resolveAppEnvironment(d, withVariables(manifest, await readVariables(d, app)), domains, await liveTargets(d, app, manifest), conn);
  await writeRefsEnvs(d, app, environment);
  for (const p of plannedUnits(app, manifest, previous, domains).filter((p) => !p.routed)) {
    await d.systemd.installUnit(p.unit, render(d, app, manifest, environment, p.service, previous, p, images, containerPorts));
    await d.systemd.enable(p.unit);
    await d.systemd.restart(p.unit);
    keep.add(p.unit);
  }
  await retire(d, app, keep);
}

export type GoLiveResult =
  | { ok: true; manifest: Manifest; units: string[]; retired: string[] }
  | { ok: false; manifest: Manifest; failures: VerifyFailure[] };

/**
 * Make a staged release live. Routed services start as new instances on fresh ports and only receive traffic
 * after verification; in-place services are restarted. On failure the old instances keep serving.
 */
export async function goLive(
  d: Deps,
  app: string,
  id: string,
  opts: { skipVerify?: boolean; previous: string | null; /** The domains in force before this change, for restoring services if it fails (default: the current ones). */ previousDomains?: readonly Domain[]; log?: DeployLog; /** The apps and server around this one, for resolving connections in the environment. */ connections?: Connections; /** Stops waiting for the new release to become healthy (it is then rolled back). */ signal?: AbortSignal },
): Promise<GoLiveResult> {
  const log = opts.log ?? noLog;
  const manifest = await loadReleaseManifest(d, app, id);
  const images = await readImages(d, app, id);
  const containerPorts = await readContainerPorts(d, app, id);
  const domains = await readDomains(d, app);
  const plan = plannedUnits(app, manifest, id, domains);
  await assertHostnamesFree(d, app, domains);

  if (!d.dev) {
    for (const hostname of domains.filter((x) => x.tls === "auto").map((x) => x.hostname)) {
      await log(`==> certificate for ${hostname} (issued if missing or due, otherwise kept)`);
      await d.issueCert(hostname);
    }
  }

  const oldState = await readState(d, app);
  const reserved = new Set<number>();
  const targets: Record<string, Target> = {};
  const assigned: Record<string, number> = {};
  for (const p of plan) {
    const set = manifest.services[p.service]!.port;
    let port: number | undefined;
    if (p.routed) port = await allocatePort(d, reserved);
    else if (set !== undefined) port = set;
    else port = assigned[p.service] = await assignedPort(d, app, oldState.assigned?.[p.service], reserved);
    targets[p.service] = { unit: p.unit, port };
  }

  // Resolved before anything is touched: a connection that can't be resolved fails the deploy here.
  const conn = opts.connections ?? (await readConnections(d, app));
  const environment = resolveAppEnvironment(d, withVariables(manifest, await readVariables(d, app)), domains, targets, conn);
  await writeRefsEnvs(d, app, environment);
  await syncVolumes(d, app, manifest);

  const created: string[] = [];
  const failWith = async (failures: VerifyFailure[]): Promise<GoLiveResult> => {
    await log(`==> the new release did not come up; stopping its instances and keeping ${opts.previous ?? "nothing"} running`);
    for (const unit of created) {
      await d.systemd.stop(unit);
      await d.systemd.disable(unit);
      await d.systemd.removeUnit(unit);
    }
    if (opts.previous) await restoreInPlace(d, app, opts.previous, opts.previousDomains ?? domains, conn);
    else for (const p of plan.filter((x) => !x.routed)) await d.systemd.stop(p.unit);
    return { ok: false, manifest, failures };
  };

  for (const p of plan) {
    await d.systemd.installUnit(p.unit, render(d, app, manifest, environment, p.service, id, p, images, containerPorts, targets[p.service]!.port));
    await d.systemd.enable(p.unit);
  }
  for (const p of plan) {
    if (p.routed) {
      await log(`==> starting ${p.service} as a new instance (${p.unit}) on port ${targets[p.service]!.port}`);
      await d.systemd.start(p.unit);
      created.push(p.unit);
    } else {
      await log(`==> restarting ${p.service} in place (${p.unit})`);
      await d.systemd.restart(p.unit);
    }
  }

  if (!opts.skipVerify) {
    await log(`==> waiting for ${plan.length === 1 ? "the service" : `${plan.length} services`} to be healthy`);
    const check = await verifyRelease(d, app, manifest, targets, opts.signal);
    if (!check.ok) {
      await log(describeFailures(check.failures));
      return failWith(check.failures);
    }
    await log("    healthy");
  } else {
    await log("==> skipping the health check");
  }

  const routed: Record<string, RoutedService> = {};
  for (const p of plan.filter((x) => x.routed)) {
    routed[p.service] = {
      unit: p.unit,
      port: targets[p.service]!.port!,
      release: id,
      hostnames: domains.filter((x) => x.service === p.service).map((x) => ({ hostname: x.hostname, tls: x.tls })),
      healthPath: manifest.services[p.service]!.healthcheck?.path,
      timeout: manifest.services[p.service]!.proxy?.timeout,
    };
  }
  const touchesProxy = Object.keys(routed).length > 0 || Object.keys(oldState.routed).length > 0;
  try {
    if (touchesProxy) {
      const names = Object.values(routed).flatMap((r) => r.hostnames.map((h) => h.hostname));
      await log(`==> switching HAProxy${names.length ? ` to ${names.join(", ")}` : ""} (checked, then reloaded)`);
      await writeRoutes(d, app, routed);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await log(`    HAProxy refused the change: ${reason}`);
    return failWith([{ service: "haproxy", reason, logs: "" }]);
  }
  const state: AppState = { routed, assigned, at: Object.fromEntries(plan.filter((p) => !p.routed).map((p) => [p.service, id])) };
  await writeState(d, app, state);
  await activate(d, app, id);
  await writeResolvedHash(d, app, hashResolved(environment));
  await retireMounts(d, app, Object.keys(manifest.volumes));

  const oldInstances = Object.values(oldState.routed).filter((r) => !(r.unit in Object.fromEntries(plan.map((p) => [p.unit, 1]))));
  if (oldInstances.length > 0) {
    await log(`==> letting requests in flight finish on the old instance${oldInstances.length === 1 ? "" : "s"} (${d.config.drainSeconds}s)`);
    await d.sleep(d.config.drainSeconds * 1000);
  }
  const retired = await retire(d, app, new Set(plan.map((p) => p.unit)));
  if (retired.length > 0) await log(`==> stopped and removed ${retired.join(", ")}`);
  return { ok: true, manifest, units: plan.map((p) => p.unit), retired };
}
