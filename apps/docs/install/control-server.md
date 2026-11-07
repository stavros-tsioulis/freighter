# Set up the control server

The control server runs the API and the dashboard, and manages your [servers](/install/remote-server). By default it runs no apps of its own and no agent: it needs only Node and Freighter, with no HAProxy, certbot or root service. The servers that run your apps are separate machines, added later. If you want this machine to host apps too, see [Also run apps on this server](#also-run-apps-on-this-server).

Run everything on this page as root.

::: tip Prefer one command?
[Install with the script](/install/script) does all of this for you. The steps below are what it runs, for when you want to see or control each one.
:::

## 1. Install system packages

```sh
apt-get update
apt-get install -y git curl ca-certificates tar gzip openssl
```

Install Node.js 24 from [nodejs.org](https://nodejs.org) or your distribution's Node 24 packages, then check:

```sh
node --version    # v24.x
```

## 2. Install Freighter

Freighter is installed from source into `/opt/freighter`:

```sh
git clone https://github.com/stavros-tsioulis/freighter.git /opt/freighter
cd /opt/freighter
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @freighter/dashboard build
```

Add a small launcher for the `freighter` command to `/usr/local/bin`:

```sh
cat > /usr/local/bin/freighter <<'EOF'
#!/bin/sh
[ -x "$PWD" ] && [ -r "$PWD" ] || cd /
exec /opt/freighter/node_modules/.bin/tsx /opt/freighter/apps/cli/src/cli.ts "$@"
EOF

chmod +x /usr/local/bin/freighter
freighter --help
```

## 3. Create the user and directories

The API runs as the unprivileged `freighter` user. Uploads wait in `/var/lib/freighter/artifacts` on their way to a server.

```sh
useradd --system --home-dir /var/lib/freighter --shell /usr/sbin/nologin freighter
install -d -o freighter -g freighter -m 0755 /var/lib/freighter
install -d -o freighter -g freighter -m 0750 /var/lib/freighter/artifacts
install -d -m 0755 /etc/freighter
```

## 4. Write the configuration

Every key in `/etc/freighter/config.yaml` is optional. The ones you'll usually set on a control server:

```yaml
# /etc/freighter/config.yaml
api:
  localAgent: false                          # the default: this server runs no apps, it manages other servers
  publicUrl: https://freighter.example.com   # used in webhook and enrollment URLs
```

All other keys and their defaults are listed in the [config.yaml reference](/reference/config-yaml). Each server you add has its own `config.yaml`.

## 5. Install the service

```ini
# /etc/systemd/system/freighter-api.service
[Unit]
Description=Freighter API and dashboard
After=network-online.target

[Service]
Type=simple
User=freighter
Group=freighter
WorkingDirectory=/opt/freighter/apps/dashboard
ExecStart=/usr/bin/node .output/server/index.mjs
Environment=NITRO_HOST=127.0.0.1
Environment=NITRO_PORT=3000
Restart=on-failure
RestartSec=2
StateDirectory=freighter
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Adjust `ExecStart` if `node` lives elsewhere (`command -v node`). Then start it:

```sh
systemctl daemon-reload
systemctl enable --now freighter-api
systemctl status freighter-api
curl -s http://127.0.0.1:3000/api/health
```

## 6. Publish the dashboard

The dashboard listens on `127.0.0.1:3000`. Put your own reverse proxy in front of it, with HTTPS. For example, with Caddy (certificates are automatic):

```txt
freighter.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

or nginx:

```nginx
server {
    listen 443 ssl;
    server_name freighter.example.com;
    ssl_certificate     /etc/ssl/freighter.example.com.pem;
    ssl_certificate_key /etc/ssl/freighter.example.com.key;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        client_max_body_size 200m;   # as large as api.maxUploadMb
    }
}
```

Remote servers reach the control server's address (`api.publicUrl`) to enroll, so it must be reachable from them. Serve it over HTTPS only. See [Security model](/operate/security).

## 7. Create the first admin token

Tokens are created against the registry database, which belongs to the `freighter` user:

```sh
sudo -u freighter freighter token create --name you --role admin
```

The token (`fr_…`) is printed once. Open the dashboard, paste it on the sign-in page, and you're in. Create separate tokens for each person and each CI pipeline from **API tokens** in the dashboard. See [Users and tokens](/operate/access).

## Next

- [Add a server](/install/remote-server) to run apps on. Until you do, there is nowhere to deploy.
- [Deploy your first app](/deploy/first-app).

## Also run apps on this server

The control server can host apps like any other server. It then runs an agent too, and the dashboard shows it as the server `local`.

1. Do the [server preparation](/install/remote-server#_1-prepare-the-server) on this machine: packages (HAProxy, certbot, `git`, `openssh-client`), the `freighter-agent` launcher, the agent and renewal services, and [HAProxy](/install/haproxy). You don't need to open port 7443 or enroll: `local` talks to its agent over a unix socket.
2. Let the agent read the upload spool:
   ```sh
   install -d -o root -g freighter -m 0770 /var/lib/freighter/artifacts
   ```
3. Turn it on and restart the API:
   ```yaml
   # /etc/freighter/config.yaml
   api:
     localAgent: true
   ```
   ```sh
   systemctl restart freighter-api
   ```

With the script, `--with-agent` does all of this. To go back, set `localAgent: false`. `local` disappears once no app or deployment history points at it.

## Upgrading

Pull the new version, reinstall dependencies, rebuild the dashboard and restart both services:

```sh
cd /opt/freighter
git pull
pnpm install --frozen-lockfile
pnpm --filter @freighter/dashboard build
systemctl restart freighter-agent freighter-api
```

Running apps aren't affected by restarting Freighter: they are ordinary systemd units. If the API stops while a deployment is queued or running, that deployment is marked failed when the API starts again. Deploy again.
