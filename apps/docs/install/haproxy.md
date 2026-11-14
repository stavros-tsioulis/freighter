# Connect HAProxy

Freighter doesn't take over HAProxy. If you already run one, your `haproxy.cfg` stays yours. If you don't, Freighter can run a separate HAProxy of its own and leave the system's alone. Pick the setup that matches your server:

| Your server | Setup | Where |
| --- | --- | --- |
| Already runs HAProxy (for other sites, say) | **Shared**: add a few lines to your config | [Shared](#shared-add-freighter-to-your-haproxy): [installed with the script](#installed-with-the-script) or [fully manual](#fully-manual) |
| Runs no HAProxy, or you want Freighter's separate | **Dedicated**: a Freighter-only HAProxy on ports you choose | [Run a dedicated HAProxy](#run-a-dedicated-haproxy) |
| Runs nginx, Caddy, Traefik or a cloud load balancer on 80/443 | **Dedicated**, on other ports, behind your proxy | [Behind your own reverse proxy](#behind-your-own-reverse-proxy) |

The installer script chooses for you: it uses the HAProxy it finds, and otherwise sets up a dedicated one (`--haproxy existing|dedicated` overrides). Freighter always needs *an* HAProxy. It's how it switches traffic between releases without dropping requests. The dedicated setup means it needn't be one you run yourself.

In every setup Freighter writes only these files, in `/etc/haproxy/freighter` (the `haproxy.dir` setting):

| File | Contents |
| --- | --- |
| `hostnames.map` | hostname to backend, one line per domain |
| `https.map` | hostnames that redirect from HTTP to HTTPS (`tls: auto`) |
| `backends.cfg` | one backend per routed service, plus `freighter_acme` (certificate challenges) and `freighter_challenge` (the dashboard's domain check) |
| `certs/<hostname>.pem` | certificate and key for each `tls: auto` domain |
| `mode` | `dedicated` or `existing`: whose HAProxy this is, written by the installer (see [After an upgrade](#after-an-upgrade)) |

You connect them once, on every server that will serve domains.

## Shared: add Freighter to your HAProxy

For servers that already run HAProxy. Freighter never edits your `haproxy.cfg`. Instead it needs five things from it, which you add once:

| # | What | Why |
| --- | --- | --- |
| 1 | HAProxy loads `/etc/haproxy/freighter/backends.cfg`, through an extra `-f` | Freighter keeps one backend per routed service there, and rewrites the file on every deploy. |
| 2 | In the **:80 frontend**: the ACME rule, the HTTPS redirect, the challenge rule and the routing line | Let's Encrypt validates over port 80, `tls: auto` domains redirect to HTTPS, and plain HTTP domains are routed. |
| 3 | In the **:443 frontend**: `bind … ssl crt /etc/haproxy/freighter/certs/`, the challenge rule and the routing line | HAProxy serves each domain's certificate and routes by hostname. |
| 4 | A placeholder certificate in that `certs/` directory | HAProxy refuses to start with an empty `crt` directory. |
| 5 | The files and backends Freighter's lines point at, created before HAProxy reloads | HAProxy refuses to start when a `use_backend` names a backend that doesn't exist. |

Which of them are already done depends on how you installed:

| You… | What's done | Go to |
| --- | --- | --- |
| used the install script on a server that already ran HAProxy | 1, 4 and 5. Your `haproxy.cfg` is unchanged, so 2 and 3 are left. | [Installed with the script](#installed-with-the-script) |
| set Freighter up by hand | none | [Fully manual](#fully-manual) |

Not sure? `ls /etc/haproxy/freighter`. If it lists `backends.cfg`, `certs`, `hostnames.map`, `https.map` and `mode`, the script ran.

### The lines to add

These are items 2 and 3. They're the same in both cases. With the default directory and ports (80 and 443), add this to the **frontend that listens on :80**, before your other rules:

```txt
    acl freighter_acme path_beg /.well-known/acme-challenge/
    http-request redirect scheme https code 301 if !{ ssl_fc } !freighter_acme { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/https.map) -m found }
    use_backend freighter_acme if freighter_acme
    use_backend freighter_challenge if { path_beg /.well-known/freighter-challenge }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }
```

and this to the **frontend that listens on :443** (add the `bind` if it has none with that certificate directory; `crt` can be given more than once, so your own certificates can stay):

```txt
    bind :443 ssl crt /etc/haproxy/freighter/certs/
    use_backend freighter_challenge if { path_beg /.well-known/freighter-challenge }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }
```

What each line does:

| Line | Purpose |
| --- | --- |
| `acl freighter_acme …` and `use_backend freighter_acme …` | Hand Let's Encrypt's `/.well-known/acme-challenge/` requests to certbot, which listens on `acme.challengePort` (8888). |
| `http-request redirect scheme https …` | Redirect HTTP to HTTPS, only for hostnames in `https.map` (the `tls: auto` domains). |
| `use_backend freighter_challenge …` | Answer the dashboard's domain check, so it can tell that a hostname reaches this server. This is what lets domains behind Cloudflare's proxy verify, where DNS records say nothing about your server. Domains pointing straight at the server verify without it, but add it anyway. |
| `use_backend %[…hostnames.map…] if {…}` | Route a request to the backend of the app whose domain it asks for. Hostnames Freighter doesn't know fall through to your own rules. |
| `bind :443 ssl crt …/certs/` | Serve each domain's certificate from the directory Freighter writes them to. |

`freighter host haproxy setup` prints the same lines for **your** ports and directory (`haproxy.httpPort`, `haproxy.httpsPort`, `haproxy.dir`), so copy from its output when they differ from the defaults. They need HAProxy 2.4 or later.

### Installed with the script

When the installer finds HAProxy on the server it wires Freighter in without touching `haproxy.cfg`. It has already:

- created `/etc/haproxy/freighter/` with `hostnames.map`, `https.map` and `backends.cfg`, which already holds the `freighter_acme` and `freighter_challenge` backends the lines refer to,
- put a self-signed placeholder in `/etc/haproxy/freighter/certs/`,
- recorded `existing` in `/etc/haproxy/freighter/mode`,
- added `-f /etc/haproxy/freighter/backends.cfg` to `EXTRAOPTS` in `/etc/default/haproxy`, unless that file already set `EXTRAOPTS` (the installer then says so, and item 1 below is yours).

What's left is your `haproxy.cfg`:

1. **Check that HAProxy loads `backends.cfg`.**

   ```sh
   grep EXTRAOPTS /etc/default/haproxy
   ```

   It should show `-f /etc/haproxy/freighter/backends.cfg`. If you already had an `EXTRAOPTS` line, add that option inside it yourself, then restart HAProxy. Where HAProxy isn't started through that file, add `-f /etc/haproxy/freighter/backends.cfg` to the `haproxy` command in its service file instead (`systemctl edit haproxy`), next to the existing `-f`.

2. **Add the :80 lines** from [The lines to add](#the-lines-to-add) to your frontend on port 80, before its other rules.

3. **Add the :443 lines** to your frontend on port 443.

4. **Check, then reload.**

   ```sh
   haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg
   systemctl reload haproxy
   ```

Until you do, HAProxy keeps serving exactly what it served before. Nothing is routed to Freighter's apps, and certificates can't be issued over HTTP.

### Fully manual

For a server where you set everything up yourself, without the script. You do all five items.

**1. Create the files.** `backends.cfg` must already contain the two backends that the lines above refer to, or HAProxy refuses to start. Freighter keeps those two and rewrites the rest on every deploy.

```sh
install -d /etc/haproxy/freighter/certs
touch /etc/haproxy/freighter/hostnames.map /etc/haproxy/freighter/https.map
echo existing > /etc/haproxy/freighter/mode      # whose HAProxy this is; upgrades use it (see "After an upgrade")
cat > /etc/haproxy/freighter/backends.cfg <<'EOF'
# Managed by freighter. Do not edit; regenerated on every deploy.

backend freighter_acme
    server certbot 127.0.0.1:8888

backend freighter_challenge
    http-request return status 200 content-type text/plain string "unset"
EOF
```

**2. Add a placeholder certificate.** HAProxy refuses to start when a `crt` directory is empty. The placeholder is never served for a real domain, because each domain gets its own certificate.

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=placeholder" \
  -keyout /tmp/p.key -out /tmp/p.crt
cat /tmp/p.crt /tmp/p.key > /etc/haproxy/freighter/certs/placeholder.pem
chmod 600 /etc/haproxy/freighter/certs/placeholder.pem
rm /tmp/p.key /tmp/p.crt
```

**3. Make HAProxy load `backends.cfg`.** HAProxy normally reads one file, your `haproxy.cfg`. Freighter writes the backends for your apps to a separate file so it never edits yours, and `-f` is how you give HAProxy more than one config file. On Debian and Ubuntu, HAProxy's unit reads extra options from `/etc/default/haproxy`:

```sh
# /etc/default/haproxy
EXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/freighter/backends.cfg"
```

If the file already has an `EXTRAOPTS` line, add the `-f` option inside it. Elsewhere, add `-f /etc/haproxy/freighter/backends.cfg` to the `haproxy` command in its service file (`systemctl edit haproxy`), next to the existing `-f`.

**4. Add the lines** from [The lines to add](#the-lines-to-add) to your :80 and :443 frontends.

**5. Check, then reload.**

```sh
haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg
systemctl reload haproxy
```

A minimal `haproxy.cfg` for a server that only serves Freighter apps, with everything above in place:

```txt
global
    log /dev/log local0
    maxconn 2000
    ssl-default-bind-options ssl-min-ver TLSv1.2

defaults
    mode http
    log global
    timeout connect 5s
    timeout client  30s
    timeout server  30s

frontend http
    bind :80
    acl freighter_acme path_beg /.well-known/acme-challenge/
    http-request redirect scheme https code 301 if !{ ssl_fc } !freighter_acme { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/https.map) -m found }
    use_backend freighter_acme if freighter_acme
    use_backend freighter_challenge if { path_beg /.well-known/freighter-challenge }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }

frontend https
    bind :443 ssl crt /etc/haproxy/freighter/certs/
    use_backend freighter_challenge if { path_beg /.well-known/freighter-challenge }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }
```

### If your domains are behind a proxy or CDN

A proxy such as Cloudflare, Fastly or CloudFront in front of your domains needs **nothing more for verification** than the challenge rule in [The lines to add](#the-lines-to-add). That rule is what lets the dashboard confirm a proxied hostname reaches this server. The proxy's TLS mode, certificates and ports are covered in [Behind a proxy or CDN](/deploy/domains#behind-a-proxy-or-cdn).

What is left for HAProxy is the **visitor's address**: without it, logs and `X-Forwarded-For` show the proxy's. Add a rule that reads the real address from the proxy's header, at the top of both frontends, and only for connections that come from the proxy's published ranges (anyone else could forge the header):

```txt
    acl from_proxy src 203.0.113.0/24 198.51.100.0/24      # the proxy's published ranges
    http-request set-src req.hdr(X-Real-IP) if from_proxy { req.hdr(X-Real-IP) -m found }
```

Use the header your proxy documents. Behind **Cloudflare** this is built in: turn on **Behind Cloudflare's proxy** in the server's settings (or `haproxy.trustCloudflare: true` in `config.yaml`), then print the lines again:

```sh
freighter host haproxy setup
```

It now includes the two lines below at the top of each frontend, with Cloudflare's current ranges and the `CF-Connecting-IP` header:

```txt
    acl freighter_cloudflare src 173.245.48.0/20 103.21.244.0/22 …
    http-request set-src req.hdr(CF-Connecting-IP) if freighter_cloudflare { req.hdr(CF-Connecting-IP) -m found }
```

Copy the full `acl` line from the command's output, because the list of ranges is long and Cloudflare occasionally updates it. HAProxy rejects an `acl` name defined twice in the same frontend, so add each pair once. Both rules change the connection's source address, so `option forwardfor` and your logs then carry the visitor's address.

### After an upgrade

Upgrading Freighter on a server never changes your `haproxy.cfg`, so rules that a newer version needs are yours to add. Compare your frontends with what `freighter host haproxy setup` prints for that server's ports, and add whatever is missing:

```sh
freighter host haproxy setup
haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg && systemctl reload haproxy
```

You only find out you need to when something depends on a rule you don't have yet. Today that is a domain behind a proxy such as Cloudflare, which can't be verified without the challenge rule, and the verify error says so. Everything else keeps working. Freighter itself still updates `backends.cfg` during the upgrade, so the backends your lines refer to are always there.

The installer records which kind of HAProxy a server has in `/etc/haproxy/freighter/mode`: `existing` for yours, `dedicated` for one it set up. That is how an upgrade knows whether to rewrite the config (dedicated) or leave it alone (existing). If it's wrong, correct the file (`echo existing > /etc/haproxy/freighter/mode`). A server installed before this record existed is treated as `dedicated` only if `haproxy.mainConfig` is under `/etc/freighter/haproxy/`.

### Publish the dashboard

On the control server, route the dashboard's hostname to the API in your own config. It isn't a Freighter app, so it doesn't go in Freighter's maps.

```txt
frontend https
    bind :443 ssl crt /etc/haproxy/freighter/certs/ crt /etc/haproxy/certs/
    use_backend freighter_dashboard if { req.hdr(host),field(1,:),lower -m str freighter.example.com }
    # …the Freighter use_backend line from above…

backend freighter_dashboard
    server api 127.0.0.1:3000
```

Get its certificate with certbot through the same challenge backend Freighter uses, then combine it for HAProxy:

```sh
certbot certonly --standalone --http-01-port 8888 -d freighter.example.com -m ops@example.com --agree-tos -n
install -d -m 0700 /etc/haproxy/certs
cat /etc/letsencrypt/live/freighter.example.com/{fullchain,privkey}.pem > /etc/haproxy/certs/freighter.example.com.pem
systemctl reload haproxy
```

Add a certbot deploy hook that rebuilds that PEM and reloads HAProxy, so renewals take effect.

::: tip Keep the API on localhost
`api.trustProxy` is `true` by default. The API then takes the client address from `X-Forwarded-For` to rate-limit failed sign-ins, which is only safe while the API listens on `127.0.0.1` behind HAProxy.
:::

## How Freighter changes HAProxy

On a deploy that touches routing, Freighter writes the new maps and backends, validates the whole configuration with `haproxy -c -f <mainConfig> -f backends.cfg`, and reloads gracefully with `systemctl reload haproxy`. If validation fails, the previous files are restored and the deploy fails without changing anything that's live.

`freighter host haproxy sync` rebuilds the files from the recorded state and reloads if anything changed. Use it after editing your own config or restoring a backup.

## Run a dedicated HAProxy

For servers without HAProxy, or where its ports are taken. This HAProxy belongs to Freighter alone: its own config, its own systemd unit (`freighter-haproxy`), and it never reads or changes `/etc/haproxy/haproxy.cfg`. Another HAProxy on the same host keeps working.

Install the package, but don't let its stock service run:

```sh
apt-get install -y haproxy
systemctl disable --now haproxy
```

Choose the ports in `/etc/freighter/config.yaml`. The defaults are 80 and 443:

```yaml
haproxy:
  mainConfig: /etc/freighter/haproxy/haproxy.cfg
  reloadCommand: [systemctl, reload, freighter-haproxy]
  httpPort: 80
  httpsPort: 443
```

Create the files, generate the config and install the unit:

```sh
install -d /etc/freighter/haproxy /etc/haproxy/freighter/certs
touch /etc/haproxy/freighter/hostnames.map /etc/haproxy/freighter/https.map
printf '# Managed by freighter. Do not edit; regenerated on every deploy.\n\nbackend freighter_acme\n    server certbot 127.0.0.1:8888\n\nbackend freighter_challenge\n    http-request return status 200 content-type text/plain string "unset"\n' > /etc/haproxy/freighter/backends.cfg
echo dedicated > /etc/haproxy/freighter/mode
# then the placeholder certificate from step 2 of "Fully manual" above
freighter host haproxy config > /etc/freighter/haproxy/haproxy.cfg
cp /opt/freighter/infra/systemd/freighter-haproxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now freighter-haproxy
```

`freighter host haproxy config` prints a complete `haproxy.cfg` for the ports and options in `config.yaml`. Run it again after changing them, and `systemctl reload freighter-haproxy`.

## Choose the ports

Freighter's HAProxy needn't listen on 80 and 443. Set the ports in `config.yaml` (or `--http-port` and `--https-port` to the installer):

```yaml
haproxy:
  httpPort: 4080
  httpsPort: 4443
```

They apply to `freighter host haproxy config` (the dedicated setup) and to the lines `freighter host haproxy setup` prints (the shared setup). Everything else follows from them. [All the keys](/reference/config-yaml#haproxy)

## Behind your own reverse proxy

Run your own proxy (nginx, Caddy, Traefik, a cloud load balancer) on the public 80 and 443, and have it pass traffic on to Freighter's HAProxy on, say, 4080 and 4443. Freighter keeps doing what it does best: zero-downtime switching, health checks and rollback behind that single address.

Choose where TLS ends.

### Option A: your proxy passes TLS through

Freighter's HAProxy terminates TLS and Freighter gets the certificates (`tls: auto`). Your proxy forwards raw TCP on 443, and plain HTTP on 80, which Let's Encrypt needs:

```nginx
# nginx
stream {
    server {
        listen 443;
        proxy_pass 127.0.0.1:4443;
        proxy_protocol on;           # keeps the real client address; see below
    }
}
http {
    server {
        listen 80;
        location / {
            proxy_pass http://127.0.0.1:4080;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }
}
```

With `proxy_protocol on` HAProxy has to expect it, on both ports (an HTTP-level `location` on port 80 can't send it. If you use one, as above, use a TCP `stream` for port 80 too, or leave `acceptProxy` and `proxy_protocol` out and accept that apps see your proxy's address):

```yaml
haproxy:
  httpPort: 4080
  httpsPort: 4443
  publicHttpsPort: 443    # redirect http:// to https://host/, not https://host:4443/
  acceptProxy: true
```

Port 80 must reach `httpPort` from the Internet, or `tls: auto` can't issue certificates. Let's Encrypt only ever connects to port 80.

### Option B: your proxy terminates TLS

Your proxy holds the certificates and speaks plain HTTP to Freighter. Give every domain `tls: off`, because Freighter has nothing to issue or redirect.

```nginx
server {
    listen 443 ssl;
    server_name shop.example.com;
    ssl_certificate     /etc/ssl/shop.example.com.pem;
    ssl_certificate_key /etc/ssl/shop.example.com.key;
    location / {
        proxy_pass http://127.0.0.1:4080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;   # passed on to your app unchanged
    }
}
```

```txt
# Caddy, the same idea, with its own automatic certificates
shop.example.com {
    reverse_proxy 127.0.0.1:4080
}
```

Only `httpPort` is used. Freighter's HAProxy listens on all interfaces, so firewall 4080 and 4443 to your proxy's address if they shouldn't be reachable from outside.

### The dashboard

The dashboard and API listen on `127.0.0.1:3000`. Point a hostname at that from your proxy directly. It doesn't need to go through Freighter's HAProxy.
