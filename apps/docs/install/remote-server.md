# Add a server

A server for your apps runs `freighter-agent` and your apps, but not the dashboard or API, which stay on the control server. The control server manages it over mutual TLS: each side proves who it is with a certificate from the control server's private CA. Enrollment is a one-time step per server.

## 1. Prepare the server

::: tip
The script does steps 1 to 4 below in one go (and prepares the HAProxy directories from step 5): `curl -fsSL …/install.sh | sudo sh -s -- --role agent`. See [Install with the script](/install/script).
:::

On the new server, as root:

1. Install packages and Node.js 24. HAProxy and certbot are needed if apps on this server will have domains:
   ```sh
   apt-get update
   apt-get install -y haproxy certbot git openssh-client tar gzip curl ca-certificates openssl
   node --version    # v24.x, from nodejs.org or your distribution
   ```
2. Install Freighter. You don't need the dashboard build:
   ```sh
   git clone https://github.com/stavros-tsioulis/freighter.git /opt/freighter
   cd /opt/freighter
   corepack enable
   pnpm install --frozen-lockfile
   pnpm --filter @freighter/cli --filter @freighter/agent build
   ```
   Everything is compiled to plain JavaScript and run with `node`. Add the launchers:
   ```sh
   cat > /usr/local/bin/freighter <<'EOF'
   #!/bin/sh
   [ -x "$PWD" ] && [ -r "$PWD" ] || cd /
   exec node --enable-source-maps /opt/freighter/apps/cli/dist/cli.js "$@"
   EOF

   cat > /usr/local/bin/freighter-agent <<'EOF'
   #!/bin/sh
   [ -x "$PWD" ] && [ -r "$PWD" ] || cd /
   exec node --enable-source-maps /opt/freighter/apps/agent/dist/main.js "$@"
   EOF

   chmod +x /usr/local/bin/freighter /usr/local/bin/freighter-agent
   ```
3. Create the group the agent hands its socket to (skip `groupadd` on a control server that already has the `freighter` user), and the directories:
   ```sh
   groupadd --system freighter
   install -d -m 0755 /srv/apps /etc/freighter/apps /etc/freighter/agent
   install -d -m 0750 -g freighter /var/lib/freighter /var/lib/freighter/artifacts
   ```
4. Install the services: the agent, and daily certificate renewal.
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
   ```sh
   systemctl daemon-reload
   systemctl enable --now freighter-agent freighter-renew.timer
   ```
5. [Connect HAProxy](/install/haproxy) (yours, or a dedicated one for Freighter), and set `acme.email` in `/etc/freighter/config.yaml` if apps here will use `tls: auto`.
6. Open port `7443/tcp` to the control server's address only, for example:
   ```sh
   ufw allow from 198.51.100.10 to any port 7443 proto tcp
   ```

## 2. Register the server

On the control server, from the dashboard: **Servers**, then **Add server**. Give it a name (`vps-fra-1`: lowercase, digits, hyphens, and not `local`) and the address the control server should connect to (`vps1.example.com` or `203.0.113.7`, with `:port` if not 7443).

Or from the CLI, as the `freighter` user:

```sh
sudo -u freighter freighter server add vps-fra-1 --address vps1.example.com --control https://freighter.example.com
```

Either way you get a command to run on the new server. It's shown once, and its token expires after one hour.

## 3. Enroll

On the new server, as root:

```sh
freighter-agent enroll --control https://freighter.example.com --token fre_… --ca-fingerprint SHA256:…
systemctl restart freighter-agent
```

`enroll` creates the server's private key and a certificate request locally, so the key never leaves the machine. It sends the request with the token and checks that the CA it gets back matches the fingerprint you pinned. Only then does it write `server.key`, `server.crt` and `ca.crt` to `/etc/freighter/agent` and turn on `agent.remote` in `/etc/freighter/config.yaml`. If the fingerprint doesn't match, nothing is written.

After the restart, the agent also listens on `:7443`. Within a minute the server shows as **Online** on the Servers page, with its hostname, load, memory, disk and agent version. Press **Check now** to contact it immediately.

## 4. Deploy to it

Choose the server when you create an app: the **Server** field in *Deploy from Git* or *Upload archive* (shown once you have more than one server), `--server vps-fra-1` with `freighter push` and `freighter git add`, or `?server=vps-fra-1` on the API. The app stays on that server for good.

Builds from Git run on the app's server, so install the build toolchain there.

## Certificates and renewal

Agent certificates last one year. The Servers page shows the days left and warns under 30. To renew, press **Re-enroll** on the server (or run `freighter server token vps-fra-1`), run the new `freighter-agent enroll …` command on the server, and restart the agent.

## Removing a server

A server can be removed once no apps are pinned to it: **Servers**, the trash icon, or `freighter server remove vps-fra-1`. The control server forgets it, and its certificate becomes useless without the control server's client key. The agent keeps running until you stop it, so stop and disable `freighter-agent` and close port 7443.

## When a server is unreachable

Each server is checked on its own. If one goes offline, only that server's apps become unavailable to manage. Deploys elsewhere continue, and the apps on it keep running under systemd.
