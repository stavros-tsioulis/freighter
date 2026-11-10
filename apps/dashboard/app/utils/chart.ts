export interface ChartPoint {
  /** Milliseconds since the epoch. */
  t: number;
  v: number | null;
}
export interface ChartGeometry {
  line: string;
  area: string;
  /** The plotted points with their coordinates, for finding the one under the pointer. */
  dots: { x: number; y: number; t: number; v: number }[];
}

const fmt = (n: number) => Number(n.toFixed(1));

/**
 * A time series in a `w` x `h` box: time runs along x between `from` and `to`, values along y between 0 and `yMax`
 * (a value above it is drawn at the top). A gap longer than `gapMs` breaks the line, so a stretch with no readings
 * shows as a hole instead of a slope.
 */
export function chartGeometry(points: ChartPoint[], from: number, to: number, yMax: number, w: number, h: number, gapMs: number, pad = 2): ChartGeometry {
  const real = points.filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.v) && p.t >= from - 1 && p.t <= to + 1).sort((a, b) => a.t - b.t);
  const span = Math.max(1, to - from);
  const x = (t: number) => pad + ((t - from) / span) * (w - pad * 2);
  const y = (v: number) => h - pad - (Math.min(Math.max(v, 0), yMax) / (yMax || 1)) * (h - pad * 2);
  const dots = real.map((p) => ({ x: fmt(x(p.t)), y: fmt(y(p.v)), t: p.t, v: p.v }));
  let line = "";
  let area = "";
  let run: typeof dots = [];
  const flush = () => {
    if (run.length === 0) return;
    line += run.map((d, i) => `${i === 0 ? "M" : "L"}${d.x} ${d.y}`).join(" ");
    if (run.length > 1) area += `M${run[0]!.x} ${h - pad} ` + run.map((d) => `L${d.x} ${d.y}`).join(" ") + ` L${run.at(-1)!.x} ${h - pad} Z`;
    run = [];
  };
  dots.forEach((d, i) => {
    if (i > 0 && d.t - dots[i - 1]!.t > gapMs) flush();
    run.push(d);
    if (i === dots.length - 1) flush();
  });
  return { line, area, dots };
}

/** The point nearest to x (in the same coordinates as the dots), or undefined without any. */
export function nearest(dots: ChartGeometry["dots"], x: number): ChartGeometry["dots"][number] | undefined {
  let best: ChartGeometry["dots"][number] | undefined;
  for (const d of dots) if (!best || Math.abs(d.x - x) < Math.abs(best.x - x)) best = d;
  return best;
}

/** A tidy upper bound for a chart of values up to `max`: 1, 2, 4, 8, ... or the next multiple of 10 for big numbers. */
export function niceMax(max: number, floor = 1): number {
  if (!Number.isFinite(max) || max <= floor) return floor;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((c) => c >= max) ?? max;
}
