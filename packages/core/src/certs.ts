import { certExpiry, certPath } from "@freighter/haproxy";
import type { Deps } from "./deps.ts";
import { withLock } from "./lock.ts";
import { allStates, routesFrom } from "./state.ts";

async function autoHostnames(d: Deps): Promise<string[]> {
  const routes = routesFrom(await allStates(d));
  return [...new Set(routes.filter((r) => r.tls === "auto").map((r) => r.hostname))].sort();
}

/** Renew (or issue) certificates for every `tls: auto` hostname, then reload HAProxy once if anything changed. */
export async function renewCerts(d: Deps, opts: { force?: boolean } = {}): Promise<{ hostname: string; issued: boolean; expires: Date | null }[]> {
  if (!d.isRoot) throw new Error("certs renew must run as root");
  return withLock(d, "certs", async () => {
    const out = [];
    for (const hostname of await autoHostnames(d)) out.push({ hostname, ...(await d.issueCert(hostname, { force: opts.force })) });
    if (out.some((c) => c.issued)) await d.haproxy.reload();
    return out;
  });
}

export async function certStatus(d: Deps): Promise<{ hostname: string; expires: Date | null }[]> {
  const out = [];
  for (const hostname of await autoHostnames(d)) out.push({ hostname, expires: await certExpiry(certPath(d.config.haproxy.dir, hostname)) });
  return out;
}
