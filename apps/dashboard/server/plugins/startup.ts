import { pruneSpool, sampleOnce } from "@freighter/api";

export default defineNitroPlugin(async (nitro) => {
  // The build renders the app shell once (prerender). It must not open the registry or start the loops.
  if (import.meta.prerender) return;
  const { api, ctx, syncSeconds, metricsSeconds } = await useFreighter();

  // Anything still queued/running belonged to a previous process.
  const interrupted = ctx.registry.deployments.markInterrupted();
  if (interrupted > 0) console.warn(`[freighter] marked ${interrupted} interrupted deployment(s) as failed`);
  await pruneSpool(ctx.artifactsDir, 24 * 60 * 60 * 1000);

  const warn = (what: string) => (e: unknown) => console.warn(`[freighter] ${what} failed:`, e instanceof Error ? e.message : e);
  const every = (seconds: number, fn: () => Promise<unknown>, what: string) => {
    void fn().catch(warn(what));
    if (seconds <= 0) return;
    const timer = setInterval(() => void fn().catch(warn(what)), seconds * 1000);
    timer.unref();
    nitro.hooks.hook("close", () => clearInterval(timer));
  };

  every(syncSeconds, () => api.syncAll(), "sync");
  every(metricsSeconds, () => sampleOnce(ctx), "metrics sampling");
});
