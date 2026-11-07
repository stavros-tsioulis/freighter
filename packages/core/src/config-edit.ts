import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMap, isScalar, parseDocument, type Document } from "yaml";
import { renderMainConfig } from "@freighter/haproxy";
import type { Deps } from "./deps.ts";
import { hostConfigSchema, parseHostConfig, type HostConfig } from "./config.ts";

/**
 * The settings people actually change, described once: the settings UI renders its form from this list, and the same
 * list decides what a change may touch. Paths, sockets and the agent's TLS settings are deliberately not here: they are
 * set up by the installer and enrollment, and a typo in them can lock you out. Edit config.yaml by hand for those.
 */
export type FieldType = "string" | "number" | "boolean" | "list" | "enum";
/** What has to happen before a change takes effect. */
export type Restart = "none" | "agent" | "api";

export interface FieldDef {
  key: string;
  section: string;
  label: string;
  help: string;
  type: FieldType;
  /** `agent`: every server has it. `control`: only the control server (it runs the API). */
  scope: "agent" | "control";
  restart: Restart;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  /** Changing it rewrites the listener lines of a Freighter-managed HAProxy config. */
  haproxy?: boolean;
}

export const FIELDS: FieldDef[] = [
  { key: "acme.email", section: "Certificates", label: "Let's Encrypt email", help: "Where Let's Encrypt sends expiry notices. Required before any domain can use automatic HTTPS.", type: "string", scope: "agent", restart: "agent", placeholder: "ops@example.com" },
  { key: "acme.staging", section: "Certificates", label: "Use Let's Encrypt staging", help: "Issue untrusted test certificates with generous rate limits. Turn off for real traffic.", type: "boolean", scope: "agent", restart: "agent" },
  { key: "acme.renewBeforeDays", section: "Certificates", label: "Renew certificates", help: "Renew when this many days or fewer remain.", type: "number", scope: "agent", restart: "agent", min: 1, max: 89, unit: "days before expiry" },
  { key: "acme.challengePort", section: "Certificates", label: "Challenge port", help: "The local port certbot listens on during the HTTP-01 challenge. HAProxy forwards to it.", type: "number", scope: "agent", restart: "agent", min: 1, max: 65535 },

  { key: "haproxy.httpPort", section: "Web traffic", label: "HTTP port", help: "The port HAProxy listens on for HTTP. Let's Encrypt still needs public port 80 to reach it.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.httpsPort", section: "Web traffic", label: "HTTPS port", help: "The port HAProxy listens on for HTTPS.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.publicHttpsPort", section: "Web traffic", label: "Public HTTPS port", help: "The port visitors are redirected to. Set 443 when your own proxy maps 443 to the HTTPS port above. Empty: same as the HTTPS port.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.acceptProxy", section: "Web traffic", label: "Expect the PROXY protocol", help: "Turn on when a TCP proxy in front of HAProxy sends the PROXY protocol, to keep real client addresses.", type: "boolean", scope: "agent", restart: "none", haproxy: true },

  { key: "ports.min", section: "Deploys", label: "First service port", help: "Services that are routed to a domain get a port from this range. Keep it clear of other software.", type: "number", scope: "agent", restart: "agent", min: 1024, max: 65535 },
  { key: "ports.max", section: "Deploys", label: "Last service port", help: "The top of that range.", type: "number", scope: "agent", restart: "agent", min: 1024, max: 65535 },
  { key: "drainSeconds", section: "Deploys", label: "Drain time", help: "How long the old release keeps running after traffic moves, so requests in flight can finish.", type: "number", scope: "agent", restart: "agent", min: 0, max: 600, unit: "seconds" },
  { key: "agent.maxArtifactMb", section: "Deploys", label: "Largest upload this server accepts", help: "Bigger archives are refused before they are stored.", type: "number", scope: "agent", restart: "agent", min: 1, max: 10000, unit: "MB" },
  { key: "git.knownHosts", section: "Deploys", label: "Unknown Git hosts", help: "What to do the first time a Git host's SSH key is seen. “Trust on first use” records it; “Refuse” only allows hosts already known.", type: "enum", scope: "agent", restart: "agent", options: ["accept-new", "yes"] },

  { key: "api.publicUrl", section: "Dashboard & API", label: "Public URL", help: "The address people use to reach this dashboard. Used to build webhook and server enrollment URLs.", type: "string", scope: "control", restart: "api", placeholder: "https://freighter.example.com" },
  { key: "api.publicIps", section: "Dashboard & API", label: "Public IP addresses", help: "This server's public addresses, shown as the DNS target when adding domains.", type: "list", scope: "control", restart: "api", placeholder: "203.0.113.7" },
  { key: "api.dnsServers", section: "Dashboard & API", label: "DNS servers for checks", help: "Used to verify that a domain points here. Public resolvers avoid stale local caches. Empty: use the system resolver.", type: "list", scope: "control", restart: "api", placeholder: "1.1.1.1" },
  { key: "api.trustProxy", section: "Dashboard & API", label: "Trust X-Forwarded-For", help: "Believe the client address a proxy in front of the API reports. Keep on behind HAProxy or your own proxy.", type: "boolean", scope: "control", restart: "api" },
  { key: "api.maxUploadMb", section: "Dashboard & API", label: "Largest upload", help: "The biggest archive the dashboard and API accept.", type: "number", scope: "control", restart: "api", min: 1, max: 10000, unit: "MB" },
  { key: "api.syncSeconds", section: "Dashboard & API", label: "Refresh app state every", help: "How often app state is re-read from every server. 0 turns it off.", type: "number", scope: "control", restart: "api", min: 0, max: 3600, unit: "seconds" },
  { key: "api.metricsSeconds", section: "Dashboard & API", label: "Sample metrics every", help: "How often CPU and memory are sampled for the charts. 0 turns it off.", type: "number", scope: "control", restart: "api", min: 0, max: 3600, unit: "seconds" },
  { key: "api.metricsRetentionHours", section: "Dashboard & API", label: "Keep metrics for", help: "How long samples are kept.", type: "number", scope: "control", restart: "api", min: 1, max: 720, unit: "hours" },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export interface FieldState extends FieldDef {
  /** What is in effect (the file's value, or the default). */
  value: unknown;
  /** What it would be with no entry in the file. */
  default: unknown;
  /** Whether the file sets it. */
  explicit: boolean;
}

const getPath = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** The editable settings with their current values, read fresh from disk (not from what this process started with). */
export async function readSettings(path: string): Promise<FieldState[]> {
  const doc = parseDocument(await readText(path));
  const raw = (doc.toJS() ?? {}) as unknown;
  const effective = parseHostConfig(raw);
  const defaults = parseHostConfig({});
  return FIELDS.map((f) => {
    const explicit = getPath(raw, f.key) !== undefined && getPath(raw, f.key) !== null;
    return { ...f, value: getPath(effective, f.key) ?? null, default: getPath(defaults, f.key) ?? null, explicit };
  });
}

export class SettingsError extends Error {}

function checkType(f: FieldDef, v: unknown): unknown {
  const bad = (what: string) => new SettingsError(`${f.label}: ${what}`);
  switch (f.type) {
    case "string": {
      if (typeof v !== "string") throw bad("must be text");
      return v.trim();
    }
    case "boolean": {
      if (typeof v !== "boolean") throw bad("must be on or off");
      return v;
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad("must be a number");
      if (f.min !== undefined && v < f.min) throw bad(`must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) throw bad(`must be at most ${f.max}`);
      return v;
    }
    case "list": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad("must be a list");
      return (v as string[]).map((x) => x.trim()).filter(Boolean);
    }
    case "enum": {
      if (typeof v !== "string" || !f.options?.includes(v)) throw bad(`must be one of ${f.options?.join(", ")}`);
      return v;
    }
  }
}

/** Drop maps that a removed key left empty, so resetting a setting leaves no `acme: {}` behind. */
function prune(doc: Document, path: string[]) {
  for (let n = path.length - 1; n > 0; n--) {
    const parent = path.slice(0, n);
    const node = doc.getIn(parent, true);
    if (isMap(node) && node.items.length === 0) doc.deleteIn(parent);
    else break;
  }
}

export interface ApplyResult {
  /** Keys whose value actually changed. */
  changed: string[];
  /** What must be restarted for the changes to take effect. */
  restart: ("agent" | "api")[];
  /** Changed settings that rewrite the listener lines of a Freighter-managed HAProxy config. */
  haproxyChanged: boolean;
  /** The config as it is after the change. */
  config: HostConfig;
}

/**
 * Apply `changes` (key -> new value, or null to remove the entry and fall back to the default) to the file at `path`.
 * The result is validated as a whole before anything is written, comments and unrelated keys in the file are kept, and
 * the previous file is saved next to it as `.bak`.
 */
export async function applySettings(path: string, changes: Record<string, unknown>, opts: { allow?: (f: FieldDef) => boolean } = {}): Promise<ApplyResult> {
  const doc = parseDocument(await readText(path));
  if (doc.errors.length) throw new SettingsError(`config.yaml is not valid YAML (${doc.errors[0]!.message}); fix it by hand first`);
  if (doc.contents !== null && !isMap(doc.contents) && !(isScalar(doc.contents) && doc.contents.value === null)) throw new SettingsError("config.yaml must be a mapping");
  const before = parseHostConfig((doc.toJS() ?? {}) as unknown);

  for (const [key, value] of Object.entries(changes)) {
    const f = BY_KEY.get(key);
    if (!f) throw new SettingsError(`"${key}" is not a setting that can be changed here`);
    if (opts.allow && !opts.allow(f)) throw new SettingsError(`${f.label} is not available on this server`);
    const path = key.split(".");
    if (value === null || (f.type === "string" && value === "")) {
      doc.deleteIn(path);
      prune(doc, path);
    } else {
      doc.setIn(path, checkType(f, value));
    }
  }

  let config: HostConfig;
  try {
    config = hostConfigSchema.parse(doc.toJS() ?? {});
  } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    throw new SettingsError(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid configuration");
  }
  if (config.haproxy.httpPort === config.haproxy.httpsPort) throw new SettingsError("The HTTP and HTTPS ports must be different.");

  const changed = FIELDS.filter((f) => JSON.stringify(getPath(before, f.key) ?? null) !== JSON.stringify(getPath(config, f.key) ?? null)).map((f) => f.key);
  const touched = changed.map((k) => BY_KEY.get(k)!);
  if (changed.length) {
    await mkdir(dirname(path), { recursive: true });
    const old = await readText(path);
    if (old) await copyFile(path, `${path}.bak`).catch(() => {});
    const tmp = `${path}.tmp`;
    await writeFile(tmp, doc.toString(), { mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, path);
  }
  const restart = (["agent", "api"] as const).filter((r) => touched.some((f) => f.restart === r));
  return { changed, restart, haproxyChanged: touched.some((f) => f.haproxy), config };
}

const MANAGED_MARK = "# Managed by freighter";

/**
 * Bring a Freighter-generated haproxy.cfg (the "dedicated" setup) in line with new listener settings: render, validate
 * the whole config, swap it in, reload. A haproxy.cfg you wrote yourself is never touched: "manual" means its ports
 * have to be changed by hand.
 */
export async function applyHaproxyListeners(d: Deps, config: HostConfig): Promise<"applied" | "manual"> {
  const main = d.config.haproxy.mainConfig;
  const current = await readText(main);
  if (!current.startsWith(MANAGED_MARK)) return "manual";
  const next = renderMainConfig({ ...config.haproxy });
  if (next === current) return "applied";
  const staged = `${main}.new`;
  await writeFile(staged, next);
  const check = await d.run(d.config.haproxy.bin, ["-c", "-f", staged, "-f", `${d.config.haproxy.dir}/backends.cfg`]);
  if (check.code !== 0) {
    await rm(staged, { force: true });
    throw new SettingsError(`HAProxy rejected the new ports, nothing was changed: ${(check.stderr ?? check.stdout).trim().split("\n").slice(-2).join(" | ")}`);
  }
  await rename(staged, main);
  await d.haproxy.reload();
  return "applied";
}
