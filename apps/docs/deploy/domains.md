# Domains and HTTPS

A domain routes a hostname to one of an app's services. Domains are set on the app, not in `app.yaml`. They're stored on the app's server (`/srv/apps/<app>/domains.json`), so redeploys and rollbacks keep them, and apps without an `app.yaml` can have them too.

## Add a domain

On the app's **Domains** tab (admin), press **Add domain** and choose:

- **Hostname**, a lowercase DNS name such as `shop.example.com`. Wildcards aren't supported.
- **Service**, the service that receives the traffic.
- **HTTPS**: *Automatic HTTPS* (`tls: auto`) or *HTTP only* (`tls: off`).

The domain starts out *Waiting for DNS*. Nothing is routed and no certificate is requested yet.

## Point DNS at the server

The tab shows the records to create at your DNS provider: an `A` record (and `AAAA`, for IPv6) with the hostname as its name and the app's server address as its value. Some providers want only the part before your zone, `shop` instead of `shop.example.com`.

For apps on the control server, the address comes from `api.publicIps` in `config.yaml`. If that's unset, the tab explains how to set it.

## Verify

Press **Verify**. Freighter resolves the name through public resolvers (`api.dnsServers`, Cloudflare and Google by default, so a stale local cache doesn't get in the way). The name must resolve, and only to the app's server, or be [proxied by Cloudflare](#behind-cloudflare). If it does, the domain goes live through a recorded deployment:

1. With `tls: auto`, a certificate is requested from Let's Encrypt before anything changes. A DNS or port 80 problem fails here, with nothing touched.
2. If this is the service's first domain, it is redeployed as a routed service on an allocated `$PORT`, health-checked, and HAProxy switches to it (the same files, no build). If the service already has a domain, HAProxy just starts routing the new hostname and nothing restarts. See [When a change of domains redeploys](#when-a-change-of-domains-redeploys).

If the records don't match yet, Freighter says what it found and what it expected. DNS changes can take a few minutes to spread.

Names ending in `.localhost` need no DNS and go live as soon as you verify them, which is handy for testing.

From the API or CLI:

```sh
# API (admin token)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"hostname":"shop.example.com","service":"web","tls":"auto"}' \
  https://freighter.example.com/api/v1/apps/shop/domains
curl -X POST -H "Authorization: Bearer $TOKEN" https://freighter.example.com/api/v1/apps/shop/domains/shop.example.com/verify

# CLI, on the app's server, as root (no DNS check)
freighter domain add shop shop.example.com=web          # tls defaults to auto
freighter domain add shop shop.localhost=web:off
freighter domain list shop
freighter domain remove shop shop.example.com
```

## Behind a proxy or CDN

A proxy or CDN between visitors and your server (Cloudflare's orange cloud, Fastly, CloudFront, a WAF) changes two things. DNS now returns *the proxy's* addresses, so your records no longer show where a domain points. And the proxy, not the visitor, opens the connection to your server. Four things follow. Cloudflare is the worked example; the ideas apply to any proxy.

| What changes | What you do |
| --- | --- |
| Records can't prove the domain reaches this server | Freighter checks with a request instead. [Verifying](#verifying-a-proxied-domain) |
| The proxy connects to your server over HTTP or HTTPS | Match the domain's `tls` setting to the proxy's mode. [Proxy to server](#proxy-to-server-reachability-and-tls-mode) |
| Let's Encrypt validates through the proxy | Choose a challenge that works through it. [Certificates](#certificates) |
| Your server sees the proxy's address, not the visitor's | Read the visitor's address from the proxy's header. [Visitor addresses](#visitor-addresses) |

### Verifying a proxied domain

Freighter asks the server for its check token and requests `http://<hostname>/.well-known/freighter-challenge` the way a visitor would. The domain is verified when the answer carries that token: the request really travelled through the proxy to *this* server. Records that point straight at the server still verify by address alone.

For this to work:

- **HAProxy must answer the check path** on both listeners. A dedicated HAProxy gets the rule from `freighter haproxy config`. If you keep your own `haproxy.cfg`, add the `use_backend freighter_challenge …` line to both frontends ([The lines to add](/install/haproxy#the-lines-to-add)).
- **The proxy must reach the server** on port 80 (or 443 if it connects over HTTPS), as described below. A Cloudflare `52x` error shows up in the failure message.

Freighter recognises a proxied name by its addresses, and today it only knows **Cloudflare's published ranges**. A name that resolves to a mix of your server and other addresses still fails, because some visitors would be sent elsewhere. For a proxy Freighter doesn't recognise, verification reports that the name resolves to addresses that aren't this server's. Verification happens once, when you add the domain, so turn the proxy off for a moment:

1. Point the name straight at the server (for Cloudflare, switch the record to *DNS only*).
2. Press **Verify** and wait for the domain to go live.
3. Turn the proxy back on.

### Proxy to server: reachability and TLS mode

Allow the proxy's address ranges to reach ports 80 and 443 (a firewall that allows *only* those ranges keeps visitors from bypassing the proxy). The proxy then talks to your server in one of three ways. The TLS mode you pick at the proxy decides the domain's `tls` setting:

| The proxy connects to your server over | Cloudflare's name | Domain setting | Certificate on the server |
| --- | --- | --- | --- |
| Plain HTTP | *Flexible* | `tls: off` | none; visitors still get HTTPS from the proxy |
| HTTPS, certificate not checked | *Full* | `tls: auto` | Freighter's, even the placeholder |
| HTTPS, certificate checked | *Full (strict)* | `tls: auto` | a valid one, so issue it with the [DNS challenge](#certificates) |

::: warning Plain HTTP to the server needs `tls: off`
`tls: auto` makes Freighter redirect HTTP to HTTPS. A proxy that connects over plain HTTP then follows the redirect to the proxy's own HTTPS address, and visitors get an endless redirect loop (“too many redirects”). With *Flexible*, use `tls: off`, or switch the proxy to *Full*.
:::

A proxy's own “always use HTTPS” redirect is fine with any of these.

### Visitor addresses

Your server sees the proxy's address, so logs and `X-Forwarded-For` show that instead of the visitor's. Proxies pass the real address in a header (`CF-Connecting-IP` for Cloudflare, `X-Real-IP` or `X-Forwarded-For` for others), which must only be believed when the connection comes from the proxy.

- **Cloudflare:** turn on **Behind Cloudflare's proxy** (`haproxy.trustCloudflare: true`). Freighter's HAProxy then reads `CF-Connecting-IP`, but only on connections from Cloudflare's published ranges. A dedicated HAProxy picks it up with the config; with your own, add the two lines `freighter haproxy setup` prints ([Behind a proxy or CDN](/install/haproxy#if-your-domains-are-behind-a-proxy-or-cdn)).
- **Other proxies:** add the equivalent rule to your frontends yourself, with that proxy's ranges and header.

## Certificates

`tls: auto` certificates come from Let's Encrypt. Set `acme.email` in `config.yaml` first. While testing, set `acme.staging: true` to stay clear of Let's Encrypt's rate limits. `acme.challenge` chooses how Let's Encrypt is convinced:

| `acme.challenge` | How | Good for |
| --- | --- | --- |
| `http` (default) | `certbot certonly --standalone` listens on `acme.challengePort` (8888). HAProxy forwards `/.well-known/acme-challenge/` to it through the `freighter_acme` backend. | Names whose records point at the server, and names behind a proxy that passes `/.well-known/acme-challenge/` through to port 80 (most do). |
| `cloudflare-dns` | `certbot certonly --dns-cloudflare` creates the validation TXT record through the Cloudflare API. | Names behind a proxy that blocks or rewrites that path, a proxy in *Full (strict)* mode (the certificate must exist before traffic does), and issuing before DNS points here. Needs no open port 80. Cloudflare-hosted zones only. |

For `cloudflare-dns`, install certbot's Cloudflare plugin (`python3-certbot-dns-cloudflare` on Debian and Ubuntu) and create a Cloudflare API token with **Zone → DNS → Edit** on the zones you use. Put it in `/etc/freighter/cloudflare.ini` (the path is `acme.cloudflareCredentials`) and keep it private:

```ini
dns_cloudflare_api_token = <your token>
```

```sh
chmod 600 /etc/freighter/cloudflare.ini
```

`acme.dnsPropagationSeconds` (30) is how long certbot waits after creating the record. The challenge is a server-wide setting, and renewals use the same one.

The DNS challenge exists for Cloudflare only. Behind another proxy, use the HTTP challenge if it passes the challenge path through. Otherwise let the proxy hold the certificate and give the domain `tls: off` ([the proxy terminates TLS](/install/haproxy#option-b-your-proxy-terminates-tls)).

HTTP requests to a `tls: auto` hostname are redirected to HTTPS. HAProxy adds `X-Forwarded-For`, and `X-Forwarded-Proto: https` on TLS connections.

Renewal is automatic: `freighter-renew.timer` runs `freighter certs renew` daily, renews anything within `acme.renewBeforeDays` (30) of expiry, and reloads HAProxy once. The **Certificates** page lists every certificate with its expiry. Admins can press **Renew due certificates** there.

```sh
freighter certs status
freighter certs renew            # only what's due
freighter certs renew --force    # re-issue everything
```

## Remove a domain

Use the trash icon on the Domains tab. A waiting domain is just deleted. A live one stops being routed at once: HAProxy forgets the hostname and its certificate file is deleted. **Nothing is redeployed or rebuilt, and no service restarts**, so it takes a second, not the minutes a build takes.

If you remove a service's last domain, the service keeps running where it is, now unreachable from outside, until the next deploy. That deploy settles it: the service is no longer routed, so it goes back to its normal `port`. Deploy again whenever you want that, from the Deployments tab.

## When a change of domains redeploys

Changes that only decide where traffic goes apply as routing, with no new release:

- removing a domain,
- adding another domain to a service that is already routed,
- moving a domain between services that are already routed.

One change needs a redeploy: **giving a service its first domain**. The service has to start listening on an allocated `$PORT`, so Freighter redeploys the current release unchanged (no build: the same files) through the normal path, with a health check and automatic rollback. Verifying the first domain of a service therefore takes as long as a deploy without the build. Adding more domains to it afterwards doesn't.

The deployment record for a routing-only change says so: *routing updated; the app was not redeployed*.

Either way the deployment has a log, shown while the change is applied and kept with the deployment afterwards (Deployments tab, open the row). It lists each step: the certificate, the new instance and its port, the health check, the HAProxy switch, the old instance being stopped. When a redeploy fails, it includes what the service itself printed, and says the previous release is running again.

## Services behind a domain

Once a domain points at a service, the service runs one instance per release on a port from `ports.min`–`ports.max` (20000–29999), passed as `$PORT`. The `port` in `app.yaml` is ignored for it, and the deploy warns you about that. If the service has a `healthcheck`, HAProxy also checks it every 5 seconds and takes it out of rotation after 3 failures.
