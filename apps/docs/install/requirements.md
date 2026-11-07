# Requirements

> In a hurry? [Install with the script](/install/script) on Debian or Ubuntu, or follow the manual pages.

## Servers

Any Linux distribution with **systemd** works. The commands in these docs assume Debian 12 or Ubuntu 22.04 and later, and that you have root.

| Needed on | Software | Why |
| --- | --- | --- |
| every server | **systemd** (with `systemd-run`) | runs every service and every build |
| every server | **Node.js 24** | runs the agent, and the CLI |
| every server | **HAProxy 2.4 or later** | routes domains to services, terminates TLS. Your own, or a separate one Freighter runs for itself |
| every server | `tar`, `gzip` | unpacks uploaded releases |
| servers with `tls: auto` domains | **certbot** | requests Let's Encrypt certificates (standalone mode) |
| servers that build from Git | **git**, **openssh-client** | fetches repositories |
| servers that build from Git | your toolchain (Node, pnpm, Python, Go…) | runs your `build.commands` |
| the control server | **pnpm** (through corepack) | installs Freighter from source |

Freighter creates the Unix users it needs: `freighter-build` for sandboxed builds, and one user per app.

A server that only runs workers and has no domains doesn't strictly need HAProxy or certbot. Install them anyway if the server might get a domain later.

### Sizing

Freighter itself is small: the agent and the API are each one Node process. Plan for your apps, with two things in mind:

- During a deploy, a routed service briefly runs **two releases side by side**, so its memory use doubles for a few seconds.
- Builds from Git run on the app's server and are limited to 2 GiB of memory and 2 CPUs by default (see [`build`](/reference/app-yaml#build)).

## Network

| Port | Open to | On | For |
| --- | --- | --- | --- |
| `80/tcp` | the Internet | servers with domains | HTTP, and Let's Encrypt HTTP-01 challenges |
| `443/tcp` | the Internet | servers with domains | HTTPS |

Those are the defaults. Freighter's HAProxy can listen on other ports (say 4080 and 4443) behind a reverse proxy of your own: see [Connect HAProxy](/install/haproxy#behind-your-own-reverse-proxy). Let's Encrypt still connects to public port 80, so that must reach Freighter.
| `7443/tcp` | **the control server's address only** | remote servers | the agent's mutual-TLS listener |

The API and dashboard listen on `127.0.0.1:3000` and are published through HAProxy. Outbound, servers that build from Git need to reach your Git host over SSH or HTTPS, and package registries during builds.

## DNS

- A name for the dashboard, for example `freighter.example.com`, pointing at the control server.
- For each app domain, an `A` (and `AAAA`, if you use IPv6) record pointing at the server the app runs on. Freighter shows the records to create when you add the domain, and checks them before it goes live.

## Your machine

Only a browser. The `freighter push` command for uploading from CI or a laptop needs Node 24 and a checkout of Freighter. A plain `curl` against the [API](/reference/api) works just as well.
