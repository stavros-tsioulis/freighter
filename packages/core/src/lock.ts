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

/** How long to wait for another deploy to finish before giving up. */
export const LOCK_WAIT_MS = 45_000;
const POLL_MS = 250;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ago = (since: number) => {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
};

/**
 * Exclusive host-wide lock: deploys serialize so port allocation and HAProxy writes never interleave. A dead pid's lock
 * is taken over. When another deploy holds it, this waits a while for it to finish (a deploy or rollback is a matter
 * of seconds to a few minutes) before refusing, and the refusal says which app has it and for how long.
 */
export async function withLock<T>(d: Deps, app: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(d.layout.appsRoot, { recursive: true });
  const path = `${d.layout.appsRoot}/.lock`;
  const deadline = Date.now() + (d.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(`${process.pid} ${app} ${Date.now()}`);
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const [pidText, holder, sinceText] = (await readFile(path, "utf8").catch(() => "")).trim().split(" ");
      const pid = Number(pidText);
      if (!(pid > 0 && alive(pid))) {
        await rm(path, { force: true }); // its owner is gone
        continue;
      }
      if (Date.now() >= deadline) {
        const since = Number(sinceText);
        throw new Error(
          `another deploy or rollback is in progress (needed for "${app}")${holder ? `: ${holder === "certs" ? "certificates are being renewed" : `"${holder}" has been deploying`}${since > 0 ? ` for ${ago(since)}` : ""}` : ""} (pid ${pid})`,
        );
      }
      await pause(POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
