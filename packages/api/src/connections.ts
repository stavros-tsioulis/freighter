import { parseManifest, type AppFacts, type Connections } from "@freighter/manifest";
import type { ApiContext } from "./context.ts";

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
          environment: manifest.environment,
        };
      } catch {
        // unreachable or unreadable: not connectable right now
      }
    }
  }
  return { server, peers };
}

/** Give the app's agent a fresh picture of its surroundings; call before anything that takes the app live. */
export async function pushConnections(ctx: ApiContext, server: string, app: string): Promise<void> {
  const conn = await buildConnections(ctx, app, server);
  try {
    await ctx.agents.forServer(server).call("connections.set", { app, ...conn });
  } catch (e) {
    // An agent from before connections can't resolve them; that only matters when the project has peers.
    if (Object.keys(conn.peers).length > 0) {
      throw new Error(`could not tell ${server}'s agent about the other apps in this project (is it up to date? upgrade it from the Servers page): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
