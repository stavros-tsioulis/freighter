import { readFile, rm } from "node:fs/promises";
import { certPath } from "@freighter/haproxy";
import { routedServices, type Domain, type DomainInput } from "@freighter/manifest";
import { ensureApp } from "./app.ts";
import { loadReleaseManifest, writeRoutes } from "./apply.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { assertHostnamesFree, parseDomains, readDomains, writeDomains } from "./domains.ts";
import { withLock } from "./lock.ts";
import { readState, writeState } from "./state.ts";
import { currentRelease, releaseDir } from "./releases.ts";
import { routingProblems } from "@freighter/manifest";
import { currentSource } from "./source.ts";

/**
 * How a change of domains took effect. `routing`: HAProxy now routes the new set of hostnames to services that were
 * already running, and nothing was redeployed. `deploy`: a service became routed for the first time, which needs a new
 * instance listening on its allocated port, so the release was redeployed. `saved`: the app isn't deployed yet.
 */
export type DomainsApplied = "unchanged" | "saved" | "routing" | "deploy";

export interface SetDomainsResult {
  domains: Domain[];
  /** The release that applied the change (null unless `mode` is `deploy`). */
  deploy: DeployResult | null;
  mode: DomainsApplied;
}

const same = (a: Domain[], b: Domain[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Replace an app's domains. Most changes only touch routing and take effect at once, with no build, no restart and no
 * new release: removing a domain, adding a domain to a service that is already routed, moving one. The exception is
 * giving a service its first domain: it must start listening on an allocated `$PORT`, so the current release is
 * redeployed unchanged through the normal path (new instances, health check, HAProxy switch, rollback on failure).
 * A service that loses its last domain keeps running where it is, unreachable from outside, until the next deploy.
 * If the app isn't deployed yet, the domains are just saved for its first deploy.
 */
export async function setDomains(d: Deps, app: string, input: DomainInput[], opts: { skipVerify?: boolean } = {}): Promise<SetDomainsResult> {
  const domains = parseDomains(input);
  const current = await readDomains(d, app);
  await assertHostnamesFree(d, app, domains);
  const release = await currentRelease(d, app);

  if (!release) {
    await ensureApp(d, app);
    await writeDomains(d, app, domains);
    return { domains, deploy: null, mode: "saved" };
  }
  if (same(current, domains)) return { domains, deploy: null, mode: "unchanged" };

  const manifest = await loadReleaseManifest(d, app, release);
  const problems = routingProblems(manifest, domains);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const running = (await readState(d, app)).routed;
  if ([...routedServices(domains)].every((service) => service in running)) {
    await updateRouting(d, app, current, domains);
    return { domains, deploy: null, mode: "routing" };
  }

  const dir = releaseDir(d, app, release);
  const result = await deploy(d, {
    manifestText: await readFile(`${dir}/app.yaml`, "utf8"),
    source: dir,
    meta: (await currentSource(d, app)) ?? undefined,
    domains,
    skipVerify: opts.skipVerify,
  });
  return { domains, deploy: result, mode: "deploy" };
}

/** Point HAProxy at a new set of hostnames for services that are already running. Restores the old set if HAProxy refuses. */
async function updateRouting(d: Deps, app: string, before: Domain[], next: Domain[]): Promise<void> {
  await withLock(d, app, async () => {
    const state = await readState(d, app);
    const hadCert = (hostname: string) => before.some((b) => b.hostname === hostname && b.tls === "auto");
    if (!d.dev) for (const x of next.filter((x) => x.tls === "auto" && !hadCert(x.hostname))) await d.issueCert(x.hostname);

    const routed = Object.fromEntries(
      Object.entries(state.routed).map(([service, r]) => [service, { ...r, hostnames: next.filter((x) => x.service === service).map((x) => ({ hostname: x.hostname, tls: x.tls })) }]),
    );
    await writeDomains(d, app, next);
    try {
      await writeRoutes(d, app, routed);
    } catch (e) {
      await writeDomains(d, app, before);
      throw e;
    }
    await writeState(d, app, { routed });
    // A certificate nobody routes to anymore. The certbot lineage stays, so adding the name back reuses it.
    for (const gone of before.filter((b) => b.tls === "auto" && !next.some((n) => n.hostname === b.hostname && n.tls === "auto"))) {
      await rm(certPath(d.config.haproxy.dir, gone.hostname), { force: true });
    }
  });
}
