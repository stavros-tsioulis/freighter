# Add a remote server

A remote server runs only `freighter-agent`. The control server manages it over mutual TLS: each side proves who it is with a certificate from the control server's private CA. Enrollment is a one-time step per server.

## 1. Prepare the server

::: tip
The script does steps 1 to 4 below in one go (and prepares the HAProxy directories from step 5): `curl -fsSL …/install.sh | sudo sh -s -- --role agent`. See [Install with the script](/install/script).
:::

On the new server, as root, follow the control server steps that apply to an agent:

1. [Install system packages](/install/control-server#_1-install-system-packages), including Node 24. HAProxy and certbot are needed if apps on this server will have domains.
2. [Install Freighter](/install/control-server#_2-install-freighter). You can skip the dashboard build, and only the `freighter-agent` and `freighter` launchers are needed.
3. Create the group the agent hands its socket to, and the directories:
   ```sh
   groupadd --system freighter
   install -d -m 0755 /srv/apps /etc/freighter/apps /etc/freighter/agent
   install -d -m 0750 /var/lib/freighter /var/lib/freighter/artifacts
   ```
4. Install and enable `freighter-agent.service` and `freighter-renew.timer` from the [control server page](/install/control-server#_5-install-the-services). Don't install `freighter-api.service`.
5. [Connect HAProxy](/install/haproxy), and set `acme.email` in `/etc/freighter/config.yaml` if apps here will use `tls: auto`.
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
