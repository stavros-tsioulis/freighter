# Server settings

**Server settings** in the dashboard (admins only) edits the everyday parts of the configuration without a shell: certificates, web ports and deploy limits (per server, in its [`config.yaml`](/reference/config-yaml)), and the dashboard and API (on the control server itself). Pick what to edit at the top right: **Control server**, or one of your servers.

## What you can change

| Section | Settings |
| --- | --- |
| Certificates | Let's Encrypt email, staging mode, renewal window, challenge port |
| Web traffic | HTTP and HTTPS ports, the public HTTPS port for redirects, the PROXY protocol |
| Deploys | the service port range, drain time, largest upload, how unknown Git hosts are handled |
| Dashboard & API | public URL, public IPs, DNS servers for checks, proxy trust, upload limit, refresh and metrics intervals (choose **Control server**) |

Each setting shows its default and a **Use default** link, which removes the entry from the file. Paths, sockets and the agent's TLS settings are not here: the installer and enrollment set them up, and a typo could lock you out. Edit `config.yaml` by hand for those.

## What saving does

- The new file is checked as a whole before anything is written. A value that doesn't fit (a port out of range, an invalid email, equal HTTP and HTTPS ports) is refused with the reason, and nothing changes.
- Your comments and any keys that aren't on this page are kept. The previous file is saved next to it as `config.yaml.bak`.
- Most settings are read when a service starts. After saving, a banner says which one needs a restart (the agent, or the dashboard and API) and offers **Restart now**. Running apps are not affected: they are ordinary systemd units.
- **HTTP and HTTPS ports** take effect at once on a Freighter-managed HAProxy (the *dedicated* setup, see [Connect HAProxy](/install/haproxy#run-a-dedicated-haproxy)): the config is rewritten, validated with `haproxy -c`, and reloaded. If you maintain your own `haproxy.cfg`, Freighter doesn't touch it. The page tells you to change its ports yourself.

Every save is recorded in the [audit log](/operate/access).

## The control server's own settings

The **Control server** entry edits the dashboard and API settings. They need no agent and no root, so this works on a control server that [runs no apps itself](/install/control-server) (the default), and on [Railway](/install/railway) or any container, where there is no `config.yaml`.

They are saved in the registry database and take effect at once, with no restart. Where a value comes from, highest first:

1. **An environment variable**, named after the setting: `api.dnsServers` is `FREIGHTER_API_DNS_SERVERS`, `api.publicUrl` is `FREIGHTER_API_PUBLIC_URL`, `api.maxUploadMb` is `FREIGHTER_API_MAX_UPLOAD_MB`, and so on. Lists take comma-separated values (empty means none), booleans take `true` or `false`. A setting fixed this way shows as locked in the dashboard: change or remove the variable instead. On Railway, this is the **Variables** tab.
2. **A value saved in the dashboard.** **Use default** forgets it.
3. **`config.yaml`**, if the control server has one. It is read when the API starts and never edited by this page.
4. The default.

## Remote servers

A remote server shows the settings that apply to it. The dashboard and API section is missing: those belong to the control server. Changes go to that server's agent over the same mutual-TLS connection as everything else, so the server must be online.
