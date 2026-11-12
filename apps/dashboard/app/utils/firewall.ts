import type { FirewallRule } from "~/types";

/** A rule apart from its number, which moves when another rule goes (the agent checks it before it removes anything). */
export const ruleSignature = (r: Pick<FirewallRule, "to" | "action" | "direction" | "from">) => [r.to, r.action, r.direction, r.from].map((x) => x.replace(/\s+/g, " ").trim()).join("|");

const strip = (s: string) => s.replace(/\s*\(v6\)$/, "");
/** The IPv4 rule an IPv6 copy was made with, if it is one. */
export const v4Twin = (rule: FirewallRule, rules: FirewallRule[]) =>
  rule.v6 ? rules.find((r) => !r.v6 && r.action === rule.action && r.direction === rule.direction && r.comment === rule.comment && r.to === strip(rule.to) && r.from === strip(rule.from)) : undefined;
/** Whether a rule has an IPv6 copy (removing it removes both). */
export const hasV6Twin = (rule: FirewallRule, rules: FirewallRule[]) => !rule.v6 && rules.some((r) => v4Twin(r, rules)?.number === rule.number);

/** What a rule applies to, in words: `22/tcp` -> "port 22, TCP". */
export function describeTo(to: string): string {
  const t = strip(to.replace(/\s+on\s+\S+$/, "")).trim();
  if (/^Anywhere/i.test(t)) return "any port";
  const m = /^([\d:,]+)(?:\/(\w+))?$/.exec(t);
  if (!m) return t;
  const ports = m[1]!.split(",").map((p) => (p.includes(":") ? p.replace(":", "–") : p));
  return `port${m[1]!.includes(",") || m[1]!.includes(":") ? "s" : ""} ${ports.join(", ")}${m[2] ? `, ${m[2].toUpperCase()}` : ""}`;
}

export const PRESETS = [
  { label: "SSH", port: "22", proto: "tcp" },
  { label: "HTTP", port: "80", proto: "tcp" },
  { label: "HTTPS", port: "443", proto: "tcp" },
  { label: "PostgreSQL", port: "5432", proto: "tcp" },
  { label: "MySQL", port: "3306", proto: "tcp" },
  { label: "Redis", port: "6379", proto: "tcp" },
  { label: "DNS", port: "53", proto: "any" },
] as const;

const PORT_RE = /^\d{1,5}(:\d{1,5})?(,\d{1,5}(:\d{1,5})?)*$/;
/** A problem with what was typed for a rule, or "". The agent checks it again. */
export function ruleProblem(f: { port: string; proto: string; from: string; to: string }): string {
  const port = f.port.trim();
  if (port) {
    if (!PORT_RE.test(port) || port.split(/[:,]/).some((n) => Number(n) < 1 || Number(n) > 65535)) return "Ports are numbers from 1 to 65535: 80, 6000:6007 or 80,443";
    if ((port.includes(",") || port.includes(":")) && f.proto === "any") return "A range or a list of ports needs TCP or UDP";
  }
  const addr = (a: string) => !a.trim() || a.trim() === "any" || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(a.trim());
  if (!addr(f.from)) return "From is an IP address or a network such as 10.0.0.0/8, or empty for anywhere";
  if (!addr(f.to)) return "To is an IP address of this server, or empty for any";
  return "";
}
