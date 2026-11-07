# Connect HAProxy

Freighter doesn't take over HAProxy. If you already run one, your `haproxy.cfg` stays yours. If you don't, Freighter can run a separate HAProxy of its own and leave the system's alone. Pick the setup that matches your server:

| Your server | Setup | Where |
| --- | --- | --- |
| Already runs HAProxy (for other sites, say) | **Shared**: add a few lines to your config | [1. Print the lines to add](#_1-print-the-lines-to-add) onwards |
| Runs no HAProxy, or you want Freighter's separate | **Dedicated**: a Freighter-only HAProxy on ports you choose | [Run a dedicated HAProxy](#run-a-dedicated-haproxy) |
| Runs nginx, Caddy, Traefik or a cloud load balancer on 80/443 | **Dedicated**, on other ports, behind your proxy | [Behind your own reverse proxy](#behind-your-own-reverse-proxy) |

The installer script chooses for you: it uses the HAProxy it finds, and otherwise sets up a dedicated one (`--haproxy existing|dedicated` overrides). Freighter always needs *an* HAProxy. It's how it switches traffic between releases without dropping requests. The dedicated setup means it needn't be one you run yourself.

In every setup Freighter writes only these files, in `/etc/haproxy/freighter` (the `haproxy.dir` setting):

| File | Contents |
| --- | --- |
| `hostnames.map` | hostname to backend, one line per domain |
| `https.map` | hostnames that redirect from HTTP to HTTPS (`tls: auto`) |
| `backends.cfg` | one backend per routed service, plus `freighter_acme` for certificate challenges |
| `certs/<hostname>.pem` | certificate and key for each `tls: auto` domain |

You connect them once, on every server that will serve domains.

## Shared: add Freighter to your HAProxy

For servers that already run HAProxy.

### 1. Print the lines to add

```sh
freighter haproxy setup
```

It prints three changes for HAProxy 2.4 or later. With the default directory, they are:

```txt
# 1. Load the generated backends as an extra config file:  -f /etc/haproxy/freighter/backends.cfg

# 2. In the frontend on :80, before your other rules:
    acl freighter_acme path_beg /.well-known/acme-challenge/
    use_backend freighter_acme if freighter_acme
    http-request redirect scheme https code 301 if !{ ssl_fc } !freighter_acme { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/https.map) -m found }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }

# 3. In the frontend on :443:
    bind :443 ssl crt /etc/haproxy/freighter/certs/
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }
```

### 2. Load backends.cfg

On Debian and Ubuntu, HAProxy's unit reads extra options from `/etc/default/haproxy`:

```sh
# /etc/default/haproxy
EXTRAOPTS="-S /run/haproxy-master.sock -f /etc/haproxy/freighter/backends.cfg"
```

Create the directory and an empty backends file so HAProxy can start before the first deploy:

```sh
install -d /etc/haproxy/freighter/certs
touch /etc/haproxy/freighter/backends.cfg /etc/haproxy/freighter/hostnames.map /etc/haproxy/freighter/https.map
```

### 3. Add a placeholder certificate

HAProxy refuses to start when a `crt` directory is empty. Put a self-signed placeholder in it. It's never served for a real domain, because each domain gets its own certificate.

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=placeholder" \
  -keyout /tmp/p.key -out /tmp/p.crt
cat /tmp/p.crt /tmp/p.key > /etc/haproxy/freighter/certs/placeholder.pem
chmod 600 /etc/haproxy/freighter/certs/placeholder.pem
rm /tmp/p.key /tmp/p.crt
```

### 4. A complete example

A minimal `haproxy.cfg` for a server that only serves Freighter apps:

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
    use_backend freighter_acme if freighter_acme
    http-request redirect scheme https code 301 if !{ ssl_fc } !freighter_acme { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/https.map) -m found }
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }

frontend https
    bind :443 ssl crt /etc/haproxy/freighter/certs/
    use_backend %[req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map)] if { req.hdr(host),field(1,:),lower,map(/etc/haproxy/freighter/hostnames.map) -m found }
```

Check and reload:

```sh
haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg
systemctl reload haproxy
```

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

`freighter haproxy sync` rebuilds the files from the recorded state and reloads if anything changed. Use it after editing your own config or restoring a backup.

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
printf 'backend freighter_acme\n    server certbot 127.0.0.1:8888\n' > /etc/haproxy/freighter/backends.cfg
# then the placeholder certificate from step 3 above
freighter haproxy config > /etc/freighter/haproxy/haproxy.cfg
cp /opt/freighter/infra/systemd/freighter-haproxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now freighter-haproxy
```

`freighter haproxy config` prints a complete `haproxy.cfg` for the ports and options in `config.yaml`. Run it again after changing them, and `systemctl reload freighter-haproxy`.

## Choose the ports

Freighter's HAProxy needn't listen on 80 and 443. Set the ports in `config.yaml` (or `--http-port` and `--https-port` to the installer):

```yaml
haproxy:
  httpPort: 4080
  httpsPort: 4443
```

They apply to `freighter haproxy config` (the dedicated setup) and to the lines `freighter haproxy setup` prints (the shared setup). Everything else follows from them. [All the keys](/reference/config-yaml#haproxy)

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
