import { runningCommit, runningCommitFull } from "@freighter/core";
import { AgentError, type OpResult } from "@freighter/protocol";
import type { ApiContext } from "./context.ts";
import { checkServer } from "./servers.ts";

export type UpgradeView = OpResult<"upgrade.status"> & {
  /** The commit the control plane runs: where "Upgrade" takes the server by default. */
  target: string | null;
  /** The server runs something other than `target`. */
  outdated: boolean;
};

/** The commit this control plane runs (tests can set `ctx.version`). */
export const controlVersion = async (ctx: Pick<ApiContext, "version">): Promise<string | null> => (ctx.version !== undefined ? ctx.version : runningCommit());

/** What a server is told to fetch: the control plane's commit in full (git can't fetch an abbreviation), when it knows it. */
export const controlRef = async (ctx: Pick<ApiContext, "version" | "versionFull">): Promise<string | null> =>
  ctx.version !== undefined ? (ctx.versionFull ?? ctx.version) : ((await runningCommitFull()) ?? (await runningCommit()));

const OLD_AGENT =
  "This agent predates remote upgrades. Run the installer on it once (curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --role agent); after that it can be upgraded from here.";

type UpgradeCtx = Pick<ApiContext, "agents" | "registry" | "version" | "versionFull">;

export async function upgradeView(ctx: UpgradeCtx, name: string): Promise<UpgradeView> {
  const target = await controlVersion(ctx);
  try {
    const s = await ctx.agents.forServer(name).call("upgrade.status", {}, { timeoutMs: 10_000 });
    return { ...s, target, outdated: !!target && !!s.commit && s.commit !== target };
  } catch (e) {
    if (e instanceof AgentError && e.code === "bad_request" && /unknown operation/.test(e.message)) {
      return { supported: false, reason: OLD_AGENT, commit: ctx.registry.servers.get(name)?.agentVersion ?? null, upgrade: null, log: "", target, outdated: true };
    }
    throw e;
  }
}

export class UpgradeRefused extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Ask a remote server's agent to upgrade to `ref` (default: the commit the control plane runs), and keep an eye on it. */
export async function startServerUpgrade(ctx: UpgradeCtx, name: string, ref?: string, opts: { withContainers?: boolean; withStorage?: boolean } = {}): Promise<UpgradeView> {
  const server = ctx.registry.servers.get(name);
  if (!server) throw new UpgradeRefused(400, `unknown server "${name}"`);
  if (server.kind === "local") {
    throw new UpgradeRefused(400, opts.withContainers ? "container support on the local server is added by re-running the installer on this machine with --with-containers" : opts.withStorage ? "storage support on the local server is added by re-running the installer on this machine with --with-storage" : "the local server is upgraded by re-running the installer on this machine");
  }
  if (server.status !== "online") throw new UpgradeRefused(409, `${name} is ${server.status}: the upgrade needs it online`);
  if (opts.withContainers || opts.withStorage) {
    // An agent without the capability would ignore the flag and upgrade to a branch instead, so ask first.
    const caps = (await ctx.agents.forServer(name).call("ping", {}, { timeoutMs: 10_000 })).capabilities ?? [];
    if (opts.withContainers && !caps.includes("containers.install")) throw new UpgradeRefused(409, "this agent predates container support. Upgrade it first, then add container support.");
    if (opts.withStorage && !caps.includes("storage.install")) throw new UpgradeRefused(409, "this agent predates storage support. Upgrade it first, then add storage support.");
  }
  const target = opts.withContainers || opts.withStorage ? "main" : (ref ?? (await controlRef(ctx)));
  if (!target) throw new UpgradeRefused(400, "this control plane doesn't know which version it runs; pass a ref (a branch, tag or commit)");
  const before = await upgradeView(ctx, name);
  if (!before.supported) throw new UpgradeRefused(409, before.reason ?? "this agent can't upgrade itself");
  try {
    await ctx.agents.forServer(name).call("upgrade.start", opts.withContainers || opts.withStorage ? { ...(opts.withContainers ? { withContainers: true } : {}), ...(opts.withStorage ? { withStorage: true } : {}) } : { ref: target }, { timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof AgentError && (e.code === "conflict" || e.code === "bad_request")) throw new UpgradeRefused(e.code === "conflict" ? 409 : 400, e.message);
    throw e;
  }
  watchUpgrade(ctx, name);
  return upgradeView(ctx, name);
}

const watching = new Set<string>();
const TERMINAL = new Set(["done", "rolled-back", "failed"]);

/**
 * While an upgrade runs, keep pinging the server: the first ping answered by the new agent while it is `verifying`
 * confirms it (see checkServer), which is what stops the server rolling itself back. Best effort: the periodic sync
 * does the same if this process restarts meanwhile, and the server rolls back by itself if nobody confirms.
 */
export function watchUpgrade(ctx: UpgradeCtx, name: string, opts: { everyMs?: number; maxMs?: number } = {}): void {
  if (watching.has(name)) return;
  watching.add(name);
  const every = opts.everyMs ?? 4_000;
  const deadline = Date.now() + (opts.maxMs ?? 30 * 60_000);
  const tick = async () => {
    try {
      await checkServer(ctx as ApiContext, name);
      const view = await upgradeView(ctx, name).catch(() => null);
      if (view?.upgrade && TERMINAL.has(view.upgrade.state)) return void watching.delete(name);
    } catch {
      /* keep trying until the deadline: the agent is restarting */
    }
    if (Date.now() > deadline) return void watching.delete(name);
    setTimeout(() => void tick(), every).unref();
  };
  setTimeout(() => void tick(), every).unref();
}

export type UpdateCheckView = OpResult<"upgrade.check"> & {
  /** The commit the control plane runs, to compare with what `latest` and `installed` are. */
  target: string | null;
};

/** Have the server's agent ask its repository what is new on `ref`, with the agent's own git. Changes nothing. */
export async function checkServerUpdates(ctx: UpgradeCtx, name: string, ref?: string): Promise<UpdateCheckView> {
  const server = ctx.registry.servers.get(name);
  if (!server) throw new UpgradeRefused(400, `unknown server "${name}"`);
  if (server.status === "pending") throw new UpgradeRefused(409, `${name} is not enrolled yet`);
  try {
    const r = await ctx.agents.forServer(name).call("upgrade.check", { ref }, { timeoutMs: 120_000 });
    return { ...r, target: await controlVersion(ctx) };
  } catch (e) {
    if (e instanceof AgentError && e.code === "bad_request" && /unknown operation/.test(e.message)) throw new UpgradeRefused(409, OLD_AGENT);
    if (e instanceof AgentError && (e.code === "bad_request" || e.code === "conflict")) throw new UpgradeRefused(e.code === "conflict" ? 409 : 400, e.message);
    throw e;
  }
}
