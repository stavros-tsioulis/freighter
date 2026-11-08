# config.yaml

Each server reads `/etc/freighter/config.yaml`. The file and every key in it are optional: a missing file means all defaults. The agent and API read it when they start, so restart them after a change (`systemctl restart freighter-agent freighter-api`).

The only key most setups must set is `acme.email`, before any domain uses `tls: auto`.

Most of the keys can also be changed from the dashboard: see [Server settings](/operate/server-settings).

## Full example with defaults

```yaml
haproxy:
  dir: /etc/haproxy/freighter
  mainConfig: /etc/haproxy/haproxy.cfg
  bin: haproxy
  reloadCommand: [systemctl, reload, haproxy]
  httpPort: 80
  httpsPort: 443
  publicHttpsPort: 443            # default: the value of httpsPort
  acceptProxy: false
  trustCloudflare: false

acme:
  email: ops@example.com          # no default
  staging: false
  challenge: http                 # or cloudflare-dns
  challengePort: 8888
  letsencryptDir: /etc/letsencrypt
  renewBeforeDays: 30

ports:
  min: 20000
  max: 29999

drainSeconds: 5

agent:
  socket: /run/freighter/agent.sock
  group: freighter
  artifactsDir: /var/lib/freighter/artifacts
  upgradeDir: /var/lib/freighter/upgrade
  maxArtifactMb: 200
  remote:
    enabled: false
    listen: 0.0.0.0
    port: 7443
    certDir: /etc/freighter/agent
    clientCn: freighter-control-plane

git:
  allowLocal: false
  knownHosts: accept-new
  buildUser: freighter-build
  buildDir: /var/lib/freighter-build
  keyDir: /var/lib/freighter/git

pki:
  dir: /var/lib/freighter/pki

registry:
  path: /var/lib/freighter/registry.db

api:
  publicUrl: https://freighter.example.com   # no default
  publicIps: []
  dnsServers: [1.1.1.1, 8.8.8.8]
  trustProxy: true
  maxUploadMb: 200
  syncSeconds: 60
  metricsSeconds: 15
  metricsRetentionHours: 6
```

## haproxy

Used by every server that routes domains.

| Key | Default | |
| --- | --- | --- |
| `dir` | `/etc/haproxy/freighter` | Where Freighter writes `hostnames.map`, `https.map`, `backends.cfg` and `certs/`. |
| `mainConfig` | `/etc/haproxy/haproxy.cfg` | Your config, included when validating before a reload. |
| `bin` | `haproxy` | The HAProxy binary used for `haproxy -c`. |
| `reloadCommand` | `[systemctl, reload, haproxy]` | How to reload gracefully. A dedicated HAProxy uses `[systemctl, reload, freighter-haproxy]`. |
| `httpPort` | `80` | The port HAProxy listens on for HTTP. Used by `freighter haproxy setup` and `freighter haproxy config`. |
| `httpsPort` | `443` | The port HAProxy listens on for HTTPS. |
| `publicHttpsPort` | `httpsPort` | The HTTPS port clients are redirected to. Set `443` when your own proxy maps 443 to a different `httpsPort`. |
| `acceptProxy` | `false` | Expect the PROXY protocol on both ports, for a TCP proxy in front that sends it. |
| `trustCloudflare` | `false` | Cloudflare's proxy is in front: use `CF-Connecting-IP` as the visitor's address, but only for connections from Cloudflare's published ranges. See [Behind a proxy or CDN](/deploy/domains#behind-a-proxy-or-cdn). |

For a server without HAProxy, a dedicated one and a different `mainConfig` is set up for you. See [Connect HAProxy](/install/haproxy#run-a-dedicated-haproxy) and [Behind your own reverse proxy](/install/haproxy#behind-your-own-reverse-proxy).

## acme

Let's Encrypt certificates for `tls: auto` domains.

| Key | Default | |
| --- | --- | --- |
| `email` | none | Your Let's Encrypt account email. Required for `tls: auto`. |
| `staging` | `false` | Use Let's Encrypt's staging environment (untrusted certificates, generous limits) while testing. |
| `challenge` | `http` | How Let's Encrypt is convinced. `http`: HTTP-01 through port 80. `cloudflare-dns`: DNS-01 through the Cloudflare API, which works behind a proxy and before DNS points here. See [Certificates](/deploy/domains#certificates). |
| `cloudflareCredentials` | `/etc/freighter/cloudflare.ini` | certbot's credentials file with `dns_cloudflare_api_token = …` (mode 600). Read only when `challenge` is `cloudflare-dns`. |
| `dnsPropagationSeconds` | `30` | For `cloudflare-dns`: how long certbot waits after creating the TXT record (10–600). |
| `challengePort` | `8888` | Local port certbot listens on during HTTP-01 challenges. HAProxy forwards to it. |
| `letsencryptDir` | `/etc/letsencrypt` | certbot's directory. |
| `renewBeforeDays` | `30` | `freighter certs renew` renews certificates expiring within this many days. |

## ports and drainSeconds

| Key | Default | |
| --- | --- | --- |
| `ports.min`, `ports.max` | `20000`, `29999` | The range ports are allocated from for routed services. Keep it clear of other software. |
| `drainSeconds` | `5` | How long the old instance of a routed service keeps running after HAProxy switches away from it, so requests in flight can finish. |

## agent

| Key | Default | |
| --- | --- | --- |
| `socket` | `/run/freighter/agent.sock` | The unix socket the local API talks to. |
| `group` | `freighter` | The group given access to the socket and the artifacts directory. |
| `artifactsDir` | `/var/lib/freighter/artifacts` | Where uploads wait until they're deployed. They're deleted afterwards. |
| `upgradeDir` | `/var/lib/freighter/upgrade` | State, backup and log of the last [remote upgrade](/install/remote-server#upgrading-a-server). |
| `maxArtifactMb` | `200` | The largest artifact this agent accepts from a remote control server. |
| `remote.enabled` | `false` | Serve the agent over mutual TLS. `freighter-agent enroll` turns this on. |
| `remote.listen` | `0.0.0.0` | Address to listen on. |
| `remote.port` | `7443` | Port to listen on. |
| `remote.certDir` | `/etc/freighter/agent` | `server.key`, `server.crt` and `ca.crt`, written by enrollment. |
| `remote.clientCn` | `freighter-control-plane` | The only client certificate name accepted. |

## git

| Key | Default | |
| --- | --- | --- |
| `knownHosts` | `accept-new` | SSH host key policy on first contact with a Git host. `yes` refuses hosts not already in `known_hosts`. |
| `buildUser` | `freighter-build` | The unprivileged user builds run as. It's created on first use. |
| `buildDir` | `/var/lib/freighter-build` | Checkouts and per-app package caches. |
| `keyDir` | `/var/lib/freighter/git` | Generated deploy keys and `known_hosts`, one directory per app. |
| `allowLocal` | `false` | Allow local paths and `file://` repositories. Only for testing. |

## pki and registry

Control server only.

| Key | Default | |
| --- | --- | --- |
| `pki.dir` | `/var/lib/freighter/pki` | The private CA and the control plane's client certificate. |
| `registry.path` | `/var/lib/freighter/registry.db` | The SQLite registry. `secret.key`, which encrypts SSH keys, lives in the same directory. |

## api

Control server only.

| Key | Default | |
| --- | --- | --- |
| `localAgent` | `false` | Whether this control server also runs apps, through the agent on the same machine (the server named `local`). Off by default: a control server manages remote servers. See [Also run apps on this server](/install/control-server#also-run-apps-on-this-server). |
| `publicUrl` | derived from each request | This control server's public URL, used in webhook URLs and enrollment commands. Set it when the API sits behind a proxy. |
| `publicIps` | `[]` | The control server's public IPs, shown as the DNS target when adding domains to apps on `local`. |
| `dnsServers` | `[1.1.1.1, 8.8.8.8]` | Resolvers used to verify domains. `[]` uses the system resolver, for split-horizon DNS for example. When these can't be reached, the system resolver answers instead. |
| `trustProxy` | `true` | Take the client address from `X-Forwarded-For`. Correct when the API listens on localhost behind HAProxy. |
| `maxUploadMb` | `200` | The largest archive accepted for upload. |
| `syncSeconds` | `60` | How often every server is re-read into the registry. `0` turns periodic sync off. |
| `metricsSeconds` | `15` | How often service metrics are sampled. `0` turns sampling off. |
| `metricsRetentionHours` | `6` | How long metric samples are kept. |

Every `api` key except `localAgent` can also be saved from the dashboard (**Settings → Server → Control server**) or fixed with an environment variable, which wins over both. The variable is the key in capitals with underscores: `api.dnsServers` is `FREIGHTER_API_DNS_SERVERS`. See [Server settings](/operate/server-settings#the-control-server-s-own-settings).

## Environment variables

| Variable | Read by | |
| --- | --- | --- |
| `NITRO_HOST`, `NITRO_PORT` | API | Listen address and port. The service file sets `127.0.0.1` and `3000`. |
| `FREIGHTER_URL`, `FREIGHTER_TOKEN` | CLI (`push`, `git`, `ssh-key`) | API URL and token, instead of `--url` and `--token`. |
| `FREIGHTER_KEY_PASSPHRASE` | CLI (`ssh-key import`) | Passphrase for an encrypted key. |
| `PORT` | API | Used when `NITRO_PORT` is not set. Container hosts such as Railway set it. |
| `FREIGHTER_BOOTSTRAP_TOKEN` | API | First run only: creates an admin token named `bootstrap` with this value, when no token has ever existed. For hosts without a shell. See [Run it on Railway](/install/railway). |
| `FREIGHTER_API_*` | API | One per `api` setting (`FREIGHTER_API_PUBLIC_URL`, `FREIGHTER_API_DNS_SERVERS`, `FREIGHTER_API_MAX_UPLOAD_MB`, …). Override the dashboard and `config.yaml`. |
| `FREIGHTER_PREFIX` | API | Development only: relocate every path under a directory. |
