import { mkdir } from "node:fs/promises";
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
  await d.run("chown", ["-R", `${app}:${app}`, `${appDir(d, app)}/shared`]);
}
