import type { AgentError } from "@freighter/protocol";
import type { ServerRow } from "@freighter/registry";
import type { ApiContext } from "./context.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ping a server and record the outcome (status, version, host stats). Never throws. */
export async function checkServer(ctx: ApiContext, name: string): Promise<ServerRow | undefined> {
  try {
    const agent = ctx.agents.forServer(name);
    const ping = await agent.call("ping", {}, { timeoutMs: 8_000 });
    const host = await agent.call("host.status", {}, { timeoutMs: 8_000 }).catch(() => null);
    ctx.registry.servers.markSeen(name, { agentVersion: ping.version, hostname: ping.hostname ?? host?.hostname ?? null, host });
  } catch (e) {
    ctx.registry.servers.markError(name, message(e as AgentError));
  }
  return ctx.registry.servers.get(name);
}

/** Servers worth talking to: the local one and enrolled remotes (pending ones have no certificate yet). */
export const reachableServers = (ctx: ApiContext) => ctx.registry.servers.list().filter((s) => s.kind === "local" || s.status !== "pending");
