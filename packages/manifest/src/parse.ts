import { parse } from "yaml";
import { manifestSchema, type Manifest } from "./schema.ts";

export interface ParseOptions {
  /** Releases written before domains moved out of app.yaml may still contain them; ignore them instead of failing. */
  legacy?: boolean;
}

/**
 * `environment` and `secrets` used to sit at the top of app.yaml and applied to every service. Move them into each
 * service (what a service sets itself wins), so releases and stored settings written that way keep working.
 */
export function foldSharedEnvironment(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { environment, secrets, ...rest } = raw as Record<string, unknown>;
  if (environment === undefined && secrets === undefined) return raw;
  const services = rest.services;
  if (services && typeof services === "object") {
    rest.services = Object.fromEntries(
      Object.entries(services).map(([name, svc]) => {
        if (!svc || typeof svc !== "object") return [name, svc];
        const own = svc as Record<string, unknown>;
        return [
          name,
          {
            ...own,
            ...(environment && typeof environment === "object" ? { environment: { ...environment, ...(own.environment as object | undefined) } } : {}),
            ...(Array.isArray(secrets) ? { secrets: [...new Set([...secrets, ...(Array.isArray(own.secrets) ? own.secrets : [])])] } : {}),
          },
        ];
      }),
    );
  }
  return rest;
}

const hasShared = (raw: unknown) => !!raw && typeof raw === "object" && ("environment" in raw || "secrets" in raw);

export function parseManifest(source: string, opts: ParseOptions = {}): Manifest {
  const raw = parse(source);
  if (raw && typeof raw === "object" && "domains" in raw) {
    if (!opts.legacy) {
      throw new Error('"domains" is not part of app.yaml: set the app\'s domains in the dashboard, with the API, or with `freighter domain add`');
    }
    delete (raw as Record<string, unknown>).domains;
  }
  if (hasShared(raw)) {
    if (!opts.legacy) {
      throw new Error('"environment" and "secrets" belong to each service now: put them under the service they are for');
    }
    return manifestSchema.parse(foldSharedEnvironment(raw));
  }
  return manifestSchema.parse(raw);
}
