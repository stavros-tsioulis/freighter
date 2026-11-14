/** Lines that differ between two texts, as `-`/`+` lines with a little context. Empty when they are the same. */
export function lineDiff(before: string, after: string, context = 2): string[] {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  // longest common subsequence of lines
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) ops.push({ t: " ", line: a[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < m) ops.push({ t: "-", line: a[i++]! });
  while (j < n) ops.push({ t: "+", line: b[j++]! });
  if (!ops.some((o) => o.t !== " ")) return [];
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o.t !== " ") for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep.add(x);
  });
  const out: string[] = [];
  let last = -1;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (last !== -1 && k > last + 1) out.push("…");
    out.push(`${o.t === " " ? " " : o.t} ${o.line}`);
    last = k;
  });
  return out;
}
