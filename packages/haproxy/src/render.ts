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

export function renderBackends(routes: Route[], opts: { acmePort: number }): string {
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
  return out;
}

/** The one-time lines the user adds to their existing HAProxy configuration. */
export function renderSnippet(o: { dir: string }): string {
  const host = "req.hdr(host),field(1,:),lower";
  const route = `use_backend %[${host},map(${o.dir}/hostnames.map)] if { ${host},map(${o.dir}/hostnames.map) -m found }`;
  return `# ---- Freighter: one-time additions to your HAProxy configuration (HAProxy >= 2.4) ----
#
# 1. Load the generated backends as an additional config file. Add
#        -f ${o.dir}/backends.cfg
#    to the haproxy command line (systemd drop-in) or put it in the config directory your service loads.
#
# 2. In the frontend listening on :80, before your other rules:
    acl freighter_acme path_beg /.well-known/acme-challenge/
    use_backend freighter_acme if freighter_acme
    http-request redirect scheme https code 301 if !{ ssl_fc } !freighter_acme { ${host},map(${o.dir}/https.map) -m found }
    ${route}
#
# 3. In the frontend listening on :443 (the certs directory must contain at least one PEM,
#    e.g. a self-signed placeholder, or HAProxy will refuse to start):
    bind :443 ssl crt ${o.dir}/certs/
    ${route}
`;
}
