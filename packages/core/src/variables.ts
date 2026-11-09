import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { loadReleaseManifest } from "./apply.ts";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { deploy, type DeployResult } from "./deploy.ts";
import { currentRelease, appDir, releaseDir } from "./releases.ts";
import { currentSource } from "./source.ts";

/**
 * Variables added on the server, on top of the `environment:` of app.yaml (which gives the initial values). An entry here
 * wins over the same name in app.yaml; removing it brings the app.yaml value back. They live next to the app like its
 * domains, so every release, rollback included, gets them.
 */
export const variablesPath = (d: Deps, app: string) => `${appDir(d, app)}/variables.json`;

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const variablesSchema = z.record(z.string().regex(KEY_RE), z.string());

export async function readVariables(d: Deps, app: string): Promise<Record<string, string>> {
  try {
    return variablesSchema.parse(JSON.parse(await readFile(variablesPath(d, app), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export async function writeVariables(d: Deps, app: string, vars: Record<string, string>): Promise<void> {
  const path = variablesPath(d, app);
  if (Object.keys(vars).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(appDir(d, app), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(vars, null, 2) + "\n", { mode: 0o644 });
  await rename(`${path}.tmp`, path);
}

export interface SetVariablesResult {
  variables: Record<string, string>;
  /** The release was redeployed unchanged so the services pick the values up; null if the app isn't deployed yet. */
  deploy: DeployResult | null;
}

/**
 * Add, change or remove variables. A deployed app is redeployed with its current release unchanged (new instances, health
 * check, rollback on failure), because values are part of each service's unit.
 */
export async function setVariables(
  d: Deps,
  app: string,
  change: { set?: Record<string, string>; remove?: string[] },
  opts: { skipVerify?: boolean; log?: DeployLog } = {},
): Promise<SetVariablesResult> {
  const log = opts.log ?? noLog;
  const before = await readVariables(d, app);
  const release = await currentRelease(d, app);
  const secrets = release ? (await loadReleaseManifest(d, app, release)).secrets : [];

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
  await writeVariables(d, app, next);
  if (!release) {
    await log("==> the app isn't deployed yet, so the variables are saved and take effect with its first deploy");
    return { variables: next, deploy: null };
  }

  await log(`==> variables for ${app} changed; redeploying the current release (${release}) unchanged so the services get them`);
  const dir = releaseDir(d, app, release);
  try {
    const result = await deploy(d, {
      manifestText: await readFile(`${dir}/app.yaml`, "utf8"),
      source: dir,
      meta: (await currentSource(d, app)) ?? undefined,
      skipVerify: opts.skipVerify,
      log,
    });
    return { variables: next, deploy: result };
  } catch (e) {
    await writeVariables(d, app, before);
    throw e;
  }
}
