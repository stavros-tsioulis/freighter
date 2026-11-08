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

## Upgrading a server

A remote server runs the agent and CLI from a git checkout the installer made (`/opt/freighter`). To bring it to the version the control server runs, press **Upgrade** on the Servers page (it is highlighted, with *update available* next to the agent version, when the server is behind), or run this on the control server:

```sh
sudo -u freighter freighter server upgrade vps-fra-1            # to the version this control server runs
sudo -u freighter freighter server upgrade vps-fra-1 --ref v1.4.0   # a branch, tag or commit instead (a commit may be abbreviated: the server finds it in its branches' recent history)
```

The version is the git commit the control server runs, found from its checkout. A control server that runs from a container image has no checkout (on Railway, for instance), so set `FREIGHTER_COMMIT` to the commit it was built from (Railway's `RAILWAY_GIT_COMMIT_SHA` is picked up automatically), or give the version yourself with `--ref` or "Upgrade to a different version". Without either, Freighter can't tell what "the same version" is and asks you to choose.

To see whether anything is newer *before* upgrading, press **Check for updates** on the server's page (select its name on the Servers page). The server runs git against its own repository and lists the new commits, which also tells you early if it has no network access to it.

The control server upgrades first, then its servers: an agent is meant to be at the same version as the control plane it answers to.

What happens, all on the server:

1. The agent backs up what an upgrade replaces: the built agent and CLI, the `freighter-*` systemd units, and a Freighter-managed `haproxy.cfg`.
2. It fetches the version and runs *that version's* installer (`install.sh --role agent`), the same code as a fresh install. It installs, builds and restarts the agent, so the server needs internet access and takes a few minutes. Your `config.yaml`, certificates and apps are left alone, and apps keep running.
3. The new agent waits for the control server to reach it over mutual TLS and confirm. The Servers page and the CLI do this automatically while they watch the upgrade, and the periodic sync does it otherwise.
4. If the installer fails, or no confirmation arrives within 3 minutes of the install finishing, the server puts the backup back (nothing is rebuilt) and restarts the old agent. The Servers page then says *Rolled back* with the reason and the log.

The upgrade runs as its own systemd unit (`freighter-upgrade`), so it carries on while the agent restarts, and survives the control server or your browser going away. Its state and log are in `/var/lib/freighter/upgrade/` (`state`, `message`, `log`). HAProxy is restarted once near the end, which is a brief blip for traffic. Don't deploy to the server while it upgrades, because a restart of the agent interrupts a deployment that is running.

**Whose HAProxy it is.** The installer records whether it set up a HAProxy of its own for Freighter (*dedicated*) or wired into one you already ran (*existing*), in `/etc/haproxy/freighter/mode`. It sticks across upgrades and re-runs of the installer. With a dedicated HAProxy, Freighter owns `haproxy.cfg` and an upgrade rewrites it. With your own, Freighter never edits it, so after an upgrade compare your frontends with `freighter haproxy setup` ([After an upgrade](/install/haproxy#after-an-upgrade)). Servers installed before the record existed are told apart by where their `haproxy.cfg` lives.

**Servers installed before this feature** can't upgrade themselves, because their agent doesn't know how. Run the installer on them once, as in step 1 (`curl … | sudo sh -s -- --role agent`). From then on **Upgrade** works. The same goes for a server that wasn't installed with the script, since it has no checkout to upgrade.

## Removing a server

A server can be removed once no apps are pinned to it: **Servers**, the trash icon, or `freighter server remove vps-fra-1`. The control server forgets it, and its certificate becomes useless without the control server's client key. The agent keeps running until you stop it, so stop and disable `freighter-agent` and close port 7443.

## When a server is unreachable

Each server is checked on its own. If one goes offline, only that server's apps become unavailable to manage. Deploys elsewhere continue, and the apps on it keep running under systemd.
