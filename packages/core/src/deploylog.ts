import { appendFile, mkdir } from "node:fs/promises";
import type { Deps } from "./deps.ts";

/** Writes one line of a deployment's log. The log is what the dashboard shows while the deployment runs. */
export type DeployLog = (line: string) => void | Promise<void>;

export const noLog: DeployLog = () => {};

/**
 * The log of deployment `id`, in the file `build.log` reads: the same one a Git deploy's build output goes to, so the
 * steps of the deploy itself follow the build there. Logging is best effort and never fails a deployment.
 */
export async function openDeployLog(d: Deps, id: string): Promise<DeployLog> {
  const file = `${d.config.git.buildDir}/${id}.log`;
  await mkdir(d.config.git.buildDir, { recursive: true }).catch(() => undefined);
  return async (line) => {
    await appendFile(file, `${line}\n`).catch(() => undefined);
  };
}
