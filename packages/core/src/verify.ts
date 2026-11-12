import { parseDuration, type Manifest } from "@freighter/manifest";
import { unitName } from "@freighter/systemd";
import type { Deps } from "./deps.ts";

export const SETTLE_MS = 3000;
const POLL_MS = 1000;

export interface VerifyFailure {
  service: string;
  reason: string;
  logs: string;
}
export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
}

async function tailLogs(d: Deps, unit: string): Promise<string> {
  try {
    return (await d.run("journalctl", d.systemd.logsArgs(unit, { lines: 20 }))).stdout.trim();
  } catch {
    return "";
  }
}

export interface Target {
  unit: string;
  port?: number;
}

/** In-place targets: the plain unit name and the manifest port. */
export function defaultTargets(app: string, manifest: Manifest): Record<string, Target> {
  return Object.fromEntries(
    Object.entries(manifest.services).map(([service, def]) => [service, { unit: unitName({ app, service }), port: def.port }]),
  );
}

async function checkService(d: Deps, manifest: Manifest, service: string, target: Target, signal?: AbortSignal): Promise<string | null> {
  const def = manifest.services[service]!;
  const unit = target.unit;
  const hc = def.healthcheck;

  if (hc && target.port !== undefined) {
    const url = `http://127.0.0.1:${target.port}${hc.path}`;
    const timeout = parseDuration(hc.timeout);
    for (let waited = 0; waited < timeout; waited += POLL_MS) {
      if (signal?.aborted) return "canceled";
      const st = await d.systemd.status(unit);
      if (st.activeState === "failed" || st.restarts >= 1) return `service crashed (state ${st.activeState}/${st.subState}, restarts ${st.restarts})`;
      const code = await d.probe(url, 2000);
      if (code !== null && code >= 200 && code < 300) return null;
      await d.sleep(POLL_MS);
    }
    return `no healthy response from ${hc.path} within ${hc.timeout}`;
  }

  await d.sleep(SETTLE_MS);
  if (signal?.aborted) return "canceled";
  const st = await d.systemd.status(unit);
  if (st.activeState !== "active" || st.restarts > 0) {
    return `service is not stable (state ${st.activeState}/${st.subState}, restarts ${st.restarts})`;
  }
  return null;
}

export async function verifyRelease(
  d: Deps,
  app: string,
  manifest: Manifest,
  targets: Record<string, Target> = defaultTargets(app, manifest),
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const results = await Promise.all(
    Object.keys(manifest.services).map(async (service) => {
      const target = targets[service]!;
      const reason = await checkService(d, manifest, service, target, signal);
      return reason === null ? null : { service, reason, logs: await tailLogs(d, target.unit) };
    }),
  );
  const failures = results.filter((r): r is VerifyFailure => r !== null);
  return { ok: failures.length === 0, failures };
}

export function describeFailures(failures: VerifyFailure[]): string {
  return failures
    .map((f) => `  ${f.service}: ${f.reason}` + (f.logs ? "\n" + f.logs.split("\n").map((l) => `    | ${l}`).join("\n") : ""))
    .join("\n");
}
