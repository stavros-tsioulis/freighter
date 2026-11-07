import { AgentError, createAgentClient, type AgentClient } from "@freighter/protocol";
import type { PkiStore } from "@freighter/pki";
import type { Registry } from "@freighter/registry";
import type { AgentDirectory } from "./context.ts";

export const DEFAULT_AGENT_PORT = 7443;

/** "host" or "host:port" -> parts (IPv6 literals are not supported). */
export function parseAddress(address: string): { host: string; port: number } {
  const m = /^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(address.trim());
  const port = m?.[3] ? Number(m[3]) : DEFAULT_AGENT_PORT;
  if (!m || port < 1 || port > 65535) throw new Error(`invalid address "${address}" (expected host or host:port)`);
  return { host: m[1]!, port };
}

/**
 * Build the directory of agent clients. The control plane's own client identity (signed by our CA) is loaded once;
 * remote clients are cached per server and rebuilt when its address or pinned certificate changes.
 */
export async function createAgentDirectory(o: { registry: Registry; localSocket: string; pki: PkiStore; timeoutMs?: number }): Promise<AgentDirectory> {
  const [ca, client] = [await o.pki.ensureCa(), await o.pki.ensureControlClient()];
  const local = createAgentClient(o.localSocket, { timeoutMs: o.timeoutMs });
  const cache = new Map<string, { key: string; client: AgentClient }>();

  return {
    forServer(name) {
      const server = o.registry.servers.get(name);
      if (!server) throw new AgentError("not_found", `unknown server "${name}"`);
      if (server.kind === "local") return local;
      if (!server.certFingerprint || !server.address) throw new AgentError("conflict", `server "${name}" has not been enrolled yet`);
      const key = `${server.address}|${server.certFingerprint}`;
      const hit = cache.get(name);
      if (hit?.key === key) return hit.client;
      const { host, port } = parseAddress(server.address);
      const c = createAgentClient(
        { kind: "tls", host, port, ca: ca.certPem, cert: client.certPem, key: client.keyPem, pinnedFingerprint: server.certFingerprint },
        { timeoutMs: o.timeoutMs },
      );
      cache.set(name, { key, client: c });
      return c;
    },
  };
}
