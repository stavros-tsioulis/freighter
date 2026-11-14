import type { Api } from "./api.ts";
import { CliError, EXIT } from "./errors.ts";
import { duration, type Out } from "./out.ts";

export interface Deployment {
  id: string;
  app: string;
  server: string;
  action: string;
  status: "queued" | "running" | "success" | "failed";
  releaseId: string | null;
  previousRelease: string | null;
  error: string | null;
  warnings: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  commitSha?: string | null;
  commitSubject?: string | null;
}

/** How long to wait between looks; `$FREIGHTER_POLL_MS` is for tests. */
const poll = () => Number(process.env.FREIGHTER_POLL_MS) || 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const over = (d: Deployment) => d.status === "success" || d.status === "failed";

/** The lines of a deployment log that say what it is doing: Freighter writes them as `==> ...`. */
const isStep = (line: string) => line.startsWith("==> ");

/**
 * Show a deployment's steps as they happen (all its log with `verbose`) until it is over, and return how it ended.
 * Nothing is printed in `--json` and `--quiet` mode. `timeoutMs` stops waiting, not the deployment.
 */
export async function follow(api: Api, out: Out, id: string, o: { verbose?: boolean; timeoutMs?: number; /** Where the lines go (default: as steps, on standard error). */ sink?: (line: string) => void } = {}): Promise<Deployment> {
  const started = Date.now();
  let from = 0;
  let pending = "";
  const show = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (o.verbose) (o.sink ?? ((l: string) => out.step(l)))(line);
      else if (isStep(line)) out.step(line.slice(4));
    }
  };
  for (;;) {
    const d = await api.get<Deployment>(`/deployments/${id}`);
    // the log needs a deployer token; a viewer still gets the result
    const log = await api.get<{ text: string; next: number }>(`/deployments/${id}/log`, { from }).catch(() => null);
    if (log) {
      from = log.next;
      show(log.text);
    }
    if (over(d)) {
      if (pending) show("\n");
      return d;
    }
    if (o.timeoutMs && Date.now() - started > o.timeoutMs) throw new CliError(`still ${d.status} after ${duration(o.timeoutMs)}; it carries on without you`, EXIT.failed, `follow it with \`freighter deployment logs ${id} -f\``);
    await sleep(poll());
  }
}

/** The one line that says how a deployment ended: its exit code is `5` when it failed. */
export function conclude(out: Out, d: Deployment, o: { verb?: string } = {}): void {
  for (const w of d.warnings ?? []) out.warn(w);
  const took = d.startedAt && d.finishedAt ? duration(Date.parse(d.finishedAt) - Date.parse(d.startedAt)) : "";
  if (d.status === "failed") {
    const reason = (d.error ?? "it failed").split("\n")[0]!;
    throw new CliError(`${o.verb ?? "deployment"} ${d.id.slice(0, 8)} failed: ${reason}`, EXIT.deployFailed, `the log: freighter deployment logs ${d.id}`);
  }
  out.note(`${d.app}${d.releaseId ? ` is live on ${d.releaseId}` : ": done"}${took ? ` (${took})` : ""}`);
}

/** Start waiting unless `--no-wait`: with it, the deployment id is the result. */
export async function finish(api: Api, out: Out, queued: { id: string }, o: { wait: boolean; verbose?: boolean; timeoutMs?: number; verb?: string }): Promise<void> {
  if (!o.wait) {
    out.ids([queued.id], { id: queued.id, status: "queued" }, () => out.line(queued.id));
    return;
  }
  const d = await follow(api, out, queued.id, o);
  conclude(out, d, o);
  out.ids([d.id], d, () => undefined);
}

/** `10m`, `90s`, `2h` as milliseconds. */
export function parseSpan(s: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new CliError(`"${s}" is not a duration`, EXIT.usage, "like 90s, 10m or 2h");
  return Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"] as number);
}
