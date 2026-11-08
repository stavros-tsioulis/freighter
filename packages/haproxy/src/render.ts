import { CLOUDFLARE_RANGES } from "./cloudflare.ts";

export interface Route {
  app: string;
  service: string;
  hostname: string;
  tls: "auto" | "off";
  port: number;
  healthPath?: string;
}

export const backendName = (r: Pick<Route, "app" | "service">) => `be_${r.app}_${r.service}`;

const HEADER = "# Managed by freighter. Do not edit; regenerated on every deploy.\n";

const byHost = (a: Route, b: Route) => a.hostname.localeCompare(b.hostname);

/** hostname -> backend name (used with `map()` in the frontend). */
export function renderHostnameMap(routes: Route[]): string {
  return HEADER + [...routes].sort(byHost).map((r) => `${r.hostname} ${backendName(r)}\n`).join("");
}

/** Hostnames that must be redirected from HTTP to HTTPS. */
export function renderHttpsMap(routes: Route[]): string {
  return HEADER + [...routes].filter((r) => r.tls === "auto").sort(byHost).map((r) => `${r.hostname} 1\n`).join("");
}

export function renderBackends(routes: Route[], opts: { acmePort: number; challengeToken: string }): string {
  const groups = new Map<string, Route>();
  for (const r of routes) {
    const name = backendName(r);
    const seen = groups.get(name);
    if (seen && seen.port !== r.port) throw new Error(`backend ${name} has conflicting ports ${seen.port} and ${r.port}`);
    groups.set(name, seen ?? r);
  }
  let out = HEADER;
  for (const name of [...groups.keys()].sort()) {
    const r = groups.get(name)!;
    out += `\nbackend ${name}\n`;
    out += "    option forwardfor\n";
    out += "    http-request set-header X-Forwarded-Proto https if { ssl_fc }\n";
    if (r.healthPath) {
      out += "    option httpchk\n";
      out += `    http-check send meth GET uri ${r.healthPath}\n`;
      out += "    http-check expect rstatus 2[0-9][0-9]\n";
      out += `    server app 127.0.0.1:${r.port} check inter 5s fall 3 rise 2\n`;
    } else {
      out += `    server app 127.0.0.1:${r.port}\n`;
    }
  }
  out += `\nbackend freighter_acme\n    server certbot 127.0.0.1:${opts.acmePort}\n`;
  out += `\nbackend freighter_challenge\n    http-request return status 200 content-type text/plain string "${opts.challengeToken}"\n`;
  return out;
}

/** Where HAProxy listens, and what the outside world sees. Defaults: the standard ports, nothing in front. */
export interface ListenOptions {
  httpPort?: number;
  httpsPort?: number;
  /** HTTPS port clients are redirected to. Defaults to `httpsPort`; set it (e.g. 443) when your own proxy sits in front and maps ports. */
  publicHttpsPort?: number;
  /** Expect the PROXY protocol on both listeners (nginx `stream` with `proxy_protocol on`, another HAProxy with `send-proxy`). */
  acceptProxy?: boolean;
  /** Cloudflare's proxy is in front: take the visitor's address from `CF-Connecting-IP`, but only on connections from Cloudflare's ranges. */
  trustCloudflare?: boolean;
}

const hostExpr = "req.hdr(host),field(1,:),lower";
const routeLine = (dir: string) =>
  `use_backend %[${hostExpr},map(${dir}/hostnames.map)] if { ${hostExpr},map(${dir}/hostnames.map) -m found }`;

function resolve(o: ListenOptions) {
  const httpPort = o.httpPort ?? 80;
  const httpsPort = o.httpsPort ?? 443;
  const publicHttpsPort = o.publicHttpsPort ?? httpsPort;
  const proxy = o.acceptProxy ? " accept-proxy" : "";
  // `redirect scheme https` keeps the default port; any other public port has to be spelled out.
  const redirect =
    publicHttpsPort === 443
      ? "http-request redirect scheme https code 301"
      : `http-request redirect location https://%[req.hdr(host),field(1,:)]:${publicHttpsPort}%[pathq] code 301`;
  return { httpPort, httpsPort, proxy, redirect };
}

/** Real client address behind Cloudflare. Only connections from Cloudflare's ranges may set it, so it can't be spoofed. */
function cloudflareRules(o: ListenOptions): string {
  if (!o.trustCloudflare) return "";
  return `    acl freighter_cloudflare src ${CLOUDFLARE_RANGES.join(" ")}
    http-request set-src req.hdr(CF-Connecting-IP) if freighter_cloudflare { req.hdr(CF-Connecting-IP) -m found }
`;
}

/** Answers the control plane's domain check (see ensureChallengeToken). Needed on both listeners: Cloudflare may reach us over either. */
const challengeRule = "use_backend freighter_challenge if { path_beg /.well-known/freighter-challenge }";

function httpRules(dir: string, redirect: string, o: ListenOptions): string {
  return `${cloudflareRules(o)}    acl freighter_acme path_beg /.well-known/acme-challenge/
    ${redirect} if !{ ssl_fc } !freighter_acme { ${hostExpr},map(${dir}/https.map) -m found }
    use_backend freighter_acme if freighter_acme
    ${challengeRule}
    ${routeLine(dir)}`;
}

function httpsRules(dir: string, o: ListenOptions): string {
  return `${cloudflareRules(o)}    ${challengeRule}
    ${routeLine(dir)}`;
}

/**
 * What someone running their own HAProxy has to add after an upgrade: Freighter never edits that file, and newer
 * versions answer the domain check (and, behind Cloudflare, read the visitor's address) through rules in the frontends.
 * Adding a rule that is already there is harmless to read but HAProxy rejects a duplicate `acl`, so say what to look for.
 */
export function renderUpgradeNotes(o: { dir: string; mainConfig?: string } & ListenOptions): string {
  const { httpPort, httpsPort } = resolve(o);
  const cf = o.trustCloudflare ? cloudflareRules(o) : "";
  return `# Freighter does not edit your haproxy.cfg, so these lines are yours to add (skip any you already have):
#
# In the frontend listening on :${httpPort} and in the one listening on :${httpsPort}, before your other rules:
${cf}    ${challengeRule}
#
# The rule sends /.well-known/freighter-challenge to the freighter_challenge backend, which Freighter keeps in
# ${o.dir}/backends.cfg (HAProxy already loads that file). It lets the dashboard verify domains that sit behind
# Cloudflare's proxy, where DNS records can't show where they point.
#
# Then check and reload:
#     haproxy -c -f ${o.mainConfig ?? "/etc/haproxy/haproxy.cfg"} -f ${o.dir}/backends.cfg && systemctl reload haproxy
`;
}

/** The one-time lines the user adds to their existing HAProxy configuration. */
export function renderSnippet(o: { dir: string; mainConfig?: string } & ListenOptions): string {
  const { httpPort, httpsPort, proxy, redirect } = resolve(o);
  return `# ---- Freighter: one-time additions to your HAProxy configuration (HAProxy >= 2.4) ----
#
# 1. Make HAProxy read Freighter's generated backends, in addition to your own haproxy.cfg.
#    Freighter keeps them in ${o.dir}/backends.cfg and rewrites that file on every deploy.
#    The lines in 2 and 3 below refer to those backends, so HAProxy fails to start without them.
#
#    Debian / Ubuntu: put this line in /etc/default/haproxy, then restart HAProxy:
#        EXTRAOPTS="-f ${o.dir}/backends.cfg"
#      (if the file already has an EXTRAOPTS line, add the -f option inside it)
#    Elsewhere: add  -f ${o.dir}/backends.cfg  to the haproxy command in its service file
#      (systemctl edit haproxy), next to the existing -f option.
#    Then check the result:
#        haproxy -c -f ${o.mainConfig ?? "/etc/haproxy/haproxy.cfg"} -f ${o.dir}/backends.cfg
#
# 2. In the frontend listening on :${httpPort}, before your other rules:
${httpRules(o.dir, redirect, o)}
#
# 3. In the frontend listening on :${httpsPort} (the certs directory must contain at least one PEM,
#    e.g. a self-signed placeholder, or HAProxy will refuse to start):
    bind :${httpsPort} ssl crt ${o.dir}/certs/${proxy}
${httpsRules(o.dir, o)}
`;
}

/**
 * A complete haproxy.cfg for a Freighter-only HAProxy (the "dedicated" setup), for servers that run no HAProxy of their
 * own. Load it together with `<dir>/backends.cfg`.
 */
export function renderMainConfig(o: { dir: string } & ListenOptions): string {
  const { httpPort, httpsPort, proxy, redirect } = resolve(o);
  return `# Managed by freighter (\`freighter haproxy config\`). A dedicated HAProxy for Freighter's apps: it does not touch any other HAProxy on this host.
# Load with:  haproxy -f <this file> -f ${o.dir}/backends.cfg
global
    log /dev/log local0
    maxconn 2000
    user haproxy
    group haproxy
    ssl-default-bind-options ssl-min-ver TLSv1.2

defaults
    mode http
    log global
    timeout connect 5s
    timeout client  30s
    timeout server  30s

frontend freighter_http
    bind :${httpPort}${proxy}
${httpRules(o.dir, redirect, o)}

frontend freighter_https
    bind :${httpsPort} ssl crt ${o.dir}/certs/${proxy}
${httpsRules(o.dir, o)}
`;
}
