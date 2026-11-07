import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Delete spooled artifacts older than `maxAgeMs` (leftovers from crashed uploads/jobs). Returns the count. */
export async function pruneSpool(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith(".tar.gz"))) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > maxAgeMs) {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}
