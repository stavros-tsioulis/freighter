const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** "500ms" | "30s" | "2m" | "1h" -> milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) throw new Error(`invalid duration "${text}"`);
  return Number(m[1]) * UNITS[m[2] as keyof typeof UNITS];
}
