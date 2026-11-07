import { describe, expect, it } from "vitest";
import { renderBackends, renderHostnameMap, renderHttpsMap, renderSnippet, type Route } from "../src/index.ts";

const routes: Route[] = [
  { app: "shop", service: "web", hostname: "shop.example.com", tls: "auto", port: 20001, healthPath: "/health" },
  { app: "shop", service: "web", hostname: "www.shop.example.com", tls: "auto", port: 20001, healthPath: "/health" },
  { app: "blog", service: "web", hostname: "blog.example.com", tls: "off", port: 20002 },
];

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
    expect(renderBackends(routes, { acmePort: 8888 })).toBe(`# Managed by freighter. Do not edit; regenerated on every deploy.

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
`);
  });

  it("rejects one backend with two ports", () => {
    const bad = [routes[0]!, { ...routes[1]!, port: 20009 }];
    expect(() => renderBackends(bad, { acmePort: 8888 })).toThrow(/conflicting ports/);
  });

  it("renders the one-time snippet with the managed dir", () => {
    const s = renderSnippet({ dir: "/etc/haproxy/freighter" });
    expect(s).toContain("-f /etc/haproxy/freighter/backends.cfg");
    expect(s).toContain("bind :443 ssl crt /etc/haproxy/freighter/certs/");
    expect(s).toContain("map(/etc/haproxy/freighter/hostnames.map)");
    expect(s).toContain("use_backend freighter_acme if freighter_acme");
  });
});
