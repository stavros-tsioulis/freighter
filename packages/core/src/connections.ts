import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connectionsSchema, type Connections } from "@freighter/manifest";
import type { Deps } from "./deps.ts";
import { appDir } from "./releases.ts";

/**
 * What an app may connect to (`@other/api.url`): the server it runs on and the other apps of its project, as last
 * pushed by the control plane. Stored next to the app (like its domains) so every way of going live, deploys and
 * rollbacks alike, resolves the same connections.
 */
export const connectionsPath = (d: Deps, app: string) => `${appDir(d, app)}/connections.json`;

export async function readConnections(d: Deps, app: string): Promise<Connections> {
  try {
    return connectionsSchema.parse(JSON.parse(await readFile(connectionsPath(d, app), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { peers: {} };
    throw e;
  }
}

export async function writeConnections(d: Deps, app: string, conn: Connections): Promise<void> {
  const parsed = connectionsSchema.parse(conn);
  const path = connectionsPath(d, app);
  if (parsed.server === undefined && Object.keys(parsed.peers).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(appDir(d, app), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(parsed, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}
