import { pruneSpool, sampleOnce } from "@freighter/api";

export default defineNitroPlugin(async (nitro) => {
  // The build renders the app shell once (prerender). It must not open the registry or start the loops.
  if (import.meta.prerender) return;
  // Talking to another Freighter's API: nothing of its own to open or run here.
  const remote = remoteApiUrl();
  if (remote) {
    console.log(`[freighter] /api is forwarded to ${remote} (FREIGHTER_API_URL); no local registry, sync or sampling`);
    return;
  }
  const { api, ctx, settings } = await useFreighter();

  // Anything still queued/running belonged to a previous process.
  const interrupted = ctx.registry.deployments.markInterrupted();
  if (interrupted > 0) console.warn(`[freighter] marked ${interrupted} interrupted deployment(s) as failed`);
  await pruneSpool(ctx.artifactsDir, 24 * 60 * 60 * 1000);

  const warn = (what: string) => (e: unknown) => console.warn(`[freighter] ${what} failed:`, e instanceof Error ? e.message : e);
  // Each run re-reads its interval, so a change in the settings applies without a restart (0 means off: look again later).
  let stopped = false;
  const stops: (() => void)[] = [];
  nitro.hooks.hook("close", () => { stopped = true; stops.forEach((stop) => stop()); });
  const every = (seconds: () => number, fn: () => Promise<unknown>, what: string) => {
    let timer: NodeJS.Timeout | undefined;
    stops.push(() => clearTimeout(timer));
    const tick = async (first: boolean) => {
      if (stopped) return;
      if (first || seconds() > 0) await fn().catch(warn(what));
      timer = setTimeout(() => void tick(false), (seconds() > 0 ? seconds() : 30) * 1000);
      timer.unref();
    };
    void tick(true);
  };

  every(() => settings.current().syncSeconds, () => api.syncAll(), "sync");
  every(() => settings.current().metricsSeconds, () => sampleOnce(ctx), "metrics sampling");
});
