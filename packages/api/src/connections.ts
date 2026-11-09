import { parseManifest, storageApp, volumePaths, type AppFacts, type Connections, type Manifest, type StorageFacts } from "@freighter/manifest";
import type { ApiContext } from "./context.ts";

/**
 * What an app's environment can read about the S3 storages (`@storage:name.url`). Storages are global, so every
 * storage is described, including its key pair; the agent keeps this file root-only. A storage whose server can't be
 * reached still resolves by its port, just without its domain.
 */
export async function buildStorages(ctx: ApiContext): Promise<Record<string, StorageFacts>> {
  const out: Record<string, StorageFacts> = {};
  for (const row of ctx.registry.storages.list()) {
    const secrets = ctx.registry.storages.secrets(row.name);
    if (!secrets) continue;
    const domain = await ctx.agents
      .forServer(row.server)
      .call("domains.get", { app: storageApp(row.name) })
      .then((r) => r.domains.find((d) => d.service === "s3"), () => undefined);
    out[row.name] = { name: row.name, server: row.server, hostname: domain?.hostname, tls: domain?.tls ?? "auto", port: row.port || undefined, accessKey: row.accessKey, secretKey: secrets.secretKey };
  }
  return out;
}

/**
 * What `app` may connect to: the other apps of its project, as last observed. Only apps that have been deployed
 * (the registry has their app.yaml) can be connected to. A peer whose server can't be reached is left out, so a
 * reference to it fails the deploy rather than resolving to something stale.
 */
export async function buildConnections(ctx: ApiContext, app: string, server: string): Promise<Connections> {
  const projectId = ctx.registry.apps.get(app)?.projectId;
  const peers: Record<string, AppFacts> = {};
  if (projectId) {
    for (const peer of ctx.registry.apps.list()) {
      if (peer.name === app || peer.projectId !== projectId || !peer.manifestText) continue;
      try {
        const manifest = parseManifest(peer.manifestText, { legacy: true });
        const { domains } = await ctx.agents.forServer(peer.server).call("domains.get", { app: peer.name });
        peers[peer.name] = {
          name: peer.name,
          server: peer.server,
          services: Object.keys(manifest.services),
          domains,
          ports: Object.fromEntries(ctx.registry.services.list(peer.name).map((s) => [s.name, s.port ?? undefined])),
          environment: withStored(manifest, await storedVariables(ctx, peer.server, peer.name)),
        };
      } catch {
        // unreachable or unreadable: not connectable right now
      }
    }
  }
  return { server, peers, storages: await buildStorages(ctx) };
}

/** Each service's `environment:` with the variables added on the server laid over it. */
export const withStored = (manifest: Manifest, stored: Record<string, Record<string, string>>): Record<string, Record<string, string>> =>
  Object.fromEntries(Object.entries(manifest.services).map(([name, def]) => [name, { ...def.environment, ...stored[name] }]));

/** Variables added on the server for an app, per service (none from an agent that predates them). */
export async function storedVariables(ctx: ApiContext, server: string, app: string): Promise<Record<string, Record<string, string>>> {
  return ctx.agents.forServer(server).call("variables.get", { app }).then((r) => r.variables, () => ({}));
}

/** Give the app's agent a fresh picture of its surroundings; call before anything that takes the app live. */
export async function pushConnections(ctx: ApiContext, server: string, app: string): Promise<void> {
  const conn = await buildConnections(ctx, app, server);
  try {
    await ctx.agents.forServer(server).call("connections.set", { app, ...conn });
  } catch (e) {
    // An agent from before connections can't resolve them; that only matters when the project has peers.
    if (Object.keys(conn.peers).length > 0 || Object.keys(conn.storages ?? {}).length > 0) {
      throw new Error(`could not tell ${server}'s agent about the other apps and storages around this one (is it up to date? upgrade it from the Servers page): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** What `app`'s own environment can read about its services right now (for showing resolved values). */
export async function ownFacts(ctx: ApiContext, app: string): Promise<(AppFacts & { fromFile: Record<string, Record<string, string>>; stored: Record<string, Record<string, string>> }) | undefined> {
  const row = ctx.registry.apps.get(app);
  if (!row?.manifestText) return undefined;
  let manifest;
  try {
    manifest = parseManifest(row.manifestText, { legacy: true });
  } catch {
    return undefined;
  }
  const domains = await ctx.agents.forServer(row.server).call("domains.get", { app }).then((r) => r.domains, () => []);
  const stored = await storedVariables(ctx, row.server, app);
  return {
    name: app,
    server: row.server,
    services: Object.keys(manifest.services),
    domains,
    ports: Object.fromEntries(ctx.registry.services.list(app).map((s) => [s.name, s.port ?? undefined])),
    // the default layout: this is only for showing what a value resolves to
    volumePaths: volumePaths(manifest, `/srv/apps/${app}/shared`),
    environment: withStored(manifest, stored),
    fromFile: Object.fromEntries(Object.entries(manifest.services).map(([name, def]) => [name, def.environment])),
    stored,
  };
}
