import { runningCommit } from "@freighter/core";
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

const OLD_AGENT =
  "This agent predates remote upgrades. Run the installer on it once (curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --role agent); after that it can be upgraded from here.";

type UpgradeCtx = Pick<ApiContext, "agents" | "registry" | "version">;

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
export async function startServerUpgrade(ctx: UpgradeCtx, name: string, ref?: string): Promise<UpgradeView> {
  const server = ctx.registry.servers.get(name);
  if (!server) throw new UpgradeRefused(400, `unknown server "${name}"`);
  if (server.kind === "local") throw new UpgradeRefused(400, "the local server is upgraded by re-running the installer on this machine");
  if (server.status !== "online") throw new UpgradeRefused(409, `${name} is ${server.status}: the upgrade needs it online`);
  const target = ref ?? (await controlVersion(ctx));
  if (!target) throw new UpgradeRefused(400, "this control plane doesn't know which version it runs; pass a ref (a branch, tag or commit)");
  const before = await upgradeView(ctx, name);
  if (!before.supported) throw new UpgradeRefused(409, before.reason ?? "this agent can't upgrade itself");
  try {
    await ctx.agents.forServer(name).call("upgrade.start", { ref: target }, { timeoutMs: 15_000 });
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
