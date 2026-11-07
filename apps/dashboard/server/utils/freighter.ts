import { loadConfig } from "@freighter/core/config";
import { createAgentDirectory, createApi, createDnsResolver, type Api, type ApiContext } from "@freighter/api";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";

export interface FreighterRuntime {
  api: Api;
  ctx: ApiContext;
  syncSeconds: number;
  metricsSeconds: number;
}

let runtime: Promise<FreighterRuntime> | undefined;

/** Build (once) the API from the host config: SQLite registry + client for the root agent. */
export function useFreighter(): Promise<FreighterRuntime> {
  runtime ??= (async () => {
    const config = await loadConfig(process.env.FREIGHTER_PREFIX || undefined);
    const registry = openRegistry(config.registry.path);
    // Whether this control server also runs apps through an agent of its own (the server "local").
    if (!registry.servers.setLocal(config.api.localAgent)) console.warn('[freighter] api.localAgent is false but apps still point at the server "local"; keeping it until they are gone');
    const pki = new PkiStore(config.pki.dir);
    const ctx: ApiContext = {
      registry,
      pki,
      agents: await createAgentDirectory({ registry, localSocket: config.agent.socket, pki }),
      artifactsDir: config.agent.artifactsDir,
      maxUploadBytes: config.api.maxUploadMb * 1024 * 1024,
      trustProxy: config.api.trustProxy,
      gitAllowLocal: config.git.allowLocal,
      publicUrl: config.api.publicUrl,
      publicIps: config.api.publicIps,
      dns: createDnsResolver(config.api.dnsServers),
      metricsRetentionHours: config.api.metricsRetentionHours,
    };
    return { api: createApi(ctx), ctx, syncSeconds: config.api.syncSeconds, metricsSeconds: config.api.metricsSeconds };
  })();
  return runtime;
}
