import { hostConfigSchema, type HostConfig } from "@freighter/core/config";
import { BY_KEY, FIELDS, SettingsError, checkType, getPath, type FieldDef, type FieldState } from "@freighter/core/fields";
import type { Registry } from "@freighter/registry";
import type { ApiContext } from "./context.ts";
import { createDnsResolver } from "./dns.ts";

/**
 * The control plane's own settings (`api.*`). They are layered, highest first: an environment variable, a value saved
 * from the dashboard (in the registry database), config.yaml, the default. Nothing here needs an agent or root, so a
 * control server in a container, with no config file, can still be configured.
 */
type Api = HostConfig["api"];
const apiSchema = hostConfigSchema.shape.api;
const FIELDS_CONTROL = FIELDS.filter((f) => f.scope === "control");

/** `api.dnsServers` -> `FREIGHTER_API_DNS_SERVERS`. */
export const envVarFor = (key: string) => "FREIGHTER_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/\./g, "_").toUpperCase();

function setPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
  o[parts.at(-1)!] = value;
}

/** An environment value as the setting's type; undefined when it should be ignored. */
function fromEnv(f: FieldDef, raw: string): unknown {
  const text = raw.trim();
  switch (f.type) {
    case "list":
      return /^(none|\[\])?$/i.test(text) ? [] : text.split(/[\s,]+/).filter(Boolean);
    case "boolean":
      if (/^(1|true|yes|on)$/i.test(text)) return true;
      if (/^(0|false|no|off)$/i.test(text)) return false;
      throw new SettingsError("must be true or false");
    case "number": {
      const n = Number(text);
      if (text === "" || !Number.isFinite(n)) throw new SettingsError("must be a number");
      return n;
    }
    default:
      return text === "" ? undefined : text;
  }
}

export interface ControlSettings {
  /** Every control-plane setting with its current value and where that value comes from. */
  list(): FieldState[];
  /** Save changes (null: forget the saved value). Takes effect at once. */
  set(changes: Record<string, unknown>): { changed: string[] };
  /** The settings in effect now. */
  current(): Api;
}

export interface ControlSettingsOptions {
  registry: Registry;
  /** What config.yaml says (defaults filled in). */
  file: Api;
  /** The context the running API reads its settings from; updated whenever they change. */
  target: ApiContext;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  /** Put the settings in effect on `target` right away (default). Off when the target already carries its own values. */
  applyNow?: boolean;
}

export function createControlSettings(o: ControlSettingsOptions): ControlSettings {
  const env = o.env ?? {};
  const warn = o.warn ?? (() => {});
  const defaults = apiSchema.parse({});

  const envValues = new Map<string, unknown>();
  for (const f of FIELDS_CONTROL) {
    const raw = env[envVarFor(f.key)];
    if (raw === undefined) continue;
    try {
      const v = fromEnv(f, raw);
      if (v !== undefined) envValues.set(f.key, checkType(f, v));
    } catch (e) {
      warn(`${envVarFor(f.key)} ignored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Build the effective settings from the layers; throws when the combination is invalid. */
  const build = (saved: Record<string, unknown>) => {
    const obj = structuredClone(o.file) as unknown as Record<string, unknown>;
    const wrap = { api: obj };
    for (const [k, v] of Object.entries(saved)) if (BY_KEY.get(k)?.scope === "control") setPath(wrap, k, v);
    for (const [k, v] of envValues) setPath(wrap, k, v);
    return apiSchema.parse(obj);
  };

  const apply = (api: Api) => {
    const t = o.target;
    t.maxUploadBytes = api.maxUploadMb * 1024 * 1024;
    t.trustProxy = api.trustProxy;
    t.publicUrl = api.publicUrl;
    t.publicIps = api.publicIps;
    t.dns = createDnsResolver(api.dnsServers);
    t.metricsRetentionHours = api.metricsRetentionHours;
  };

  let effective: Api;
  try {
    effective = build(o.registry.settings.all());
  } catch (e) {
    warn(`saved settings ignored: ${e instanceof Error ? e.message : String(e)}`);
    effective = build({});
  }
  if (o.applyNow !== false) apply(effective);

  return {
    current: () => effective,
    list() {
      const saved = o.registry.settings.all();
      return FIELDS_CONTROL.map((f) => {
        const fromFile = getPath({ api: o.file }, f.key);
        const fromDefault = getPath({ api: defaults }, f.key) ?? null;
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const source: NonNullable<FieldState["source"]> = envValues.has(f.key) ? "env" : f.key in saved ? "dashboard" : !same(fromFile, fromDefault) ? "file" : "default";
        return {
          ...f,
          value: getPath({ api: effective }, f.key) ?? null,
          default: fromDefault,
          explicit: source !== "default",
          source,
          ...(envValues.has(f.key) ? { envVar: envVarFor(f.key) } : {}),
        };
      });
    },
    set(changes) {
      const before = o.registry.settings.all();
      const next = { ...before };
      const changed: string[] = [];
      for (const [key, value] of Object.entries(changes)) {
        const f = BY_KEY.get(key);
        if (!f || f.scope !== "control") throw new SettingsError(`"${key}" is not a setting of the control server`);
        if (envValues.has(key)) throw new SettingsError(`${f.label} is set by the environment variable ${envVarFor(key)}: change or remove that variable instead.`);
        if (value === null) {
          if (key in next) {
            delete next[key];
            changed.push(key);
          }
        } else {
          const v = checkType(f, value);
          if (JSON.stringify(next[key]) !== JSON.stringify(v)) changed.push(key);
          next[key] = v;
        }
      }
      let api: Api;
      try {
        api = build(next);
      } catch (e) {
        const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
        throw new SettingsError(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e));
      }
      for (const key of changed) {
        if (key in next) o.registry.settings.set(key, next[key]);
        else o.registry.settings.remove(key);
      }
      effective = api;
      apply(api);
      return { changed };
    },
  };
}
