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
2. The service is redeployed as a routed service on an allocated `$PORT`, health-checked, and HAProxy switches to it.

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

## Behind Cloudflare

Both Cloudflare modes work: **DNS only** (grey cloud) and **Proxied** (orange cloud). A proxied name resolves to Cloudflare's addresses, which say nothing about your server, so Freighter checks something else. It asks the server for its check token and requests `http://<hostname>/.well-known/freighter-challenge` the way a visitor would. The domain is verified when the answer carries that token, so the request really reached this server through the proxy. Records that point straight at the server still verify by address alone.

Only Cloudflare's own addresses get this treatment. A name that resolves to a mix of your server and some other address still fails, because some visitors would be sent elsewhere.

What this needs:

- **HAProxy rule.** HAProxy must answer the check path on both listeners. Servers using the dedicated setup get it from `freighter haproxy config` (the dashboard's settings do the same when listener settings change). If you keep your own `haproxy.cfg`, add the `use_backend freighter_challenge …` line that `freighter haproxy setup` prints, to both frontends. Freighter writes the `freighter_challenge` backend into `backends.cfg` on the next deploy.
- **Reachability.** Cloudflare must be able to reach the server on port 80 (SSL/TLS mode *Flexible*, or *Full* before a certificate exists) or 443. A `52x` error from Cloudflare shows up in the failure message. If you use *Full (strict)*, issue the certificate with the DNS challenge below, so it exists before traffic arrives.
- **Visitor addresses.** Turn on **Behind Cloudflare's proxy** (`haproxy.trustCloudflare`) so logs and `X-Forwarded-For` carry the visitor's address instead of Cloudflare's. HAProxy reads `CF-Connecting-IP` only on connections from Cloudflare's published ranges, so nobody else can spoof it. For a server that should only be reachable through Cloudflare, also restrict ports 80 and 443 to [Cloudflare's ranges](https://www.cloudflare.com/ips/) in your firewall.

## Certificates

`tls: auto` certificates come from Let's Encrypt. Set `acme.email` in `config.yaml` first. While testing, set `acme.staging: true` to stay clear of Let's Encrypt's rate limits. `acme.challenge` chooses how Let's Encrypt is convinced:

| `acme.challenge` | How | Good for |
| --- | --- | --- |
| `http` (default) | `certbot certonly --standalone` listens on `acme.challengePort` (8888). HAProxy forwards `/.well-known/acme-challenge/` to it through the `freighter_acme` backend. | Names whose records point at the server, or Cloudflare proxied names where port 80 reaches HAProxy. |
| `cloudflare-dns` | `certbot certonly --dns-cloudflare` creates the validation TXT record through the Cloudflare API. | Proxied names, *Full (strict)* mode, and issuing before DNS points here. Needs no open port 80. |

For `cloudflare-dns`, install certbot's Cloudflare plugin (`python3-certbot-dns-cloudflare` on Debian and Ubuntu) and create a Cloudflare API token with **Zone → DNS → Edit** on the zones you use. Put it in `/etc/freighter/cloudflare.ini` (the path is `acme.cloudflareCredentials`) and keep it private:

```ini
dns_cloudflare_api_token = <your token>
```

```sh
chmod 600 /etc/freighter/cloudflare.ini
```

`acme.dnsPropagationSeconds` (30) is how long certbot waits after creating the record. The challenge is a server-wide setting, and renewals use the same one.

HTTP requests to a `tls: auto` hostname are redirected to HTTPS. HAProxy adds `X-Forwarded-For`, and `X-Forwarded-Proto: https` on TLS connections.

Renewal is automatic: `freighter-renew.timer` runs `freighter certs renew` daily, renews anything within `acme.renewBeforeDays` (30) of expiry, and reloads HAProxy once. The **Certificates** page lists every certificate with its expiry. Admins can press **Renew due certificates** there.

```sh
freighter certs status
freighter certs renew            # only what's due
freighter certs renew --force    # re-issue everything
```

## Remove a domain

Use the trash icon on the Domains tab. A waiting domain is just deleted. A live one is removed through a deployment, and the app stops answering on that hostname.

## Services behind a domain

Once a domain points at a service, the service runs one instance per release on a port from `ports.min`–`ports.max` (20000–29999), passed as `$PORT`. The `port` in `app.yaml` is ignored for it, and the deploy warns you about that. If the service has a `healthcheck`, HAProxy also checks it every 5 seconds and takes it out of rotation after 3 failures.
