import { readFile } from "node:fs/promises";
import type { Domain, DomainInput } from "@freighter/manifest";
import { ensureApp } from "./app.ts";
import { loadReleaseManifest } from "./apply.ts";
import type { Deps } from "./deps.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { assertHostnamesFree, parseDomains, readDomains, writeDomains } from "./domains.ts";
import { currentRelease, releaseDir } from "./releases.ts";
import { routingProblems } from "@freighter/manifest";
import { currentSource } from "./source.ts";

export interface SetDomainsResult {
  domains: Domain[];
  /** The release that applied the change (null when nothing was deployed yet, or nothing changed). */
  deploy: DeployResult | null;
}

const same = (a: Domain[], b: Domain[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Replace an app's domains. If the app is deployed, its current release is redeployed unchanged with the new routing
 * through the normal path (new instances, health check, HAProxy switch, rollback on failure), so a bad change never
 * takes the app down. If it is not deployed yet, the domains are just saved for its first deploy.
 */
export async function setDomains(d: Deps, app: string, input: DomainInput[], opts: { skipVerify?: boolean } = {}): Promise<SetDomainsResult> {
  const domains = parseDomains(input);
  const current = await readDomains(d, app);
  await assertHostnamesFree(d, app, domains);
  const release = await currentRelease(d, app);

  if (!release) {
    await ensureApp(d, app);
    await writeDomains(d, app, domains);
    return { domains, deploy: null };
  }
  if (same(current, domains)) return { domains, deploy: null };

  const manifest = await loadReleaseManifest(d, app, release);
  const problems = routingProblems(manifest, domains);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const dir = releaseDir(d, app, release);
  const result = await deploy(d, {
    manifestText: await readFile(`${dir}/app.yaml`, "utf8"),
    source: dir,
    meta: (await currentSource(d, app)) ?? undefined,
    domains,
    skipVerify: opts.skipVerify,
  });
  return { domains, deploy: result };
}
