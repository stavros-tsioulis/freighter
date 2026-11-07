import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { domainsSchema, type Domain, type DomainInput } from "@freighter/manifest";
import type { Deps } from "./deps.ts";
import { appDir } from "./releases.ts";

/**
 * An app's domains live next to it on its server (`<apps>/<app>/domains.json`), not in app.yaml: they are
 * configuration of the app, like its environment, and survive redeploys and rollbacks.
 */
export const domainsPath = (d: Deps, app: string) => `${appDir(d, app)}/domains.json`;

export async function readDomains(d: Deps, app: string): Promise<Domain[]> {
  try {
    return domainsSchema.parse(JSON.parse(await readFile(domainsPath(d, app), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function writeDomains(d: Deps, app: string, domains: Domain[]): Promise<void> {
  if (domains.length === 0) {
    await rm(domainsPath(d, app), { force: true });
    return;
  }
  await mkdir(appDir(d, app), { recursive: true });
  const path = domainsPath(d, app);
  await writeFile(`${path}.tmp`, JSON.stringify(domains, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

/** Every app's configured domains on this server. */
export async function allDomains(d: Deps): Promise<Record<string, Domain[]>> {
  const out: Record<string, Domain[]> = {};
  let apps: string[];
  try {
    apps = await readdir(d.layout.appsRoot);
  } catch {
    return out;
  }
  for (const app of apps) {
    const list = await readDomains(d, app).catch(() => []);
    if (list.length) out[app] = list;
  }
  return out;
}

/** Validate user input and normalise it (lowercase hostnames, defaults filled in). */
export function parseDomains(input: DomainInput[]): Domain[] {
  return domainsSchema.parse(input.map((x) => ({ ...x, hostname: x.hostname.trim().toLowerCase() })));
}

/** Fail if a hostname is configured on a different app. */
export async function assertHostnamesFree(d: Deps, app: string, domains: readonly Domain[]): Promise<void> {
  const taken = new Map<string, string>();
  for (const [other, list] of Object.entries(await allDomains(d))) {
    if (other !== app) for (const x of list) taken.set(x.hostname, other);
  }
  for (const x of domains) {
    const owner = taken.get(x.hostname);
    if (owner) throw new Error(`hostname ${x.hostname} is already used by app "${owner}"`);
  }
}
