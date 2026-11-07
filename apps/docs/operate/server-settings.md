# Server settings

**Server settings** in the dashboard (admins only) edits the everyday parts of a server's [`config.yaml`](/reference/config-yaml) without a shell: certificates, web ports, deploy limits, and the dashboard and API. Every server has its own settings. With more than one server, pick the server at the top right.

## What you can change

| Section | Settings |
| --- | --- |
| Certificates | Let's Encrypt email, staging mode, renewal window, challenge port |
| Web traffic | HTTP and HTTPS ports, the public HTTPS port for redirects, the PROXY protocol |
| Deploys | the service port range, drain time, largest upload, how unknown Git hosts are handled |
| Dashboard & API | public URL, public IPs, DNS servers for checks, proxy trust, upload limit, refresh and metrics intervals (the control server only) |

Each setting shows its default and a **Use default** link, which removes the entry from the file. Paths, sockets and the agent's TLS settings are not here: the installer and enrollment set them up, and a typo could lock you out. Edit `config.yaml` by hand for those.

## What saving does

- The new file is checked as a whole before anything is written. A value that doesn't fit (a port out of range, an invalid email, equal HTTP and HTTPS ports) is refused with the reason, and nothing changes.
- Your comments and any keys that aren't on this page are kept. The previous file is saved next to it as `config.yaml.bak`.
- Most settings are read when a service starts. After saving, a banner says which one needs a restart (the agent, or the dashboard and API) and offers **Restart now**. Running apps are not affected: they are ordinary systemd units.
- **HTTP and HTTPS ports** take effect at once on a Freighter-managed HAProxy (the *dedicated* setup, see [Connect HAProxy](/install/haproxy#run-a-dedicated-haproxy)): the config is rewritten, validated with `haproxy -c`, and reloaded. If you maintain your own `haproxy.cfg`, Freighter doesn't touch it. The page tells you to change its ports yourself.

Every save is recorded in the [audit log](/operate/access).

## Control servers without an agent

On a control server that [runs no apps itself](/install/control-server) (the default) there is no `local` server to show, and so no way to edit the dashboard and API settings from here. Edit `/etc/freighter/config.yaml` and restart `freighter-api`. Remote servers' settings work as usual.

## Remote servers

A remote server shows the settings that apply to it. The dashboard and API section is missing, because those run on the control server only. Changes go to that server's agent over the same mutual-TLS connection as everything else, so the server must be online.
