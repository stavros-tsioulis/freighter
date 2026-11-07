import { stringify } from "yaml";
import { parseManifest } from "./parse.ts";
import { settingsSchema, type ManifestSettings } from "./schema.ts";

/**
 * Turn settings entered in the UI into the text of an `app.yaml`. The result is parsed again, so anything the file
 * format would reject is rejected here too (throws a ZodError / Error with a readable message).
 */
export function renderManifest(name: string, settings: ManifestSettings): string {
  const s = settingsSchema.parse(settings);
  const text = stringify({ name, ...s }, { lineWidth: 0 });
  parseManifest(text);
  return text;
}
