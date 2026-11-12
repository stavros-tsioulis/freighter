import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { Deps } from "./deps.ts";

/**
 * The server's firewall, through ufw. Installing ufw does not turn it on: that is a step of its own, which first makes
 * sure the ways in that Freighter and the administrator depend on (SSH, the web ports, the agent's own port) are
 * allowed. Rules are read from `ufw status numbered`; a rule is only changed or removed after checking that the number
 * still names the rule that was shown, since numbers move whenever another rule goes.
 */
export class FirewallError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "FirewallError";
  }
}

export type Action = "allow" | "deny" | "reject" | "limit";
export type Policy = "allow" | "deny" | "reject";

export interface FirewallRule {
  number: number;
  /** What it applies to on this machine: `22/tcp`, `80,443/tcp`, `Anywhere`. */
  to: string;
  action: Action;
  direction: "in" | "out" | "fwd";
  /** Where it applies to traffic from: `Anywhere`, `10.0.0.0/8`. */
  from: string;
  comment: string;
  /** The IPv6 twin ufw makes of a rule with no address. */
  v6: boolean;
}

export interface EssentialPort {
  port: number;
  what: string;
}

export interface FirewallStatus {
  installed: boolean;
  active: boolean;
  defaults: { incoming: Policy; outgoing: Policy; routed: Policy | "disabled" } | null;
  logging: string | null;
  rules: FirewallRule[];
  /** Ports the firewall must keep open for this server to stay manageable. */
  essential: EssentialPort[];
}

// ---- reading ufw ----

const ACTIONS = { ALLOW: "allow", DENY: "deny", REJECT: "reject", LIMIT: "limit" } as const;
const POLICY: Record<string, Policy> = { allow: "allow", deny: "deny", reject: "reject", ACCEPT: "allow", DROP: "deny", REJECT: "reject" };

/** The rules in `ufw status numbered`. */
export function parseRules(text: string): FirewallRule[] {
  const out: FirewallRule[] = [];
  for (const line of text.split("\n")) {
    const m = /^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?: (IN|OUT|FWD))?\s{2,}(.+?)(?:\s+#\s*(.*))?\s*$/.exec(line);
    if (!m) continue;
    const to = m[2]!.trim();
    const from = m[5]!.trim();
    out.push({
      number: Number(m[1]),
      to,
      action: ACTIONS[m[3] as keyof typeof ACTIONS],
      direction: (m[4] ?? "IN").toLowerCase() as FirewallRule["direction"],
      from,
      comment: (m[6] ?? "").trim(),
      v6: /\(v6\)/.test(to) || /\(v6\)/.test(from),
    });
  }
  return out;
}

/** `Default: deny (incoming), allow (outgoing), disabled (routed)` and `Logging: on (low)` of `ufw status verbose`. */
export function parseVerbose(text: string): { active: boolean; defaults: FirewallStatus["defaults"]; logging: string | null } {
  const active = /^Status:\s*active/m.test(text);
  const d = /^Default:\s*(\w+) \(incoming\),\s*(\w+) \(outgoing\),\s*(\w+) \(routed\)/m.exec(text);
  const p = (v: string) => POLICY[v] ?? "deny";
  return {
    active,
    defaults: d ? { incoming: p(d[1]!), outgoing: p(d[2]!), routed: d[3] === "disabled" ? "disabled" : p(d[3]!) } : null,
    logging: /^Logging:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
  };
}

/** The policies ufw starts with when it is off: `/etc/default/ufw`. */
export function parseDefaults(text: string): NonNullable<FirewallStatus["defaults"]> {
  const get = (k: string, fallback: string) => POLICY[new RegExp(`^${k}="?(\\w+)"?`, "m").exec(text)?.[1] ?? fallback] ?? "deny";
  const routed = /^DEFAULT_FORWARD_POLICY="?(\w+)"?/m.exec(text)?.[1];
  return { incoming: get("DEFAULT_INPUT_POLICY", "DROP"), outgoing: get("DEFAULT_OUTPUT_POLICY", "ACCEPT"), routed: routed ? (POLICY[routed] ?? "deny") : "disabled" };
}

// ---- which ports matter ----

/** The ports an administrator and Freighter reach this server by. */
export async function essentialPorts(d: Deps): Promise<EssentialPort[]> {
  const out = new Map<number, string>();
  const ssh = await d.run("sshd", ["-T"], { timeoutMs: 10_000 }).catch(() => undefined);
  const ports = [...(ssh?.stdout ?? "").matchAll(/^port (\d+)$/gm)].map((m) => Number(m[1]));
  for (const p of ports.length ? ports : [22]) out.set(p, "SSH");
  out.set(d.config.haproxy.httpPort, "HTTP (certificates and redirects)");
  out.set(d.config.haproxy.httpsPort, "HTTPS (apps)");
  if (d.config.agent.remote.enabled && d.config.agent.remote.port > 0) out.set(d.config.agent.remote.port, "the Freighter agent (the dashboard manages this server through it)");
  return [...out].map(([port, what]) => ({ port, what }));
}

/** Ports and protocol of a rule's `To` column; null means every port. */
function portsOf(to: string): { ranges: [number, number][]; proto: string | null } | null {
  const t = to.replace(/\s*\(v6\)\s*$/, "").trim();
  if (!/^[\d:,]+(\/\w+)?$/.test(t)) return null;
  const [ports, proto] = t.split("/");
  return { ranges: ports!.split(",").map((r) => (r.includes(":") ? (r.split(":").map(Number) as [number, number]) : ([Number(r), Number(r)] as [number, number]))), proto: proto ?? null };
}
/** Whether a rule's `To` covers a TCP port. */
export function covers(to: string, port: number): boolean {
  if (/^Anywhere/i.test(to.trim())) return true;
  const p = portsOf(to);
  if (!p) return false;
  return (p.proto === null || p.proto === "tcp") && p.ranges.some(([a, b]) => port >= a && port <= b);
}
const fromAnywhere = (from: string) => /^Anywhere\b/i.test(from.trim());

/** The essential ports that no allowing rule from anywhere covers. (The IPv6 twin of a rule doesn't open anything for IPv4.) */
export function unprotected(rules: FirewallRule[], essential: EssentialPort[]): EssentialPort[] {
  return essential.filter((e) => !rules.some((r) => !r.v6 && r.action === "allow" && r.direction === "in" && fromAnywhere(r.from) && covers(r.to, e.port)));
}

// ---- status ----

async function ufw(d: Deps, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  const r = await d.run("ufw", args, { timeoutMs }).catch((e: NodeJS.ErrnoException) => {
    throw new FirewallError(e.code === "ENOENT" ? "unavailable" : "bad_request", e.code === "ENOENT" ? NO_FIREWALL : `ufw: ${e.message}`);
  });
  if (r.code !== 0) {
    const line = `${r.stderr ?? ""}\n${r.stdout}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? `exit code ${r.code}`;
    throw new FirewallError("bad_request", `ufw ${args[0] === "--force" ? args[1] : args[0]}: ${line.replace(/^ERROR:\s*/, "")}`);
  }
  return { stdout: r.stdout, stderr: r.stderr ?? "" };
}

export const NO_FIREWALL = "ufw is not installed on this server: add the firewall from the Servers page (or install ufw)";

export async function firewallInstalled(d: Deps): Promise<boolean> {
  return (await d.run("sh", ["-c", "command -v ufw"]).catch(() => ({ code: 1 }))).code === 0;
}

export async function firewallStatus(d: Deps): Promise<FirewallStatus> {
  const essential = await essentialPorts(d);
  if (!(await firewallInstalled(d))) return { installed: false, active: false, defaults: null, logging: null, rules: [], essential };
  const verbose = parseVerbose((await ufw(d, ["status", "verbose"])).stdout);
  const rules = verbose.active ? parseRules((await ufw(d, ["status", "numbered"])).stdout) : [];
  const defaults = verbose.defaults ?? parseDefaults(await readFile("/etc/default/ufw", "utf8").catch(() => ""));
  return { installed: true, active: verbose.active, defaults, logging: verbose.logging, rules, essential };
}

// ---- changing it ----

export interface RuleInput {
  action: Action;
  direction?: "in" | "out";
  proto?: "tcp" | "udp" | "any";
  /** `80`, `6000:6007`, `80,443`. Empty: every port. */
  port?: string;
  /** An address or network the traffic comes from; empty or `any`: anywhere. */
  from?: string;
  /** An address of this machine the traffic goes to; empty or `any`: any. */
  to?: string;
  comment?: string;
}

const PORT_RE = /^\d{1,5}(:\d{1,5})?(,\d{1,5}(:\d{1,5})?)*$/;
function validPort(p: string): boolean {
  if (!PORT_RE.test(p)) return false;
  const nums = p.split(/[:,]/).map(Number);
  if (nums.some((n) => n < 1 || n > 65535)) return false;
  return p.split(",").every((r) => !r.includes(":") || Number(r.split(":")[0]) <= Number(r.split(":")[1]));
}
function validAddress(a: string): boolean {
  const [ip, prefix, ...rest] = a.split("/");
  if (rest.length || !ip || isIP(ip) === 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (isIP(ip) === 4 ? 32 : 128);
}

/** The arguments of `ufw` for a rule, checked: nothing here is passed through a shell. */
export function ruleArgs(r: RuleInput, position?: number): string[] {
  if (!["allow", "deny", "reject", "limit"].includes(r.action)) throw new FirewallError("bad_request", "the action is allow, deny, reject or limit");
  const proto = r.proto ?? "any";
  if (!["tcp", "udp", "any"].includes(proto)) throw new FirewallError("bad_request", "the protocol is tcp, udp or any");
  const port = (r.port ?? "").trim();
  if (port && !validPort(port)) throw new FirewallError("bad_request", `${port}: not a port (use 80, 6000:6007 or 80,443)`);
  if (port.includes(",") || port.includes(":")) {
    if (proto === "any") throw new FirewallError("bad_request", "a range or a list of ports needs tcp or udp");
  }
  const from = (r.from ?? "").trim() || "any";
  const to = (r.to ?? "").trim() || "any";
  for (const [what, a] of [["from", from], ["to", to]] as const) if (a !== "any" && !validAddress(a)) throw new FirewallError("bad_request", `${a}: not an IP address or network (${what})`);
  if (r.action === "limit" && proto === "udp") throw new FirewallError("bad_request", "limit works on tcp only");
  const comment = (r.comment ?? "").trim();
  if (comment && !/^[\w .,:/@+()#=&-]{1,80}$/.test(comment)) throw new FirewallError("bad_request", "the comment is up to 80 letters, digits and . , : / @ + ( ) - _");
  return [
    ...(position ? ["insert", String(position)] : []),
    r.action,
    r.direction ?? "in",
    ...(proto !== "any" ? ["proto", proto] : []),
    "from",
    from,
    "to",
    to,
    ...(port ? ["port", port] : []),
    ...(comment ? ["comment", comment] : []),
  ];
}

/** Whether a rule would shut an essential port to the world. */
function blocksEssential(r: RuleInput, essential: EssentialPort[]): EssentialPort[] {
  if (r.action === "allow" || (r.direction ?? "in") !== "in") return [];
  if ((r.from ?? "").trim() && (r.from ?? "").trim() !== "any") return [];
  if (r.proto === "udp") return [];
  const port = (r.port ?? "").trim();
  if (!port) return essential;
  return essential.filter((e) => port.split(",").some((rng) => (rng.includes(":") ? e.port >= Number(rng.split(":")[0]) && e.port <= Number(rng.split(":")[1]) : Number(rng) === e.port)));
}

const lockout = (what: EssentialPort[], doing: string) =>
  new FirewallError("conflict", `${doing} would cut off ${what.map((e) => `${e.what} (port ${e.port})`).join(", ")}, which Freighter or you reach this server by. Confirm to do it anyway.`);

export async function addRule(d: Deps, input: RuleInput, opts: { position?: number; acknowledged?: boolean } = {}): Promise<FirewallStatus> {
  const args = ruleArgs(input, opts.position);
  const st = await firewallStatus(d);
  if (!st.installed) throw new FirewallError("unavailable", NO_FIREWALL);
  if (!st.active) throw new FirewallError("conflict", "turn the firewall on first: rules are managed while it is on");
  const cut = blocksEssential(input, st.essential);
  if (cut.length && !opts.acknowledged) throw lockout(cut, "that rule");
  await ufw(d, args);
  return firewallStatus(d);
}

/** A rule's identity apart from its number, which moves. */
export const signature = (r: Pick<FirewallRule, "to" | "action" | "direction" | "from">) => [r.to, r.action, r.direction, r.from].map((x) => x.replace(/\s+/g, " ").trim()).join("|");

/** The IPv6 twin ufw made of an IPv4 rule that names no address: the same rule, with `(v6)` on both sides. */
const twinOf = (rule: FirewallRule, rules: FirewallRule[]) =>
  rule.v6 ? undefined : rules.find((r) => r.v6 && r.action === rule.action && r.direction === rule.direction && r.comment === rule.comment && r.to.replace(/\s*\(v6\)$/, "") === rule.to && r.from.replace(/\s*\(v6\)$/, "") === rule.from);

/** `twin`: remove the IPv6 twin of the rule as well (they were made together, so they go together). */
export async function deleteRule(d: Deps, number: number, expected: string, opts: { acknowledged?: boolean; twin?: boolean } = {}): Promise<FirewallStatus> {
  const st = await firewallStatus(d);
  if (!st.installed) throw new FirewallError("unavailable", NO_FIREWALL);
  const rule = st.rules.find((r) => r.number === number);
  if (!rule || signature(rule) !== expected) throw new FirewallError("conflict", "the rules changed since they were listed; refresh and try again");
  if (!opts.acknowledged) {
    const left = st.rules.filter((r) => r.number !== number);
    const cut = unprotected(left, st.essential).filter((e) => !unprotected(st.rules, st.essential).some((u) => u.port === e.port));
    if (cut.length) throw lockout(cut, "removing this rule");
  }
  const numbers = [number, ...(opts.twin ? [twinOf(rule, st.rules)?.number] : [])].filter((n): n is number => n !== undefined).sort((a, b) => b - a); // the higher one first: removing a rule renumbers the ones after it
  for (const n of numbers) await ufw(d, ["--force", "delete", String(n)]);
  return firewallStatus(d);
}

/** Turn the firewall on, after allowing what keeps the server reachable (and anything else asked for). */
export async function enableFirewall(d: Deps, open: number[] = []): Promise<FirewallStatus> {
  const st = await firewallStatus(d);
  if (!st.installed) throw new FirewallError("unavailable", NO_FIREWALL);
  if (st.active) return st;
  for (const e of st.essential) await ufw(d, ["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", String(e.port), "comment", `freighter: ${e.what}`.slice(0, 80).replace(/[^\w .,:/@+()#=&-]/g, "")]);
  for (const p of open) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new FirewallError("bad_request", `${p}: not a port`);
    await ufw(d, ["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", String(p)]);
  }
  await ufw(d, ["--force", "enable"]);
  return firewallStatus(d);
}

export async function disableFirewall(d: Deps): Promise<FirewallStatus> {
  await ufw(d, ["disable"]);
  return firewallStatus(d);
}

export async function setDefaultPolicy(d: Deps, direction: "incoming" | "outgoing", policy: Policy, opts: { acknowledged?: boolean } = {}): Promise<FirewallStatus> {
  if (!["incoming", "outgoing"].includes(direction) || !["allow", "deny", "reject"].includes(policy)) throw new FirewallError("bad_request", "invalid policy");
  const st = await firewallStatus(d);
  if (!st.installed) throw new FirewallError("unavailable", NO_FIREWALL);
  if (st.active && direction === "incoming" && policy !== "allow" && !opts.acknowledged) {
    const open = unprotected(st.rules, st.essential);
    if (open.length) throw lockout(open, `denying incoming traffic by default`);
  }
  await ufw(d, ["default", policy, direction]);
  return firewallStatus(d);
}
