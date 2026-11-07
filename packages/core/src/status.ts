import { readFile, readdir } from "node:fs/promises";
import { parseManifest, type Manifest } from "@freighter/manifest";
import { unitName, type UnitStatus } from "@freighter/systemd";
import type { Deps } from "./deps.ts";
import { currentLink, currentRelease, listReleaseIds, listReleases, type ReleaseInfo } from "./releases.ts";
import { readState, resolveUnit } from "./state.ts";

export async function loadCurrentManifest(d: Deps, app: string): Promise<Manifest> {
  try {
    return parseManifest(await readFile(`${currentLink(d, app)}/app.yaml`, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`app "${app}" is not deployed`);
    throw e;
  }
}

export interface ServiceStatus extends UnitStatus {
  unit: string;
  port?: number;
  hostnames: string[];
}

export interface AppStatus {
  app: string;
  release: string | null;
  previous: string | null;
  services: Record<string, ServiceStatus>;
}

export const resolveServiceUnit = (d: Deps, app: string, service: string) =>
  resolveUnit(d, app, service, (s) => unitName({ app, service: s }));

export async function appStatus(d: Deps, app: string): Promise<AppStatus> {
  const manifest = await loadCurrentManifest(d, app);
  const state = await readState(d, app);
  const services: Record<string, ServiceStatus> = {};
  for (const [service, def] of Object.entries(manifest.services)) {
    const routed = state.routed[service];
    const unit = routed?.unit ?? unitName({ app, service });
    services[service] = {
      ...(await d.systemd.status(unit)),
      unit,
      port: routed?.port ?? def.port,
      hostnames: routed?.hostnames.map((h) => h.hostname) ?? [],
    };
  }
  const release = await currentRelease(d, app);
  const ids = await listReleaseIds(d, app);
  const previous = release ? (ids.filter((id) => id < release).at(-1) ?? null) : null;
  return { app, release, previous, services };
}

export async function controlApp(
  d: Deps,
  app: string,
  verb: "start" | "stop" | "restart",
  service?: string,
): Promise<string[]> {
  const manifest = await loadCurrentManifest(d, app);
  const names = service ? [service] : Object.keys(manifest.services);
  const units: string[] = [];
  for (const s of names) {
    if (!(s in manifest.services)) throw new Error(`unknown service "${s}" (have: ${Object.keys(manifest.services).join(", ")})`);
    units.push(await resolveServiceUnit(d, app, s));
  }
  for (const u of units) await d.systemd[verb](u);
  return units;
}

/** Apps known to this host (directories under appsRoot that have a releases dir). */
export async function listApps(d: Deps): Promise<string[]> {
  try {
    const entries = await readdir(d.layout.appsRoot, { withFileTypes: true });
    const apps: string[] = [];
    for (const e of entries.filter((e) => e.isDirectory() && !e.name.startsWith("."))) {
      if ((await listReleaseIds(d, e.name)).length > 0) apps.push(e.name);
    }
    return apps.sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export interface AppInfo extends Omit<AppStatus, "services"> {
  manifestText: string | null;
  services: AppStatus["services"];
  releases: ReleaseInfo[];
}

/** Like appStatus, but tolerant of an app with no live release (e.g. its first deploy failed). */
export async function appInfo(d: Deps, app: string): Promise<AppInfo> {
  const release = await currentRelease(d, app);
  const releases = await listReleases(d, app);
  if (release === null) return { app, release: null, previous: null, manifestText: null, services: {}, releases };
  const status = await appStatus(d, app);
  const manifestText = await readFile(`${currentLink(d, app)}/app.yaml`, "utf8");
  return { ...status, manifestText, releases };
}
