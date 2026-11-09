import { access, rm } from "node:fs/promises";
import { certPath } from "@freighter/haproxy";
import { IDENT_RE } from "@freighter/manifest";
import { retire, writeRoutes } from "./apply.ts";
import type { Deps } from "./deps.ts";
import { readDomains } from "./domains.ts";
import { envFilePath, refsEnvPath } from "./env.ts";
import { appKeyDir } from "./git.ts";
import { removeContainers } from "./image.ts";
import { buildCacheDir } from "./build.ts";
import { withLock } from "./lock.ts";
import { appDir } from "./releases.ts";
import { readState } from "./state.ts";

export interface DeleteAppResult {
  app: string;
  /** systemd units that were stopped and removed. */
  units: string[];
  /** Hostnames that no longer route anywhere. */
  hostnames: string[];
}

/**
 * Remove an app from this server, completely: it stops being routed, its units are stopped and deleted, and its
 * releases, shared data, secrets, deploy key, build cache and certificates go with it. The shared directory is user
 * data and is not recoverable afterwards, so callers confirm before they get here.
 */
export async function deleteApp(d: Deps, app: string): Promise<DeleteAppResult> {
  if (!d.isRoot) throw new Error("deleting an app must run as root");
  if (!IDENT_RE.test(app)) throw new Error(`invalid app name "${app}"`);
  const dir = appDir(d, app);
  if (!dir.startsWith(`${d.layout.appsRoot}/`)) throw new Error(`invalid app name "${app}"`);
  if (!(await access(dir).then(() => true, () => false))) throw new Error(`unknown app "${app}"`);

  return withLock(d, app, async () => {
    const state = await readState(d, app);
    const domains = await readDomains(d, app);
    const hostnames = [...new Set([...domains.map((x) => x.hostname), ...Object.values(state.routed).flatMap((r) => r.hostnames.map((h) => h.hostname))])].sort();

    // 1. Stop sending traffic: HAProxy forgets the app's hostnames before anything it routes to goes away.
    if (Object.keys(state.routed).length > 0) await writeRoutes(d, app, {});
    // 2. Stop and delete every unit the app owns, including instances left behind by deploys.
    const units = await retire(d, app, new Set());
    // 2b. Containers and images (rootless Podman state lives in the app's directory, which goes below).
    await removeContainers(d, app);
    // 3. Certificates nobody routes to anymore (the combined PEM, then the certbot lineage; neither is needed again).
    for (const x of domains.filter((x) => x.tls === "auto")) {
      await rm(certPath(d.config.haproxy.dir, x.hostname), { force: true });
      await d.run("certbot", ["delete", "--non-interactive", "--cert-name", x.hostname]).catch(() => undefined);
    }
    // 4. Everything on disk that belongs to it.
    for (const path of [dir, envFilePath(d, app), refsEnvPath(d, app), appKeyDir(d, app), buildCacheDir(d, app)]) await rm(path, { recursive: true, force: true });
    // 5. The system user, but only one that ensureApp made (a no-login system account with a home that was never created).
    // An app named after a user that already existed (postgres, say) ran as that user and must not take it away.
    const entry = (await d.run("getent", ["passwd", app])).stdout.trim().split(":");
    if (entry.length >= 7 && entry[5] === `/home/${app}` && entry[6]!.endsWith("nologin")) await d.run("userdel", [app]);

    return { app, units, hostnames };
  });
}
