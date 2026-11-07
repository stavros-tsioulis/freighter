# Files and paths

Default locations. Most can be moved in [config.yaml](/reference/config-yaml).

## Every server

| Path | Owner | Contents |
| --- | --- | --- |
| `/etc/freighter/config.yaml` | root | host configuration |
| `/etc/freighter/apps/<app>.env` | root, `0600` | the app's secrets |
| `/etc/freighter/agent/` | root | `server.key`, `server.crt`, `ca.crt` (remote servers, after enrollment) |
| `/srv/apps/<app>/releases/<id>/` | root | one immutable release, including its `app.yaml` |
| `/srv/apps/<app>/current` | root | symlink to the live release |
| `/srv/apps/<app>/shared/` | the app's user | persistent data, the only place the app can write |
| `/srv/apps/<app>/history.jsonl` | root | append-only log of deploys and rollbacks on this server |
| `/srv/apps/<app>/state.json` | root | live routed instances: unit, port, hostnames |
| `/srv/apps/<app>/domains.json` | root | the app's domains |
| `/srv/apps/.lock` | root | held while a deploy or rollback runs |
| `/run/freighter/agent.sock` | root, group `freighter`, `0660` | the agent's local socket |
| `/var/lib/freighter/artifacts/` | root, group `freighter` | uploads waiting to be deployed |
| `/var/lib/freighter/git/<app>/` | root, `0600` | generated deploy key and `known_hosts` |
| `/var/lib/freighter-build/` | `freighter-build` | build checkouts, and package caches in `cache/<app>/` |
| `/etc/haproxy/freighter/` | root | `hostnames.map`, `https.map`, `backends.cfg`, `certs/<host>.pem` |
| `/etc/letsencrypt/` | root | certbot's certificates |
| `/etc/systemd/system/freighter-*.service` | root | generated app units |

## Control server only

| Path | Owner | Contents |
| --- | --- | --- |
| `/var/lib/freighter/registry.db` | `freighter` | SQLite registry: tokens (hashed), servers, deployments, metrics, Git links, SSH keys (encrypted), audit log |
| `/var/lib/freighter/secret.key` | `freighter`, `0600` | encrypts imported SSH keys. Back it up with the registry. |
| `/var/lib/freighter/pki/` | `freighter`, `0600` | private CA and the control plane's client certificate |
| `/opt/freighter/` | root | Freighter itself, installed from source |

## systemd units

| Unit | |
| --- | --- |
| `freighter-agent.service` | the agent (every server) |
| `freighter-api.service` | API and dashboard (control server) |
| `freighter-renew.timer`, `freighter-renew.service` | daily certificate renewal |
| `freighter-<app>--<service>.service` | an in-place service |
| `freighter-<app>--<service>--<release>.service` | one release of a routed service |
| transient `freighter-build` units | builds from Git, created with `systemd-run` |

## Names

| Thing | Format | Example |
| --- | --- | --- |
| app, service, server name | lowercase letters, digits, single hyphens, starting with a letter | `shop`, `web`, `vps-fra-1` |
| release id | `r` + UTC date and time, with `-2`, `-3`… on collision | `r20261107-142501` |
| backend in HAProxy | `be_<app>_<service>` | `be_shop_web` |
| API token | `fr_` + random | `fr_n5C…` |
| enrollment token | `fre_` + random, one hour, single use | `fre_…` |
