import { parse } from "yaml";
import { manifestSchema, type Manifest } from "./schema.ts";
import { rewriteReferences } from "./reference.ts";

export interface ParseOptions {
  /** Releases written before domains moved out of app.yaml may still contain them; ignore them instead of failing. */
  legacy?: boolean;
  /**
   * Keep the app's `environment` apart from each service's own, as the file has them, for showing and editing. The default
   * is what runs: every service with the app's values under its own.
   */
  raw?: boolean;
}

/**
 * `secrets` used to sit at the top of app.yaml and apply to every service. Move them into each service, so releases and
 * stored settings written that way keep working. (`environment` at the top is the app's own now and stays where it is.)
 */
export function foldSharedEnvironment(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { secrets, ...rest } = raw as Record<string, unknown>;
  if (secrets === undefined) return raw;
  const services = rest.services;
  if (services && typeof services === "object" && Array.isArray(secrets)) {
    rest.services = Object.fromEntries(
      Object.entries(services).map(([name, svc]) => {
        if (!svc || typeof svc !== "object") return [name, svc];
        const own = svc as Record<string, unknown>;
        return [name, { ...own, secrets: [...new Set([...secrets, ...(Array.isArray(own.secrets) ? own.secrets : [])])] }];
      }),
    );
  }
  return rest;
}

const hasSharedSecrets = (raw: unknown) => !!raw && typeof raw === "object" && "secrets" in raw;

/** Give each service the app's environment under its own. */
function withAppEnvironment(m: Manifest): Manifest {
  if (Object.keys(m.environment).length === 0) return m;
  return { ...m, services: Object.fromEntries(Object.entries(m.services).map(([name, svc]) => [name, { ...svc, environment: { ...m.environment, ...svc.environment } }])) };
}

/**
 * `@self.KEY` (or `${self.KEY}`) in a service's environment means a value of that same service. It is written out as the service's name
 * before the manifest is checked, so everything downstream (validation, the loop guard, the graph) sees an ordinary
 * reference. A service that is itself called `self` keeps the plain meaning. Returns what was rewritten, to put back.
 */
function resolveSelf(raw: unknown): Map<string, string> {
  const changed = new Map<string, string>();
  const services = raw && typeof raw === "object" ? (raw as { services?: unknown }).services : undefined;
  if (!services || typeof services !== "object" || "self" in services) return changed;
  for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
    const env = svc && typeof svc === "object" ? (svc as { environment?: unknown }).environment : undefined;
    if (!env || typeof env !== "object") continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== "string" || !value.includes("self.")) continue;
      const out = rewriteReferences(value, (r) => (r.service === "self" && r.app === undefined && r.storage === undefined && r.volume === undefined ? r.text.replace("self.", `${name}.`) : null));
      if (out === value) continue;
      changed.set(`${name}\0${key}`, value);
      (env as Record<string, unknown>)[key] = out;
    }
  }
  return changed;
}

/** Parse and check, with `@self` expanded; `raw` output (for showing and editing) keeps it as written. */
function check(raw: unknown, opts: ParseOptions): Manifest {
  const changed = resolveSelf(raw);
  const m = manifestSchema.parse(raw);
  if (opts.raw && changed.size > 0) {
    for (const [id, written] of changed) {
      const [service, key] = id.split("\0") as [string, string];
      m.services[service]!.environment[key] = written;
    }
  }
  return m;
}

export function parseManifest(source: string, opts: ParseOptions = {}): Manifest {
  const raw = parse(source);
  if (raw && typeof raw === "object" && "domains" in raw) {
    if (!opts.legacy) {
      throw new Error('"domains" is not part of app.yaml: set the app\'s domains in the dashboard, with the API, or with `freighter domain add`');
    }
    delete (raw as Record<string, unknown>).domains;
  }
  if (hasSharedSecrets(raw)) {
    if (!opts.legacy) {
      throw new Error('"secrets" belong to each service: put them under the service they are for');
    }
    const m = check(foldSharedEnvironment(raw), opts);
    return opts.raw ? m : withAppEnvironment(m);
  }
  const m = check(raw, opts);
  return opts.raw ? m : withAppEnvironment(m);
}
