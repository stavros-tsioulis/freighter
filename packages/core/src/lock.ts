import { mkdir, open, readFile, rm } from "node:fs/promises";
import type { Deps } from "./deps.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive host-wide lock: deploys serialize so port allocation and HAProxy writes never interleave. A dead pid's lock is taken over. */
export async function withLock<T>(d: Deps, app: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(d.layout.appsRoot, { recursive: true });
  const path = `${d.layout.appsRoot}/.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      if (attempt > 0 || (pid > 0 && alive(pid))) {
        throw new Error(`another deploy or rollback is in progress (needed for "${app}")${pid > 0 ? ` (pid ${pid})` : ""}`);
      }
      await rm(path, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
