import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { Route } from "@freighter/haproxy";
import type { Deps } from "./deps.ts";
import { appDir } from "./releases.ts";

export interface RoutedService {
  unit: string;
  port: number;
  release: string;
  hostnames: { hostname: string; tls: "auto" | "off" }[];
  healthPath?: string;
  timeout?: string;
}
export interface AppState {
  routed: Record<string, RoutedService>;
}

const statePath = (d: Deps, app: string) => `${appDir(d, app)}/state.json`;

export async function readState(d: Deps, app: string): Promise<AppState> {
  try {
    return JSON.parse(await readFile(statePath(d, app), "utf8")) as AppState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { routed: {} };
    throw e;
  }
}

export async function writeState(d: Deps, app: string, state: AppState): Promise<void> {
  await mkdir(appDir(d, app), { recursive: true });
  const tmp = `${statePath(d, app)}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await rename(tmp, statePath(d, app));
}

export async function allStates(d: Deps): Promise<Record<string, AppState>> {
  let apps: string[];
  try {
    apps = (await readdir(d.layout.appsRoot, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  return Object.fromEntries(await Promise.all(apps.map(async (a) => [a, await readState(d, a)] as const)));
}

/** Flatten states into routes; a hostname claimed by two apps is an error. */
export function routesFrom(states: Record<string, AppState>): Route[] {
  const owner = new Map<string, string>();
  const routes: Route[] = [];
  for (const [app, st] of Object.entries(states)) {
    for (const [service, r] of Object.entries(st.routed)) {
      for (const { hostname, tls } of r.hostnames) {
        const other = owner.get(hostname);
        if (other !== undefined && other !== app) throw new Error(`hostname ${hostname} is already used by app "${other}"`);
        owner.set(hostname, app);
        routes.push({ app, service, hostname, tls, port: r.port, healthPath: r.healthPath, timeout: r.timeout });
      }
    }
  }
  return routes;
}

/** The unit currently serving a service (an instance unit if routed, the plain unit otherwise). */
export async function resolveUnit(d: Deps, app: string, service: string, fallback: (s: string) => string): Promise<string> {
  return (await readState(d, app)).routed[service]?.unit ?? fallback(service);
}
