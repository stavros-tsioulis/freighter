import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { parseManifest, renderManifest, type Manifest } from "@freighter/manifest";
import { readVariables, writeVariables } from "./variables.ts";
import type { Deps } from "./deps.ts";
import { appDir, currentRelease, releaseDir } from "./releases.ts";

/**
 * An app's configuration (what app.yaml describes) lives on its server, next to its domains. The first deploy takes it
 * from the app.yaml it is given; from then on that file is not read again, and the dashboard or `freighter config set`
 * changes it. Releases keep a copy of the configuration they ran with, which is what rollbacks use.
 */
export const configPath = (d: Deps, app: string) => `${appDir(d, app)}/config.yaml`;

/** The text as app.yaml would hold it now: a file written with a shared environment is rewritten per service. */
export function normalizeConfig(text: string): string {
  try {
    parseManifest(text);
    return text;
  } catch {
    const { name, source: _source, ...rest } = parseManifest(text, { legacy: true, raw: true });
    return renderManifest(name, rest);
  }
}

export async function writeConfig(d: Deps, app: string, text: string): Promise<void> {
  await mkdir(appDir(d, app), { recursive: true });
  const tmp = `${configPath(d, app)}.tmp`;
  await writeFile(tmp, normalizeConfig(text));
  await rename(tmp, configPath(d, app));
}

/**
 * The app's configuration, or null for an app that has none yet. An app deployed before configuration was kept
 * separately takes the app.yaml of its current release.
 */
export async function readConfig(d: Deps, app: string): Promise<string | null> {
  let text: string | null = null;
  try {
    text = await readFile(configPath(d, app), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text === null) {
    const release = await currentRelease(d, app);
    if (!release) return null;
    text = normalizeConfig(await readFile(`${releaseDir(d, app, release)}/app.yaml`, "utf8"));
    await writeConfig(d, app, text);
  }
  return foldVariables(d, app, text);
}

/**
 * Variables an older version kept apart from the configuration already apply to the services (they are laid over their
 * environment), so moving them into the configuration changes nothing that runs. It makes them what the settings, the
 * edit dialog and the graph read.
 */
async function foldVariables(d: Deps, app: string, text: string): Promise<string> {
  try {
    const kept = await readVariables(d, app);
    if (Object.keys(kept).length === 0) return text;
    const { name, source: _source, ...settings } = parseManifest(text, { legacy: true, raw: true });
    const services = Object.fromEntries(Object.entries(settings.services).map(([n, def]) => [n, { ...def, environment: { ...def.environment, ...kept[n] } }]));
    const rendered = renderManifest(name, { ...settings, services } as never);
    await writeConfig(d, app, rendered);
    await writeVariables(d, app, {});
    return rendered;
  } catch {
    return text; // not something that can be moved right now: it keeps applying where it is
  }
}

export const sameConfig = (a: Manifest, b: Manifest) => JSON.stringify(a) === JSON.stringify(b);
