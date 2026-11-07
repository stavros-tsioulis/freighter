import type { ApiContext } from "./context.ts";
import { checkServer, reachableServers } from "./servers.ts";

export interface SyncResult {
  apps: number;
  errors: Record<string, string>;
  servers: Record<string, "online" | "offline">;
}

/** Pull one app's observed state and host-side history from its server's agent into the registry. */
export async function syncApp(ctx: ApiContext, server: string, app: string): Promise<void> {
  const info = await ctx.agents.forServer(server).call("app.info", { app });
  ctx.registry.apps.upsert({
    name: app,
    server,
    manifestText: info.manifestText,
    currentRelease: info.release,
    previousRelease: info.previous,
    status: info.release ? "deployed" : "undeployed",
  });
  ctx.registry.services.replace(
    app,
    Object.entries(info.services).map(([name, s]) => ({
      name,
      unit: s.unit,
      port: s.port ?? null,
      hostnames: s.hostnames,
      activeState: s.activeState,
      subState: s.subState,
      restarts: s.restarts,
      memoryBytes: s.memoryCurrent,
    })),
  );
  const { entries } = await ctx.agents.forServer(server).call("app.history", { app, limit: 500 });
  ctx.registry.deployments.importHistory(app, entries);
}

/** Sync every reachable server. One server being down never blocks the others. */
export async function syncAll(ctx: ApiContext): Promise<SyncResult> {
  const result: SyncResult = { apps: 0, errors: {}, servers: {} };
  for (const server of reachableServers(ctx)) {
    const checked = await checkServer(ctx, server.name);
    result.servers[server.name] = checked?.status === "online" ? "online" : "offline";
    if (checked?.status !== "online") {
      result.errors[server.name] = checked?.lastError ?? "unreachable";
      continue;
    }
    try {
      const { apps } = await ctx.agents.forServer(server.name).call("apps.list", {});
      for (const app of apps) {
        const known = ctx.registry.apps.get(app);
        if (known && known.server !== server.name) {
          result.errors[app] = `app "${app}" exists on servers "${known.server}" and "${server.name}"; keeping "${known.server}"`;
          continue;
        }
        try {
          await syncApp(ctx, server.name, app);
          result.apps++;
        } catch (e) {
          result.errors[app] = e instanceof Error ? e.message : String(e);
        }
      }
      ctx.registry.apps.markMissing(apps, server.name);
    } catch (e) {
      result.errors[server.name] = e instanceof Error ? e.message : String(e);
    }
  }
  return result;
}
