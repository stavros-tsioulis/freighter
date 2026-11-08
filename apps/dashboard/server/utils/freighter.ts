import { loadConfig } from "@freighter/core/config";
import { createAgentDirectory, createApi, createControlSettings, type Api, type ApiContext, type ControlSettings } from "@freighter/api";
import { PkiStore } from "@freighter/pki";
import { openRegistry } from "@freighter/registry";

export interface FreighterRuntime {
  api: Api;
  ctx: ApiContext;
  /** The control plane's settings; read `settings.current()` each time, they can change while running. */
  settings: ControlSettings;
}

let runtime: Promise<FreighterRuntime> | undefined;

/** Build (once) the API from the host config: SQLite registry + client for the root agent. */
export function useFreighter(): Promise<FreighterRuntime> {
  runtime ??= (async () => {
    const config = await loadConfig(process.env.FREIGHTER_PREFIX || undefined);
    const registry = openRegistry(config.registry.path);
    // Hosts without a shell (Railway, containers): sign in with a token set in the environment, on first run only.
    const bootstrap = process.env.FREIGHTER_BOOTSTRAP_TOKEN?.trim();
    if (bootstrap && registry.tokens.bootstrap(bootstrap)) console.log('[freighter] created the admin token "bootstrap" from FREIGHTER_BOOTSTRAP_TOKEN; revoke it once you have your own');
    // Whether this control server also runs apps through an agent of its own (the server "local").
    if (!registry.servers.setLocal(config.api.localAgent)) console.warn('[freighter] api.localAgent is false but apps still point at the server "local"; keeping it until they are gone');
    const pki = new PkiStore(config.pki.dir);
    const ctx: ApiContext = {
      registry,
      pki,
      agents: await createAgentDirectory({ registry, localSocket: config.agent.socket, pki }),
      artifactsDir: config.agent.artifactsDir,
      maxUploadBytes: 0,
      trustProxy: true,
      gitAllowLocal: config.git.allowLocal,
    };
    // config.yaml, then what was saved from the dashboard, then environment variables (Railway's Variables tab).
    const settings = createControlSettings({ registry, file: config.api, target: ctx, env: process.env, warn: (m) => console.warn(`[freighter] ${m}`) });
    ctx.controlSettings = settings;
    return { api: createApi(ctx), ctx, settings };
  })();
  return runtime;
}
