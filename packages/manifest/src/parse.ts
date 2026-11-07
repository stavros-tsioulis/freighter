import { parse } from "yaml";
import { manifestSchema, type Manifest } from "./schema.ts";

export interface ParseOptions {
  /** Releases written before domains moved out of app.yaml may still contain them; ignore them instead of failing. */
  legacy?: boolean;
}

export function parseManifest(source: string, opts: ParseOptions = {}): Manifest {
  const raw = parse(source);
  if (raw && typeof raw === "object" && "domains" in raw) {
    if (!opts.legacy) {
      throw new Error('"domains" is not part of app.yaml: set the app\'s domains in the dashboard, with the API, or with `freighter domain add`');
    }
    delete (raw as Record<string, unknown>).domains;
  }
  return manifestSchema.parse(raw);
}
