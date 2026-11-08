# Run the control server on Railway

The dashboard and API are a control plane: they hold the registry, the private CA and the API tokens, and they manage the [servers](/install/remote-server) that run your apps. That makes them a good fit for a platform like [Railway](https://railway.com), as long as your apps run on servers you enroll. Railway has no systemd, so nothing runs on the Railway service itself except the dashboard.

Everything below is done in Railway's web dashboard.

## What you need first

- The Freighter repository on GitHub (your fork or a copy), so Railway can build it.
- At least one [server for your apps](/install/remote-server), reachable from the Internet on port 7443. Railway can't reach a machine behind a firewall that only allows your office.

## 1. Create the service

1. **New Project**, then **Deploy from GitHub repo**, and choose the repository.
2. Open the new service, then **Variables**, and add:

   | Variable | Value |
   | --- | --- |
   | `RAILWAY_DOCKERFILE_PATH` | `docker/dashboard.Dockerfile` |
   | `FREIGHTER_BOOTSTRAP_TOKEN` | a secret you make up, see below |

   The Dockerfile pins Node.js 24, builds the dashboard and starts it. Railway sets `PORT` itself and the dashboard listens on it.

3. Make the secret on your own machine. It has to start with `fr_` and be at least 32 characters:
   ```sh
   echo "fr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
   ```
   Save it in a password manager. It's your first sign-in.

## 2. Add a volume

The registry database, the private CA (`pki/`) and the key that encrypts stored SSH keys live in `/var/lib/freighter`. Without a volume they vanish at every deploy, and every server would have to be enrolled again.

1. In the project canvas, add a **Volume** (right-click the canvas, or press <kbd>⌘K</kbd> and search "volume") and attach it to the service.
2. Set the mount path to `/var/lib/freighter`.

## 3. Settings

In the service's **Settings**:

- **Networking**: **Generate Domain**, or add your own domain. The address people use, and agents enroll against, comes from the requests Freighter receives, so no configuration is needed.
- **Deploy**: set the **healthcheck path** to `/api/health`, and keep **replicas at 1**. The registry is a SQLite file on the volume, and only one process may use it.

Deploy. The first build takes a few minutes. When it's running, the deploy logs show `created the admin token "bootstrap"`.

## 4. Sign in and secure it

1. Open the service's domain and paste your `FREIGHTER_BOOTSTRAP_TOKEN` on the sign-in page.
2. Under **API tokens**, create a token for yourself (and one for each person or CI job), then **revoke "bootstrap"**.
3. Delete the `FREIGHTER_BOOTSTRAP_TOKEN` variable. Freighter only reads it when no token has ever existed, so it can't come back, but there's no reason to keep a secret around.

## 5. Add your servers

**Servers**, then **Add server**. Give the address the dashboard should connect to (`vps1.example.com`), and run the command it shows on that machine, as in [Add a server](/install/remote-server#_2-register-the-server). The enrollment command contains your Railway domain, which the server must be able to reach over HTTPS.

Port 7443 on each server has to accept connections from Railway. Railway's outbound addresses aren't fixed, so you can't restrict it to one IP. That is safe by design: the agent only answers clients that present a certificate signed by your private CA, and refuses everyone else. See the [security model](/operate/security). If you'd rather restrict it, use Railway's static outbound IPs, if your plan has them.

## Good to know

- **Settings.** There's no `/etc/freighter/config.yaml` and no agent. The control server's own settings (public URL, DNS servers for domain checks, upload limit and so on) are edited under **Settings → Server → Control server**, or fixed with variables such as `FREIGHTER_API_DNS_SERVERS`. See [Server settings](/operate/server-settings#the-control-server-s-own-settings). Each server you enroll keeps its own settings, which you edit on the same page.
- **Domain checks.** Domains are verified by looking up their DNS records from the control server. If Railway doesn't let it reach public resolvers directly, Freighter falls back to the platform's resolver by itself, and says so when a lookup can't be made.
- **Updating.** Push to the branch Railway watches, or redeploy from the dashboard. The volume keeps your data.
- **Backups.** Take a snapshot of the volume, or back up `/var/lib/freighter`, before upgrades. Losing `pki/` means re-enrolling every server.
- **Other container hosts.** The same Dockerfile works anywhere that runs containers: mount `/var/lib/freighter`, set `PORT` and `FREIGHTER_BOOTSTRAP_TOKEN`.
