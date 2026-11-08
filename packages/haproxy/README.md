# @freighter/haproxy

Routing and TLS integration (phase 4). Freighter manages **only** these files in `haproxy.dir` (default `/etc/haproxy/freighter`):

| file | purpose |
| --- | --- |
| `hostnames.map` | hostname -> backend name |
| `https.map` | hostnames that redirect HTTP -> HTTPS |
| `backends.cfg` | one backend per routed service + the `freighter_acme` backend |
| `certs/<host>.pem` | combined cert + key per `tls: auto` hostname |

Your own `haproxy.cfg` stays yours. No HAProxy on the host, or its ports are taken? `freighter haproxy config` prints a complete config for a Freighter-only instance (unit: `infra/systemd/freighter-haproxy.service`); `haproxy.httpPort`/`httpsPort` choose its ports, so it can sit behind your own reverse proxy (see the docs, *Connect HAProxy*). Run `freighter haproxy setup` once and paste the printed lines into your :80 and :443 frontends, and load `backends.cfg` with an extra `-f` (HAProxy >= 2.4).

## Host config (`/etc/freighter/config.yaml`, all optional except the email for `tls: auto`)
```yaml
haproxy: { dir: /etc/haproxy/freighter, mainConfig: /etc/haproxy/haproxy.cfg, bin: haproxy, reloadCommand: [systemctl, reload, haproxy] }
acme: { email: you@example.com, staging: false, challengePort: 8888, letsencryptDir: /etc/letsencrypt, renewBeforeDays: 30 }
ports: { min: 20000, max: 29999 }
drainSeconds: 5
```

## How a deploy switches traffic
New instance starts on a fresh port -> health-checked -> files rewritten -> `haproxy -c -f main -f backends.cfg` validates the whole config (old files are restored if it fails) -> graceful `reload` -> old instance drains and stops. A graceful reload was chosen over the runtime API for robustness; a runtime-API client can be added later.

## Certificates
`tls: auto` hostnames get a cert via `certbot certonly --standalone` on `acme.challengePort` (HAProxy forwards the HTTP-01 challenge there). With `acme.challenge: cloudflare-dns` they use `certbot --dns-cloudflare` instead (works behind Cloudflare's proxy). `backends.cfg` also holds `freighter_challenge`, which answers `/.well-known/freighter-challenge` with a per-server token so the control plane can verify proxied domains. Issuing happens before anything is changed, so a DNS/port-80 problem fails the deploy early; use `tls: off` to skip. `freighter certs renew` (daily via `infra/systemd/freighter-renew.timer`) renews anything within `renewBeforeDays` of expiry and reloads HAProxy once.
