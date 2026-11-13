import { mkdir, readdir } from "node:fs/promises";
import type { Deps } from "./deps.ts";
import { appDir, releasesDir } from "./releases.ts";

/** Create the app's directories and system user (idempotent). */
export async function ensureApp(d: Deps, app: string): Promise<void> {
  await mkdir(releasesDir(d, app), { recursive: true });
  await mkdir(`${appDir(d, app)}/shared`, { recursive: true });
  await mkdir(d.layout.envDir, { recursive: true });
  if ((await d.run("id", ["-u", app])).code !== 0) {
    const r = await d.run("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", app]);
    if (r.code !== 0) throw new Error(`useradd ${app} failed with exit code ${r.code}`);
  }
  await chownShared(d, app);
}

/**
 * Give the app's shared directory to its user, without reaching into volumes: what a container keeps there belongs to
 * the user ids it runs as (mapped onto the app's range), and a recursive chown would hand it all to the container's root
 * while a database is running on it. The volume folders themselves are the app's (a container's root); what is inside
 * is the container's to manage.
 */
export async function chownShared(d: Deps, app: string): Promise<void> {
  const shared = `${appDir(d, app)}/shared`;
  const owner = `${app}:${app}`;
  await d.run("chown", [owner, shared]);
  const entries = await readdir(shared).catch(() => [] as string[]);
  for (const name of entries) {
    if (name === "volumes") await d.run("chown", [owner, `${shared}/volumes`]);
    else await d.run("chown", ["-R", owner, `${shared}/${name}`]);
  }
}
