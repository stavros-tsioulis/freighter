# Set up the control server

The control server runs the agent, the API and the dashboard. It can also run apps of its own: its agent is the server called `local`.

Run everything on this page as root.

::: tip Prefer one command?
[Install with the script](/install/script) does all of this for you. The steps below are what it runs, for when you want to see or control each one.
:::

## 1. Install system packages

```sh
apt-get update
apt-get install -y haproxy certbot git openssh-client tar gzip curl ca-certificates
```

Install Node.js 24 from [nodejs.org](https://nodejs.org) or your distribution's Node 24 packages, then check:

```sh
node --version    # v24.x
haproxy -v        # 2.4 or later
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

Add two small launchers to `/usr/local/bin`:

```sh
cat > /usr/local/bin/freighter <<'EOF'
#!/bin/sh
[ -x "$PWD" ] && [ -r "$PWD" ] || cd /
exec /opt/freighter/node_modules/.bin/tsx /opt/freighter/apps/cli/src/cli.ts "$@"
EOF

cat > /usr/local/bin/freighter-agent <<'EOF'
#!/bin/sh
[ -x "$PWD" ] && [ -r "$PWD" ] || cd /
exec /opt/freighter/node_modules/.bin/tsx /opt/freighter/apps/agent/src/main.ts "$@"
EOF

chmod +x /usr/local/bin/freighter /usr/local/bin/freighter-agent
freighter --help
```

## 3. Create the user and directories

The API runs as the unprivileged `freighter` user. The agent runs as root and lets members of the `freighter` group use its socket.

```sh
useradd --system --home-dir /var/lib/freighter --shell /usr/sbin/nologin freighter
install -d -o freighter -g freighter -m 0755 /var/lib/freighter
install -d -o root -g freighter -m 0770 /var/lib/freighter/artifacts
install -d -m 0755 /srv/apps /etc/freighter/apps /etc/freighter/agent
```

## 4. Write the configuration

Every key in `/etc/freighter/config.yaml` is optional. These are the ones you'll usually set on a control server:

```yaml
# /etc/freighter/config.yaml
acme:
  email: ops@example.com                     # required before any domain uses tls: auto
api:
  publicUrl: https://freighter.example.com   # used in webhook and enrollment URLs
  publicIps: [203.0.113.7]                   # this server's public IP, shown as the DNS target for domains
```

All other keys and their defaults are listed in the [config.yaml reference](/reference/config-yaml).

## 5. Install the services

```ini
# /etc/systemd/system/freighter-agent.service
[Unit]
Description=Freighter agent (privileged helper)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/freighter-agent
Restart=on-failure
RestartSec=2
RuntimeDirectory=freighter
RuntimeDirectoryMode=0750
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/freighter-api.service
[Unit]
Description=Freighter API and dashboard
After=freighter-agent.service
Wants=freighter-agent.service

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

Adjust `ExecStart` if `node` lives elsewhere (`command -v node`). Then add daily certificate renewal:

```ini
# /etc/systemd/system/freighter-renew.service
[Unit]
Description=Renew Freighter TLS certificates
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freighter certs renew
```

```ini
# /etc/systemd/system/freighter-renew.timer
[Unit]
Description=Daily Freighter certificate renewal

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

Start everything:

```sh
systemctl daemon-reload
systemctl enable --now freighter-agent freighter-api freighter-renew.timer
systemctl status freighter-agent freighter-api
curl -s http://127.0.0.1:3000/api/health
```

## 6. Connect HAProxy

Freighter needs HAProxy to route app domains. If you already run one, a few lines go in its config. If you don't, Freighter can run its own, on the ports you choose, behind your own reverse proxy if you have one. Follow [Connect HAProxy](/install/haproxy) now. The same page shows how to publish the dashboard on `https://freighter.example.com`.

## 7. Create the first admin token

Tokens are created against the registry database, which belongs to the `freighter` user:

```sh
sudo -u freighter freighter token create --name you --role admin
```

The token (`fr_…`) is printed once. Open the dashboard, paste it on the sign-in page, and you're in. Create separate tokens for each person and each CI pipeline from **API tokens** in the dashboard. See [Users and tokens](/operate/access).

## Next

- [Deploy your first app](/deploy/first-app).
- [Add a remote server](/install/remote-server).

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
