import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { defaultRun, type Run } from "@freighter/systemd";

/**
 * Freighter is installed as a git checkout (`/opt/freighter`, see infra/install.sh), so "which version is running" is
 * "which commit is checked out". The root is found from the running script, which lives somewhere inside it.
 */
export async function findInstallDir(script: string | undefined = process.argv[1], exec: Run = defaultRun): Promise<string | null> {
  if (!script) return null;
  let here: string;
  try {
    here = dirname(realpathSync(script));
  } catch {
    return null;
  }
  const top = await exec("git", ["-C", here, "rev-parse", "--show-toplevel"]);
  const dir = top.code === 0 ? top.stdout.trim() : "";
  return dir && existsSync(`${dir}/infra/install.sh`) ? dir : null;
}

/** The checked-out commit (12 hex characters), or null when `dir` is not a git checkout. */
export async function checkoutCommit(dir: string | null | undefined, exec: Run = defaultRun): Promise<string | null> {
  if (!dir) return null;
  const r = await exec("git", ["-C", dir, "rev-parse", "--short=12", "HEAD"]);
  return r.code === 0 && /^[0-9a-f]{12}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

let controlCommit: Promise<string | null> | undefined;
/** The commit this process (the control plane, or the CLI on it) runs. Looked up once. */
export function runningCommit(): Promise<string | null> {
  controlCommit ??= findInstallDir().then((dir) => checkoutCommit(dir));
  return controlCommit;
}
