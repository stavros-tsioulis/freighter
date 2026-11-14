import * as z from "zod/v4";
import { apiGet } from "./api.ts";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./constants.ts";
import { ago, ok, respond, type ResponseFormatValue, type ToolResult } from "./format.ts";

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

/** The arguments of every tool that starts a deployment: wait for it, or hand back its id. */
export const WaitArgs = {
  wait: z.boolean().default(true).describe("Wait for the deployment to end and report how it went. false returns its id at once (follow it with freighter_get_deployment)"),
  timeout_seconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS).describe("How long to wait, in seconds. The deployment carries on if this runs out"),
};

const over = (d: Deployment) => d.status === "success" || d.status === "failed";
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
const poll = () => Number(process.env.FREIGHTER_POLL_MS) || 1000;

/** The steps a deployment's log names (Freighter writes them as `==> ...`). */
export async function steps(id: string, signal: AbortSignal): Promise<string[]> {
  try {
    const log = await apiGet<{ text: string }>(`/deployments/${id}/log`, {}, signal);
    return log.text.split("\n").filter((l) => l.startsWith("==> ")).map((l) => l.slice(4));
  } catch {
    return []; // the log needs the deployer role: the result is still reported
  }
}

export async function waitFor(id: string, seconds: number, signal: AbortSignal): Promise<{ deployment: Deployment; finished: boolean }> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const deployment = await apiGet<Deployment>(`/deployments/${id}`, {}, signal);
    if (over(deployment)) return { deployment, finished: true };
    if (Date.now() >= end || signal.aborted) return { deployment, finished: false };
    await sleep(poll(), signal);
  }
}

export function describe(d: Deployment, stepLines: string[] = []): string {
  const lines = [`## Deployment ${d.id.slice(0, 8)}: ${d.action} of ${d.app} — ${d.status}`, `- Id: ${d.id}`, `- Server: ${d.server}`];
  if (d.releaseId) lines.push(`- Release: ${d.releaseId}${d.previousRelease ? ` (was ${d.previousRelease})` : ""}`);
  if (d.commitSha) lines.push(`- Commit: ${d.commitSha.slice(0, 12)} ${d.commitSubject ?? ""}`.trimEnd());
  lines.push(`- Started: ${ago(d.startedAt ?? d.createdAt)}${d.finishedAt && d.startedAt ? `, took ${Math.round((Date.parse(d.finishedAt) - Date.parse(d.startedAt)) / 1000)}s` : ""}`);
  if (d.error) lines.push("", "Error:", "```", d.error.slice(0, 4000), "```");
  for (const w of d.warnings ?? []) lines.push(`- Warning: ${w}`);
  if (stepLines.length) lines.push("", "Steps:", ...stepLines.map((s) => `- ${s}`));
  return lines.join("\n");
}

/**
 * What a tool that starts work says: with `wait`, how it ended (a failed deployment is a tool error, with the reason);
 * without it, or when the time runs out, the id to follow it with.
 */
export async function finish(queued: { id: string }, o: { wait: boolean; timeout_seconds: number }, signal: AbortSignal, format: ResponseFormatValue = "markdown"): Promise<ToolResult> {
  if (!o.wait) return respond(format, `Queued deployment ${queued.id}. Follow it with freighter_get_deployment id=${queued.id}.`, { id: queued.id, status: "queued" });
  const { deployment, finished } = await waitFor(queued.id, o.timeout_seconds, signal);
  const stepLines = await steps(queued.id, signal);
  const data = { ...deployment, steps: stepLines, finished };
  if (!finished) return respond(format, `${describe(deployment, stepLines)}\n\nStill ${deployment.status} after ${o.timeout_seconds}s; it carries on. Check again with freighter_get_deployment id=${deployment.id}.`, data);
  const result = respond(format, describe(deployment, stepLines), data);
  if (deployment.status === "failed") return { ...result, isError: true, content: [{ type: "text", text: `${describe(deployment, stepLines)}\n\nFor the whole log: freighter_get_deployment_log id=${deployment.id}.` }] };
  return result;
}

export { ok };
