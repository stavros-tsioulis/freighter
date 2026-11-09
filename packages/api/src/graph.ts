import { connectionEdges, isEnvAttr, parseManifest, storageApp, storageEdges, type Manifest } from "@freighter/manifest";
import type { ApiContext } from "./context.ts";

export interface GraphService {
  name: string;
  activeState: string;
  subState: string;
  port: number | null;
  hostnames: string[];
  restarts: number;
  memoryBytes: number | null;
  /** The image it runs, or null for a command service. */
  image: string | null;
  command: string | null;
}
export interface GraphApp {
  name: string;
  server: string;
  status: string;
  currentRelease: string | null;
  services: GraphService[];
}
export interface GraphEdge {
  from: { app: string; service: string };
  to: { app: string; service: string };
  attr: string;
  /** The environment entry that holds the reference. */
  key: string;
  /** Why the reference can't be resolved right now (a deploy would fail), if it can't. */
  broken: string | null;
}

export interface GraphStorage {
  name: string;
  kind: "local" | "sftp" | "smb";
  server: string;
  hostnames: string[];
  activeState: string;
}
export interface GraphStorageEdge {
  from: { app: string; service: string };
  storage: string;
  attr: string;
  key: string;
  broken: string | null;
}

/** The apps of one project (or of no project) with the connections between their services. */
export function buildGraph(ctx: ApiContext, projectId: string | null) {
  const known = new Set(ctx.registry.projects.list().map((p) => p.id));
  const rows = ctx.registry.apps
    .list()
    .filter((a) => (projectId === null ? a.projectId === null || !known.has(a.projectId) : a.projectId === projectId));

  const manifests = new Map<string, Manifest>();
  for (const a of rows) {
    if (!a.manifestText) continue;
    try {
      manifests.set(a.name, parseManifest(a.manifestText, { legacy: true }));
    } catch {
      // an unreadable manifest has no connections to show
    }
  }

  const apps: GraphApp[] = rows.map((a) => {
    const observed = new Map(ctx.registry.services.list(a.name).map((s) => [s.name, s]));
    const m = manifests.get(a.name);
    const names = [...new Set([...Object.keys(m?.services ?? {}), ...observed.keys()])];
    return {
      name: a.name,
      server: a.server,
      status: a.status,
      currentRelease: a.currentRelease,
      services: names.map((name) => {
        const s = observed.get(name);
        const def = m?.services[name];
        return {
          name,
          activeState: s?.activeState ?? "inactive",
          subState: s?.subState ?? "dead",
          port: s?.port ?? null,
          hostnames: s?.hostnames ?? [],
          restarts: s?.restarts ?? 0,
          memoryBytes: s?.memoryBytes ?? null,
          image: def?.image ?? null,
          command: def?.command ?? null,
        };
      }),
    };
  });
  const byName = new Map(apps.map((a) => [a.name, a]));

  const problem = (e: { from: { app: string }; to: { app: string; service: string }; attr: string }): string | null => {
    const target = byName.get(e.to.app);
    if (!target) return `app "${e.to.app}" is not in this project`;
    const svc = target.services.find((s) => s.name === e.to.service);
    if (!svc) return `app "${e.to.app}" has no service "${e.to.service}"`;
    if (e.attr === "domain" || e.attr === "url") return svc.hostnames.length ? null : `${e.to.service} has no domain yet`;
    if (e.attr === "internal" || e.attr === "port" || e.attr === "PORT") {
      if (svc.port === null) return `${e.to.service} has no port`;
      if (e.attr === "internal" && target.server !== byName.get(e.from.app)?.server) return `${e.to.app} runs on another server; use .url`;
      return null;
    }
    if (isEnvAttr(e.attr) && !(e.attr in (manifests.get(e.to.app)?.environment ?? {}))) return `${e.attr} is not set in the environment of ${e.to.app}`;
    return null;
  };

  const edges: GraphEdge[] = [...manifests.values()].flatMap((m) => connectionEdges(m)).map((e) => ({ ...e, broken: problem(e) }));

  // Storages are global: show the ones this project's apps use, with an arrow from each service that does.
  const storageRows = new Map(ctx.registry.storages.list().map((st) => [st.name, st]));
  const storageLinks: GraphStorageEdge[] = [...manifests.values()].flatMap((m) => storageEdges(m)).map((e) => {
    const st = storageRows.get(e.storage);
    let broken: string | null = null;
    if (!st) broken = `there is no storage "${e.storage}"`;
    else {
      const hostnames = ctx.registry.services.list(storageApp(st.name))[0]?.hostnames ?? [];
      if (e.attr === "domain" && !hostnames.length) broken = `${st.name} has no domain yet`;
      else if (e.attr === "internal" && st.server !== byName.get(e.from.app)?.server) broken = `${st.name} runs on another server; use .url`;
      else if (e.attr === "url" && !hostnames.length && st.server !== byName.get(e.from.app)?.server) broken = `${st.name} has no domain and runs on another server`;
    }
    return { ...e, broken };
  });
  const used = new Set(storageLinks.map((e) => e.storage));
  const storages: GraphStorage[] = [...used].flatMap((name) => {
    const st = storageRows.get(name);
    if (!st) return [];
    const svc = ctx.registry.services.list(storageApp(name))[0];
    return [{ name, kind: st.backend.kind, server: st.server, hostnames: svc?.hostnames ?? [], activeState: svc?.activeState ?? "inactive" }];
  });
  return { project: projectId, apps, edges, storages, storageEdges: storageLinks, layout: ctx.registry.layouts.get(projectId ?? "none") };
}
