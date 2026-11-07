import type { Deps } from "./deps.ts";
import { goLive } from "./apply.ts";
import { readHistory, recordHistory } from "./history.ts";
import { withLock } from "./lock.ts";
import { currentRelease, listReleaseIds } from "./releases.ts";
import { describeFailures } from "./verify.ts";

export interface RollbackOptions {
  /** Release id to roll back to; defaults to the most recent other successful release. */
  target?: string;
  skipVerify?: boolean;
}

export interface RollbackResult {
  app: string;
  from: string;
  to: string;
  verified: boolean;
  historyAt: string;
}

export async function rollback(d: Deps, app: string, opts: RollbackOptions = {}): Promise<RollbackResult> {
  if (!d.isRoot) throw new Error("rollback must run as root (or use --prefix for a dry local run)");
  const current = await currentRelease(d, app);
  if (!current) throw new Error(`app "${app}" is not deployed`);

  return withLock(d, app, async () => {
    const ids = await listReleaseIds(d, app);
    let target = opts.target;
    if (target !== undefined) {
      if (!ids.includes(target)) throw new Error(`unknown release "${target}" (have: ${ids.join(", ")})`);
      if (target === current) throw new Error(`release ${target} is already current`);
    } else {
      const history = await readHistory(d, app);
      target = history
        .filter((h) => h.result === "success" && h.release !== current && ids.includes(h.release))
        .at(-1)?.release;
      target ??= ids.filter((id) => id < current).at(-1);
      if (!target) throw new Error(`no release to roll back to for "${app}"`);
    }

    // Same zero-downtime path as a deploy: a fresh instance of the target goes live, the current one retires.
    const live = await goLive(d, app, target, { skipVerify: opts.skipVerify, previous: current });
    const entry = await recordHistory(d, app, {
      action: "rollback",
      release: target,
      previous: current,
      result: live.ok ? "success" : "failed",
      reason: live.ok ? undefined : live.failures.map((f) => `${f.service}: ${f.reason}`).join("; "),
    });
    if (!live.ok) throw new Error(`rollback to ${target} failed; ${current} is still current:\n${describeFailures(live.failures)}`);
    return { app, from: current, to: target, verified: !opts.skipVerify, historyAt: entry.at };
  });
}
