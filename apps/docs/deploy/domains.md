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

Press **Verify**. Freighter resolves the name through public resolvers (`api.dnsServers`, Cloudflare and Google by default, so a stale local cache doesn't get in the way). The name must resolve, and only to the app's server. If it does, the domain goes live through a recorded deployment:

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

## Certificates

`tls: auto` certificates come from Let's Encrypt with `certbot certonly --standalone`, listening on `acme.challengePort` (8888). HAProxy forwards `/.well-known/acme-challenge/` to it through the `freighter_acme` backend. Set `acme.email` in `config.yaml` first. While testing, set `acme.staging: true` to stay clear of Let's Encrypt's rate limits.

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
