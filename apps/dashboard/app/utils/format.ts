/** 1536 -> "1.5 KiB"; null/undefined -> "–". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.max(n, 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 83_000 -> "1m 23s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "2 minutes ago" / "in 3 days" relative to `now`. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 45 ? [abs, "second"] : abs < 2700 ? [Math.round(abs / 60), "minute"] : abs < 79200 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
  if (abs < 5) return "just now";
  const label = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

/** Whole days until `iso` (negative when past); null when unknown. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((t - now) / 86_400_000);
}

/** r20261106-134501-2 -> "20261106-134501-2" (drop the leading r for display). */
export const shortRelease = (id: string | null | undefined) => (id ? id.replace(/^r/, "") : "–");

export function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const d = Date.parse(end) - Date.parse(start);
  return Number.isNaN(d) ? null : d;
}
