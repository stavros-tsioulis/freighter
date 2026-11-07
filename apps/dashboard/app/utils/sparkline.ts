export interface SparklineGeometry {
  /** SVG path for the line; gaps (null values) start a new sub-path. */
  line: string;
  /** Closed path for the filled area under the line ("" when there are < 2 points). */
  area: string;
  min: number;
  max: number;
  /** Number of plotted (non-null) points. */
  count: number;
}

const fmt = (n: number) => Number(n.toFixed(2));

/** Scale values into a `width` x `height` box with `pad` px of padding. A flat series is drawn mid-height. */
export function sparkline(values: (number | null)[], width: number, height: number, pad = 2): SparklineGeometry {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length === 0) return { line: "", area: "", min: 0, max: 0, count: 0 };
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (v: number) => (span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2));

  let line = "";
  let drawing = false;
  const xs: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      drawing = false;
      return;
    }
    const x = pad + i * step;
    line += `${drawing ? "L" : "M"}${fmt(x)} ${fmt(y(v))}`;
    drawing = true;
    xs.push({ x, y: y(v) });
  });
  // A single point has no line; draw a tiny horizontal tick so it is visible.
  if (xs.length === 1) line += `h0.01`;

  let area = "";
  if (xs.length >= 2 && !values.includes(null)) {
    const first = xs[0]!;
    const last = xs[xs.length - 1]!;
    area = `${line}L${fmt(last.x)} ${height}L${fmt(first.x)} ${height}Z`;
  }
  return { line, area, min, max, count: real.length };
}
