import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { renderMainConfig } from "@freighter/haproxy";
import type { Deps } from "./deps.ts";
import { haproxySync } from "./apply.ts";
import { hostConfigSchema, parseHostConfig, type HostConfig } from "./config.ts";

import { BY_KEY, FIELDS, SettingsError, checkType, getPath, type FieldDef, type FieldState } from "./fields.ts";
export * from "./fields.ts";


async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** The editable settings with their current values, read fresh from disk (not from what this process started with). */
export async function readSettings(path: string): Promise<FieldState[]> {
  const doc = parseDocument(await readText(path));
  const raw = (doc.toJS() ?? {}) as unknown;
  const effective = parseHostConfig(raw);
  const defaults = parseHostConfig({});
  return FIELDS.map((f) => {
    const explicit = getPath(raw, f.key) !== undefined && getPath(raw, f.key) !== null;
    return { ...f, value: getPath(effective, f.key) ?? null, default: getPath(defaults, f.key) ?? null, explicit };
  });
}

/** Drop maps that a removed key left empty, so resetting a setting leaves no `acme: {}` behind. */
function prune(doc: Document, path: string[]) {
  for (let n = path.length - 1; n > 0; n--) {
    const parent = path.slice(0, n);
    const node = doc.getIn(parent, true);
    if (isMap(node) && node.items.length === 0) doc.deleteIn(parent);
    else break;
  }
}

export interface ApplyResult {
  /** Keys whose value actually changed. */
  changed: string[];
  /** What must be restarted for the changes to take effect. */
  restart: ("agent" | "api")[];
  /** Changed settings that rewrite the listener lines of a Freighter-managed HAProxy config. */
  haproxyChanged: boolean;
  /** The config as it is after the change. */
  config: HostConfig;
}

/**
 * Apply `changes` (key -> new value, or null to remove the entry and fall back to the default) to the file at `path`.
 * The result is validated as a whole before anything is written, comments and unrelated keys in the file are kept, and
 * the previous file is saved next to it as `.bak`.
 */
export async function applySettings(path: string, changes: Record<string, unknown>, opts: { allow?: (f: FieldDef) => boolean } = {}): Promise<ApplyResult> {
  const doc = parseDocument(await readText(path));
  if (doc.errors.length) throw new SettingsError(`config.yaml is not valid YAML (${doc.errors[0]!.message}); fix it by hand first`);
  if (doc.contents !== null && !isMap(doc.contents) && !(isScalar(doc.contents) && doc.contents.value === null)) throw new SettingsError("config.yaml must be a mapping");
  const before = parseHostConfig((doc.toJS() ?? {}) as unknown);

  for (const [key, value] of Object.entries(changes)) {
    const f = BY_KEY.get(key);
    if (!f) throw new SettingsError(`"${key}" is not a setting that can be changed here`);
    if (opts.allow && !opts.allow(f)) throw new SettingsError(`${f.label} is not available on this server`);
    const path = key.split(".");
    if (value === null || (f.type === "string" && value === "")) {
      doc.deleteIn(path);
      prune(doc, path);
    } else {
      doc.setIn(path, checkType(f, value));
    }
  }

  let config: HostConfig;
  try {
    config = hostConfigSchema.parse(doc.toJS() ?? {});
  } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    throw new SettingsError(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid configuration");
  }
  if (config.haproxy.httpPort === config.haproxy.httpsPort) throw new SettingsError("The HTTP and HTTPS ports must be different.");

  const changed = FIELDS.filter((f) => JSON.stringify(getPath(before, f.key) ?? null) !== JSON.stringify(getPath(config, f.key) ?? null)).map((f) => f.key);
  const touched = changed.map((k) => BY_KEY.get(k)!);
  if (changed.length) {
    await mkdir(dirname(path), { recursive: true });
    const old = await readText(path);
    if (old) await copyFile(path, `${path}.bak`).catch(() => {});
    const tmp = `${path}.tmp`;
    await writeFile(tmp, doc.toString(), { mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, path);
  }
  const restart = (["agent", "api"] as const).filter((r) => touched.some((f) => f.restart === r));
  return { changed, restart, haproxyChanged: touched.some((f) => f.haproxy), config };
}

const MANAGED_MARK = "# Managed by freighter";

/**
 * Bring a Freighter-generated haproxy.cfg (the "dedicated" setup) in line with new listener settings: render, validate
 * the whole config, swap it in, reload. A haproxy.cfg you wrote yourself is never touched: "manual" means its ports
 * have to be changed by hand.
 */
export async function applyHaproxyListeners(d: Deps, config: HostConfig): Promise<"applied" | "manual"> {
  const main = d.config.haproxy.mainConfig;
  const current = await readText(main);
  if (!current.startsWith(MANAGED_MARK)) return "manual";
  await haproxySync(d); // the new config refers to the freighter_challenge backend, which an older backends.cfg lacks
  const next = renderMainConfig({ ...config.haproxy });
  if (next === current) return "applied";
  const staged = `${main}.new`;
  await writeFile(staged, next);
  const check = await d.run(d.config.haproxy.bin, ["-c", "-f", staged, "-f", `${d.config.haproxy.dir}/backends.cfg`]);
  if (check.code !== 0) {
    await rm(staged, { force: true });
    throw new SettingsError(`HAProxy rejected the new ports, nothing was changed: ${(check.stderr ?? check.stdout).trim().split("\n").slice(-2).join(" | ")}`);
  }
  await rename(staged, main);
  await d.haproxy.reload();
  return "applied";
}
