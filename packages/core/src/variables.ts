import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { parseManifest, renderManifest } from "@freighter/manifest";
import type { Deps } from "./deps.ts";
import { noLog, type DeployLog } from "./deploylog.ts";
import { readConfig, writeConfig } from "./appconfig.ts";
import { setConfig } from "./configure.ts";
import type { DeployResult } from "./deploy.ts";
import { appDir } from "./releases.ts";
import { migrateShared } from "./shared.ts";

/**
 * Variables an older version kept apart from the configuration, per service, laid over the service's `environment:`
 * (an entry here wins over the same name there). New variables go into the configuration itself; the first change moves
 * these there, and this file is then removed. Until then they still apply.
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
  /** The service's own variables after the change. */
  variables: Record<string, string>;
  /** The services that changed were restarted with them; null if the app isn't deployed yet. */
  deploy: DeployResult | null;
}

/**
 * Add, change or remove a variable of a service. It goes into the service's `environment:` in the app's configuration,
 * the same place the Settings tab and the service's edit dialog show, so it is part of the service like any other
 * value (connections to it appear on the graph, a rollback keeps it with the release). The configuration is saved
 * first and the app then takes it the quick way: only the service concerned restarts.
 *
 * Variables an older version kept apart (`variables.json`) are moved into the configuration by the first change.
 */
export async function setVariables(
  d: Deps,
  app: string,
  service: string,
  change: { set?: Record<string, string>; remove?: string[] },
  opts: { skipVerify?: boolean; log?: DeployLog } = {},
): Promise<SetVariablesResult> {
  const log = opts.log ?? noLog;
  const text = await readConfig(d, app);
  if (!text) throw new Error(`${app} has no configuration yet`);
  const { name, source: _source, ...settings } = parseManifest(text, { legacy: true, raw: true });
  if (!(service in settings.services)) throw new Error(`${app} has no service "${service}"`);
  const kept = await readVariables(d, app);
  const services = Object.fromEntries(Object.entries(settings.services).map(([n, def]) => [n, { ...def, environment: { ...def.environment, ...kept[n] } }]));
  const secrets = services[service]!.secrets;

  const before = services[service]!.environment;
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

  if (JSON.stringify(before) === JSON.stringify(next) && Object.keys(kept).length === 0) return { variables: next, deploy: null };
  services[service] = { ...services[service]!, environment: next };
  const rendered = renderManifest(name, { ...settings, services } as never); // checks it the way app.yaml is checked
  await writeConfig(d, app, rendered);
  await writeVariables(d, app, {}); // everything is in the configuration now
  await log(`==> ${service} of ${app}: variables changed, saved in the configuration`);
  const r = await setConfig(d, app, rendered, { skipVerify: opts.skipVerify, log });
  return { variables: next, deploy: r.deploy };
}
