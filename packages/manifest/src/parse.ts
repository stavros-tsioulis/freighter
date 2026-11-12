import { parse } from "yaml";
import { manifestSchema, type Manifest } from "./schema.ts";

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
    const m = manifestSchema.parse(foldSharedEnvironment(raw));
    return opts.raw ? m : withAppEnvironment(m);
  }
  const m = manifestSchema.parse(raw);
  return opts.raw ? m : withAppEnvironment(m);
}
