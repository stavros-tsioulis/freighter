# Install with the script

One command installs everything on a fresh Debian or Ubuntu server: system packages, Node.js 24, the `freighter` user and directories, Freighter itself, and the systemd services. On a server that runs apps it also prepares HAProxy. It does what [Set up the control server](/install/control-server) does by hand, and you can use either.

Check the [requirements](/install/requirements) first, then run it as root.

## Control server

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh \
  | sudo sh -s -- --public-url https://freighter.example.com
```

This installs the API and dashboard only. The control server manages other servers and runs no apps, agent, HAProxy or certbot itself. Add `--with-agent` if it should also run apps (then also pass `--email` for certificates).

## Server for your apps

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh \
  | sudo sh -s -- --role agent --email ops@example.com
```

Then [register and enroll it](/install/remote-server#_2-register-the-server) from the control server.

## Read it before you run it

Piping a script into a root shell is a leap of faith. Download it, read it, then run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh
less install.sh
sudo sh install.sh --dry-run    # prints every step, changes nothing
sudo sh install.sh --public-url https://freighter.example.com
```

The script is plain POSIX `sh`. The whole body is wrapped in functions and called on the last line, so a truncated download runs nothing.

## Options

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--role control\|agent` | `FREIGHTER_ROLE` | `control` | `control` installs the API and dashboard; `agent` installs a server that runs apps |
| `--ref <ref>` | `FREIGHTER_REF` | `main` | Branch, tag or commit to install |
| `--from <dir>` | `FREIGHTER_FROM` | | Install from a local checkout instead of cloning |
| `--dir <dir>` | `FREIGHTER_DIR` | `/opt/freighter` | Install location |
| `--email <addr>` | `FREIGHTER_ACME_EMAIL` | | Let's Encrypt contact, written to `acme.email` |
| `--public-url <url>` | `FREIGHTER_PUBLIC_URL` | | The dashboard's URL, written to `api.publicUrl` (control only) |
| `--with-agent` | `FREIGHTER_WITH_AGENT=1` | | Control role only: also run apps on this machine, through an agent of its own (and HAProxy, certbot). By default a control server only manages remote servers |
| `--with-containers` | `FREIGHTER_WITH_CONTAINERS=1` | | Servers that run apps: also install Podman, so apps can be [deployed as images](/deploy/images). Upgrades keep it |
| `--haproxy auto\|dedicated\|existing` | `FREIGHTER_HAPROXY` | `auto` | Which HAProxy to use. `auto` uses the one already on the server, else sets up a dedicated one |
| `--http-port <n>` | `FREIGHTER_HTTP_PORT` | `80` | The port HAProxy listens on for HTTP |
| `--https-port <n>` | `FREIGHTER_HTTPS_PORT` | `443` | The port HAProxy listens on for HTTPS |
| `--public-https-port <n>` | `FREIGHTER_PUBLIC_HTTPS_PORT` | `--https-port` | The HTTPS port clients are redirected to. Use `443` when your proxy maps 443 to `--https-port` |
| `--accept-proxy` | | | Expect the PROXY protocol on both ports |
| `--node-version <n>` | `FREIGHTER_NODE_MAJOR` | `24` | Node.js major version |
| `--no-start` | | | Install, but don't enable or start services |
| `--dry-run` | | | Print what would happen, change nothing |

## What it does

1. **Checks the machine**: Linux, root, systemd as PID 1, x86_64 or arm64, Debian or Ubuntu.
2. **Installs packages** with `apt`: `git`, `openssl` and the basics, plus `openssh-client`, `haproxy` and `certbot` on a server that runs apps.
3. **Installs Node.js** from nodejs.org, verified against its published SHA-256, into `/opt/node-<version>` with links in `/usr/local/bin`. It skips this when Node of the right version is already there.
4. **Creates** the `freighter` user and group, `/var/lib/freighter` and `/etc/freighter`, plus `/srv/apps` on a server that runs apps.
5. **Installs Freighter** into `/opt/freighter`, runs `pnpm install`, builds the dashboard on a control server, and writes the `freighter` launcher (and `freighter-agent` where there is an agent).
6. **Prepares HAProxy**, on servers that run apps, in one of two ways (see [below](#without-haproxy-or-behind-your-own-proxy)):
   - *existing*: `/etc/haproxy/freighter`, a placeholder certificate, and `EXTRAOPTS` in `/etc/default/haproxy`, so the HAProxy you run loads Freighter's routes.
   - *dedicated*: the same files, plus a complete config and a `freighter-haproxy` service of Freighter's own.
7. **Writes `/etc/freighter/config.yaml`** and the systemd units, then enables and starts them. It waits for the agent socket (if there is an agent) and the dashboard before reporting success.

Command output goes to `/var/log/freighter-install.log`. The terminal shows one line per step, and the tail of the log if a step fails.

## Without HAProxy, or behind your own proxy

This applies to servers that run apps. A default control server needs no HAProxy at all.

Freighter needs an HAProxy on those, but it doesn't have to be yours.

- **A server that already runs HAProxy**: the installer finds it and wires Freighter in (`existing`), without touching your `haproxy.cfg`.
- **A server with no HAProxy**: the installer sets up a dedicated one (`dedicated`) that serves only Freighter's apps. The system's `haproxy.service` stays off, and nothing else on the host is affected.
- **A server where your own proxy owns ports 80 and 443**: use the dedicated one on other ports, and pass traffic to it:

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh \
  | sudo sh -s -- --haproxy dedicated --http-port 4080 --https-port 4443 --public-https-port 443
```

The installer checks that the ports are free before it starts. The proxy configurations are in [Behind your own reverse proxy](/install/haproxy#behind-your-own-reverse-proxy).

## Safe to re-run

Every step checks first. Running the script again upgrades Freighter in place and skips what's already done. It never overwrites your `haproxy.cfg` or an existing `config.yaml`. If `/etc/default/haproxy` already sets `EXTRAOPTS`, it tells you to add `-f /etc/haproxy/freighter/backends.cfg` yourself.

## After it finishes

On a control server:

1. [Create the first admin token](/install/control-server#_7-create-the-first-admin-token).
2. [Publish the dashboard](/install/control-server#_6-publish-the-dashboard) (`127.0.0.1:3000`) through your reverse proxy, with HTTPS.
3. [Add the servers](/install/remote-server) that will run your apps.

On a server for apps, the script doesn't edit your `haproxy.cfg`: with an `existing` HAProxy, [connect it](/install/haproxy). A `dedicated` one is already connected.

To upgrade later, run the script again.
