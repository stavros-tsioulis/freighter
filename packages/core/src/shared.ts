import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { parseManifest } from "@freighter/manifest";
import { envFile, legacyEnvFile, legacyRefsEnvFile } from "@freighter/systemd";
import type { Deps } from "./deps.ts";
import { currentRelease, appDir, releaseDir } from "./releases.ts";

/**
 * Secrets, credentials from connections and variables used to be shared by all services of an app. They belong to one
 * service each now, and this moves what an app still has in the old places: a secret goes to every service that declares
 * it, a variable to every service (as it applied to all), and the credentials from connections are written again at the
 * next deploy. It does nothing once the old files are gone.
 */
export async function migrateShared(d: Deps, app: string, services?: Record<string, { secrets: string[] }>): Promise<void> {
  const secretsPath = legacyEnvFile(d.layout, app);
  const refsPath = legacyRefsEnvFile(d.layout, app);
  const variablesPath = `${appDir(d, app)}/variables.json`;
  const exists = (p: string) => access(p).then(() => true, () => false);
  const [hasSecrets, hasRefs, hasVariables] = await Promise.all([exists(secretsPath), exists(refsPath), exists(variablesPath)]);
  if (!hasSecrets && !hasRefs && !hasVariables) return;

  let flat: Record<string, string> | undefined;
  if (hasVariables) {
    const raw = JSON.parse(await readFile(variablesPath, "utf8")) as Record<string, unknown>;
    if (Object.values(raw).some((v) => typeof v === "string")) flat = raw as Record<string, string>;
  }
  if (!hasSecrets && !hasRefs && !flat) return;

  let known = services;
  if (!known) {
    const release = await currentRelease(d, app);
    if (!release) return; // nothing to split them by yet: the first deploy will
    try {
      known = parseManifest(await readFile(`${releaseDir(d, app, release)}/app.yaml`, "utf8"), { legacy: true }).services;
    } catch {
      return;
    }
  }

  if (hasSecrets) {
    const lines = (await readFile(secretsPath, "utf8")).split("\n").filter((l) => l !== "");
    const keyOf = (l: string) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1];
    for (const [service, def] of Object.entries(known)) {
      const path = envFile(d.layout, app, service);
      const own = await readFile(path, "utf8").then((t) => t.split("\n").filter((l) => l !== ""), () => [] as string[]);
      const have = new Set(own.map(keyOf));
      const moved = lines.filter((l) => {
        const k = keyOf(l);
        return k !== undefined && def.secrets.includes(k) && !have.has(k);
      });
      if (moved.length === 0) continue;
      await mkdir(`${d.layout.envDir}/${app}`, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, [...own, ...moved].join("\n") + "\n", { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    }
    await rm(secretsPath, { force: true });
  }
  await rm(refsPath, { force: true });

  if (flat) {
    const nested = Object.fromEntries(Object.keys(known).map((service) => [service, flat]));
    await writeFile(`${variablesPath}.tmp`, JSON.stringify(nested, null, 2) + "\n", { mode: 0o644 });
    await rename(`${variablesPath}.tmp`, variablesPath);
  }
}
