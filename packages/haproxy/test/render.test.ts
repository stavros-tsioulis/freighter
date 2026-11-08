import { describe, expect, it } from "vitest";
import { renderBackends, renderHostnameMap, renderHttpsMap, renderMainConfig, renderSnippet, type Route } from "../src/index.ts";

const routes: Route[] = [
  { app: "shop", service: "web", hostname: "shop.example.com", tls: "auto", port: 20001, healthPath: "/health" },
  { app: "shop", service: "web", hostname: "www.shop.example.com", tls: "auto", port: 20001, healthPath: "/health" },
  { app: "blog", service: "web", hostname: "blog.example.com", tls: "off", port: 20002 },
];

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("render", () => {
  it("renders maps sorted by hostname", () => {
    expect(renderHostnameMap(routes)).toBe(
      "# Managed by freighter. Do not edit; regenerated on every deploy.\n" +
        "blog.example.com be_blog_web\nshop.example.com be_shop_web\nwww.shop.example.com be_shop_web\n",
    );
    expect(renderHttpsMap(routes)).toBe(
      "# Managed by freighter. Do not edit; regenerated on every deploy.\nshop.example.com 1\nwww.shop.example.com 1\n",
    );
  });

  it("renders one backend per service, with health checks only when configured", () => {
    expect(renderBackends(routes, { acmePort: 8888, challengeToken: TOKEN })).toBe(`# Managed by freighter. Do not edit; regenerated on every deploy.

backend be_blog_web
    option forwardfor
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    server app 127.0.0.1:20002

backend be_shop_web
    option forwardfor
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    option httpchk
    http-check send meth GET uri /health
    http-check expect rstatus 2[0-9][0-9]
    server app 127.0.0.1:20001 check inter 5s fall 3 rise 2

backend freighter_acme
    server certbot 127.0.0.1:8888

backend freighter_challenge
    http-request return status 200 content-type text/plain string "${TOKEN}"
`);
  });

  it("rejects one backend with two ports", () => {
    const bad = [routes[0]!, { ...routes[1]!, port: 20009 }];
    expect(() => renderBackends(bad, { acmePort: 8888, challengeToken: TOKEN })).toThrow(/conflicting ports/);
  });

  it("renders the one-time snippet with the managed dir", () => {
    const s = renderSnippet({ dir: "/etc/haproxy/freighter" });
    expect(s).toContain('EXTRAOPTS="-f /etc/haproxy/freighter/backends.cfg"');
    expect(s).toContain("haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg");
    expect(s).toContain("bind :443 ssl crt /etc/haproxy/freighter/certs/");
    expect(s).toContain("map(/etc/haproxy/freighter/hostnames.map)");
    expect(s).toContain("use_backend freighter_acme if freighter_acme");
  });

  it("uses custom ports, a spelled-out redirect and the PROXY protocol", () => {
    const s = renderSnippet({ dir: "/d", httpPort: 4080, httpsPort: 4443, acceptProxy: true });
    expect(s).toContain("listening on :4080");
    expect(s).toContain("bind :4443 ssl crt /d/certs/ accept-proxy");
    expect(s).toContain("redirect location https://%[req.hdr(host),field(1,:)]:4443%[pathq] code 301");
    expect(s).not.toContain("redirect scheme");
  });

  it("redirects to the standard port when a proxy in front maps 443", () => {
    const s = renderSnippet({ dir: "/d", httpsPort: 4443, publicHttpsPort: 443 });
    expect(s).toContain("redirect scheme https code 301");
  });

  it("renders a complete dedicated config", () => {
    const c = renderMainConfig({ dir: "/d", httpPort: 4080, httpsPort: 4443 });
    expect(c).toContain("frontend freighter_http\n    bind :4080\n");
    expect(c).toContain("bind :4443 ssl crt /d/certs/\n");
    expect(c).toContain("user haproxy");
  });

  it("answers the domain check on both listeners", () => {
    const c = renderMainConfig({ dir: "/d" });
    expect(c.match(/use_backend freighter_challenge if \{ path_beg \/\.well-known\/freighter-challenge \}/g)).toHaveLength(2);
    expect(renderSnippet({ dir: "/d" })).toContain("freighter_challenge");
  });

  it("takes the visitor's address from Cloudflare only when asked to, and only from Cloudflare's ranges", () => {
    expect(renderMainConfig({ dir: "/d" })).not.toContain("CF-Connecting-IP");
    const c = renderMainConfig({ dir: "/d", trustCloudflare: true });
    expect(c.match(/set-src req\.hdr\(CF-Connecting-IP\) if freighter_cloudflare/g)).toHaveLength(2);
    expect(c).toContain("acl freighter_cloudflare src 173.245.48.0/20");
    expect(c).toContain("2c0f:f248::/32");
  });
});
