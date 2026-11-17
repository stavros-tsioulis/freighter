import { parseManifest } from "@freighter/manifest";
import type { ApiContext } from "./context.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 3_000;

/** The apps any service of this configuration says it depends on. A configuration that can't be read has none (the deploy reports that itself). */
export function dependenciesOf(manifestText: string | null | undefined): string[] {
  if (!manifestText) return [];
  try {
    return [...new Set(Object.values(parseManifest(manifestText, { legacy: true }).services).flatMap((s) => s.dependsOn))];
  } catch {
    return [];
  }
}

/** Why `dep` can't be relied on right now, or null when it is deployed and every service of it is running. */
async function notReadyReason(ctx: ApiContext, dep: string, server: string): Promise<string | null> {
  try {
    const info = await ctx.agents.forServer(server).call("app.info", { app: dep });
    if (!info.release) return "it has not been deployed yet";
    const down = Object.entries(info.services).filter(([, s]) => s.activeState !== "active").map(([name, s]) => `${name} is ${s.activeState}`);
    return down.length ? down.join(", ") : null;
  } catch (e) {
    return `its server could not be asked (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
  }
}

/** Whether `from` depends on `target`, directly or through other apps, by what the registry holds. */
function dependsOnApp(ctx: ApiContext, from: string, target: string, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  const deps = dependenciesOf(ctx.registry.apps.get(from)?.manifestText);
  return deps.includes(target) || deps.some((d) => dependsOnApp(ctx, d, target, seen));
}

export interface WaitOptions {
  app: string;
  server: string;
  /** The configuration the deploy is going to run with. */
  manifestText: string | null | undefined;
  log: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Hold a deploy until every app its services depend on is ready: deployed, with all its services running. Waits up to
 * `dependencyWait.timeoutMs` (5 minutes), then fails, which leaves what is running untouched.
 *
 * Deployments on one server run one at a time, so waiting for an app that is queued behind this deployment on the same
 * server could never end; that fails at once, saying what to deploy first.
 */
export async function awaitDependencies(ctx: ApiContext, o: WaitOptions): Promise<void> {
  const deps = dependenciesOf(o.manifestText);
  if (deps.length === 0) return;
  const timeoutMs = ctx.dependencyWait?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = ctx.dependencyWait?.pollMs ?? DEFAULT_POLL_MS;
  const projectId = ctx.registry.apps.get(o.app)?.projectId;

  const rows = deps.map((name) => ({ name, row: ctx.registry.apps.get(name) }));
  const strangers = rows.filter((r) => !r.row || !projectId || r.row.projectId !== projectId).map((r) => r.name);
  if (strangers.length > 0) {
    throw new Error(`${o.app} depends on ${strangers.join(", ")}, which ${strangers.length === 1 ? "is not an app" : "are not apps"} of its project (dependencies must be in the same project)`);
  }

  o.log(`==> waiting for ${deps.join(", ")} to be ready`);
  const started = Date.now();
  const said = new Map<string, string>();
  for (;;) {
    if (o.signal?.aborted) throw new Error("canceled while waiting for dependencies");
    const waiting: { name: string; reason: string }[] = [];
    for (const { name, row } of rows) {
      const reason = await notReadyReason(ctx, name, row!.server);
      if (reason === null) {
        if (said.get(name) !== "ready") o.log(`    ${name}: ready`);
        said.set(name, "ready");
      } else {
        waiting.push({ name, reason });
        if (said.get(name) !== reason) o.log(`    ${name}: not ready, ${reason}`);
        said.set(name, reason);
      }
    }
    if (waiting.length === 0) return;

    for (const { name } of waiting) {
      if (dependsOnApp(ctx, name, o.app)) throw new Error(`${o.app} and ${name} depend on each other: neither can wait for the other. Remove one of the dependencies`);
      const queuedBehind = ctx.registry.deployments.list({ app: name, limit: 10 }).some((d) => d.status === "queued" && d.server === o.server);
      if (queuedBehind) throw new Error(`${name} is not ready, and its deployment is queued behind this one on ${o.server}, so it can't start while this waits. Deploy ${name} first`);
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`gave up waiting after ${Math.round(timeoutMs / 1000)}s: ${waiting.map((w) => `${w.name} (${w.reason})`).join("; ")}. The running release was left as it is`);
    }
    await sleep(pollMs, o.signal);
    if (o.signal?.aborted) throw new Error("canceled while waiting for dependencies");
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
