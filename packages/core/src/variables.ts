import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { loadReleaseManifest } from "./apply.ts";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { currentRelease, appDir, releaseDir } from "./releases.ts";
import { currentSource } from "./source.ts";
import { migrateShared } from "./shared.ts";

/**
 * Variables added on the server, per service, on top of the service's `environment:` in app.yaml (which gives the initial
 * values). An entry here wins over the same name in app.yaml; removing it brings the app.yaml value back. They live next
 * to the app like its domains, so every release, rollback included, gets them.
 */
export const variablesPath = (d: Deps, app: string) => `${appDir(d, app)}/variables.json`;

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export type Variables = Record<string, Record<string, string>>;
const variablesSchema = z.record(z.string(), z.record(z.string().regex(KEY_RE), z.string()));

export async function readVariables(d: Deps, app: string): Promise<Variables> {
  await migrateShared(d, app);
  try {
    return variablesSchema.parse(JSON.parse(await readFile(variablesPath(d, app), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function writeVariables(d: Deps, app: string, vars: Variables): Promise<void> {
  const path = variablesPath(d, app);
  const kept = Object.fromEntries(Object.entries(vars).filter(([, v]) => Object.keys(v).length > 0));
  if (Object.keys(kept).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(appDir(d, app), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(kept, null, 2) + "\n", { mode: 0o644 });
  await rename(`${path}.tmp`, path);
}

export interface SetVariablesResult {
  /** The service's variables after the change. */
  variables: Record<string, string>;
  /** The release was redeployed unchanged so the services pick the values up; null if the app isn't deployed yet. */
  deploy: DeployResult | null;
}

/**
 * Add, change or remove a service's variables. A deployed app is redeployed with its current release unchanged (new
 * instances, health check, rollback on failure), because values are part of each service's unit.
 */
export async function setVariables(
  d: Deps,
  app: string,
  service: string,
  change: { set?: Record<string, string>; remove?: string[] },
  opts: { skipVerify?: boolean; log?: DeployLog } = {},
): Promise<SetVariablesResult> {
  const log = opts.log ?? noLog;
  const all = await readVariables(d, app);
  const before = all[service] ?? {};
  const release = await currentRelease(d, app);
  const manifest = release ? await loadReleaseManifest(d, app, release) : undefined;
  if (manifest && !(service in manifest.services)) throw new Error(`${app} has no service "${service}"`);
  const secrets = manifest?.services[service]!.secrets ?? [];

  const next = { ...before };
  for (const [k, v] of Object.entries(change.set ?? {})) {
    if (!KEY_RE.test(k)) throw new Error(`invalid variable name "${k}": expected UPPER_SNAKE_CASE`);
    if (k === "PORT") throw new Error("PORT is set by Freighter");
    if (secrets.includes(k)) throw new Error(`${k} is a secret; set it under Secrets`);
    if (/[\r\n\0]/.test(v)) throw new Error("variable values cannot contain newlines");
    if (v.length > 65_536) throw new Error("variable value is too long");
    next[k] = v;
  }
  for (const k of change.remove ?? []) delete next[k];

  if (JSON.stringify(before) === JSON.stringify(next)) return { variables: next, deploy: null };
  await writeVariables(d, app, { ...all, [service]: next });
  if (!release) {
    await log("==> the app isn't deployed yet, so the variables are saved and take effect with its first deploy");
    return { variables: next, deploy: null };
  }

  await log(`==> variables for ${app}/${service} changed; redeploying the current release (${release}) unchanged so the services get them`);
  const dir = releaseDir(d, app, release);
  try {
    const result = await deploy(d, {
      manifestText: await readFile(`${dir}/app.yaml`, "utf8"),
      source: dir,
      meta: (await currentSource(d, app)) ?? undefined,
      skipVerify: opts.skipVerify,
      log,
      legacy: true,
    });
    return { variables: next, deploy: result };
  } catch (e) {
    await writeVariables(d, app, all);
    throw e;
  }
}
