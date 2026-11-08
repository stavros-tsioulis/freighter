// The settings people change from the dashboard, described once (no I/O here: the API and the agent both use it).
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
  { key: "acme.challenge", section: "Certificates", label: "How to prove domain ownership", help: "“HTTP” answers Let's Encrypt on port 80, which needs the hostname to reach this server. “Cloudflare DNS” uses the Cloudflare API instead, so it works behind Cloudflare's proxy; it needs a token in the credentials file (see the domains guide).", type: "enum", scope: "agent", restart: "agent", options: ["http", "cloudflare-dns"] },
  { key: "acme.renewBeforeDays", section: "Certificates", label: "Renew certificates", help: "Renew when this many days or fewer remain.", type: "number", scope: "agent", restart: "agent", min: 1, max: 89, unit: "days before expiry" },
  { key: "acme.challengePort", section: "Certificates", label: "Challenge port", help: "The local port certbot listens on during the HTTP-01 challenge. HAProxy forwards to it.", type: "number", scope: "agent", restart: "agent", min: 1, max: 65535 },

  { key: "haproxy.httpPort", section: "Web traffic", label: "HTTP port", help: "The port HAProxy listens on for HTTP. Let's Encrypt still needs public port 80 to reach it.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.httpsPort", section: "Web traffic", label: "HTTPS port", help: "The port HAProxy listens on for HTTPS.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.publicHttpsPort", section: "Web traffic", label: "Public HTTPS port", help: "The port visitors are redirected to. Set 443 when your own proxy maps 443 to the HTTPS port above. Empty: same as the HTTPS port.", type: "number", scope: "agent", restart: "none", min: 1, max: 65535, haproxy: true },
  { key: "haproxy.acceptProxy", section: "Web traffic", label: "Expect the PROXY protocol", help: "Turn on when a TCP proxy in front of HAProxy sends the PROXY protocol, to keep real client addresses.", type: "boolean", scope: "agent", restart: "none", haproxy: true },

  { key: "haproxy.trustCloudflare", section: "Web traffic", label: "Behind Cloudflare's proxy", help: "Turn on when domains are proxied (orange cloud): the visitor's real address is read from Cloudflare's CF-Connecting-IP header, only for connections from Cloudflare.", type: "boolean", scope: "agent", restart: "none", haproxy: true },

  { key: "ports.min", section: "Deploys", label: "First service port", help: "Services that are routed to a domain get a port from this range. Keep it clear of other software.", type: "number", scope: "agent", restart: "agent", min: 1024, max: 65535 },
  { key: "ports.max", section: "Deploys", label: "Last service port", help: "The top of that range.", type: "number", scope: "agent", restart: "agent", min: 1024, max: 65535 },
  { key: "drainSeconds", section: "Deploys", label: "Drain time", help: "How long the old release keeps running after traffic moves, so requests in flight can finish.", type: "number", scope: "agent", restart: "agent", min: 0, max: 600, unit: "seconds" },
  { key: "agent.maxArtifactMb", section: "Deploys", label: "Largest upload this server accepts", help: "Bigger archives are refused before they are stored.", type: "number", scope: "agent", restart: "agent", min: 1, max: 10000, unit: "MB" },
  { key: "git.knownHosts", section: "Deploys", label: "Unknown Git hosts", help: "What to do the first time a Git host's SSH key is seen. “Trust on first use” records it; “Refuse” only allows hosts already known.", type: "enum", scope: "agent", restart: "agent", options: ["accept-new", "yes"] },

  { key: "api.publicUrl", section: "Dashboard & API", label: "Public URL", help: "The address people use to reach this dashboard. Used to build webhook and server enrollment URLs.", type: "string", scope: "control", restart: "none", placeholder: "https://freighter.example.com" },
  { key: "api.publicIps", section: "Dashboard & API", label: "Public IP addresses", help: "This server's public addresses, shown as the DNS target when adding domains.", type: "list", scope: "control", restart: "none", placeholder: "203.0.113.7" },
  { key: "api.dnsServers", section: "Dashboard & API", label: "DNS servers for checks", help: "Used to verify that a domain points here. Public resolvers avoid stale local caches. Empty: use the system resolver.", type: "list", scope: "control", restart: "none", placeholder: "1.1.1.1" },
  { key: "api.trustProxy", section: "Dashboard & API", label: "Trust X-Forwarded-For", help: "Believe the client address a proxy in front of the API reports. Keep on behind HAProxy or your own proxy.", type: "boolean", scope: "control", restart: "none" },
  { key: "api.maxUploadMb", section: "Dashboard & API", label: "Largest upload", help: "The biggest archive the dashboard and API accept.", type: "number", scope: "control", restart: "none", min: 1, max: 10000, unit: "MB" },
  { key: "api.syncSeconds", section: "Dashboard & API", label: "Refresh app state every", help: "How often app state is re-read from every server. 0 turns it off.", type: "number", scope: "control", restart: "none", min: 0, max: 3600, unit: "seconds" },
  { key: "api.metricsSeconds", section: "Dashboard & API", label: "Sample metrics every", help: "How often CPU and memory are sampled for the charts. 0 turns it off.", type: "number", scope: "control", restart: "none", min: 0, max: 3600, unit: "seconds" },
  { key: "api.metricsRetentionHours", section: "Dashboard & API", label: "Keep metrics for", help: "How long samples are kept.", type: "number", scope: "control", restart: "none", min: 1, max: 720, unit: "hours" },
];


export interface FieldState extends FieldDef {
  /** What is in effect (the file's value, or the default). */
  value: unknown;
  /** What it would be with no entry in the file. */
  default: unknown;
  /** Whether the file sets it. */
  explicit: boolean;
  /** Where the value in effect comes from (control-plane settings only). */
  source?: "env" | "dashboard" | "file" | "default";
  /** The environment variable that sets it, when one does: then it can't be changed from the dashboard. */
  envVar?: string;
}


export class SettingsError extends Error {}

export function checkType(f: FieldDef, v: unknown): unknown {
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


export const getPath = (obj: unknown, key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);


export const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
