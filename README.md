# Freighter

Containerless, Compose-like deployment platform on systemd + HAProxy. Design: [docs/init.md](docs/init.md).

| Path | Package | Phase |
| --- | --- | --- |
| `packages/systemd` | `@freighter/systemd` | 1 unit generation |
| `packages/manifest` | `@freighter/manifest` | 2 `app.yaml` schema |
| `apps/cli` | `@freighter/cli` | 2–3 deploy CLI |
| `packages/core` | `@freighter/core` | 3 releases, health, rollback |
| `packages/haproxy` | `@freighter/haproxy` | 4 routing + TLS ([setup](packages/haproxy/README.md)) |
| `packages/api`, `packages/registry` | `@freighter/api`, `@freighter/registry` | 5 HTTP API + SQLite ([docs](packages/api/README.md)) |
| `apps/dashboard` | `@freighter/dashboard` | 6 web UI ([docs](apps/dashboard/README.md)) |
| `packages/protocol`, `apps/agent` | | 5 root agent over a unix socket; 7 the same agent over mutual TLS for remote servers ([docs](apps/agent/README.md)) |
| `packages/pki` | `@freighter/pki` | 7 private CA, agent enrollment, trust model ([docs](packages/pki/README.md)) |

## Usage (phases 2–7, run on the VPS as root)
```sh
freighter validate -f app.yaml
freighter deploy <dir|artifact.tar.gz> -f app.yaml [--dry-run]
freighter rollback <app> [release] | releases <app>
freighter status <app> | logs <app> <service> | start|stop|restart <app> [service]
freighter env set <app> KEY[=VALUE] | env list <app>
freighter haproxy setup | haproxy sync | certs renew [--force] | certs status
freighter ssh-key import|list|remove                            # SSH keys for private repositories (docs/git-deploys.md)
freighter git add|link|show|check|deploy|rotate-secret|unlink   # deploy from a Git repository over SSH
freighter token create|list|revoke | push <dir|tar.gz> --url U --token T [--server S]   # control plane (phase 5)
freighter push --image <ref> --name <app> | redeploy <app>   # deploy container images (needs Podman: install with --with-containers)
freighter registry add|list|remove                           # logins for private image registries
freighter server add|list|token|remove|check   # remote servers (phase 7)
freighter-agent enroll --control URL --token T --ca-fingerprint FP   # on a remote server
```
Add `--prefix <dir>` to any command to try it locally without root or systemd.

## Deploy from Git
Import an SSH key under Settings, point Freighter at a repository (`git@host:org/repo.git`), pick a branch and deploy. Pushes can build (in a sandbox on the app's server) and deploy automatically through a signed webhook, with the usual health check and rollback. Also ready-made GitHub Actions / GitLab CI pipelines if you would rather build in CI. See [docs/git-deploys.md](docs/git-deploys.md).

## Try it on clean servers
`pnpm lab:up` starts two Debian servers (systemd, HAProxy) in Docker with Freighter installed, so you can deploy, roll back, enroll a second server and click through the dashboard as on a fresh VPS. See [docker/README.md](docker/README.md).

## Development
```sh
pnpm install
pnpm typecheck && pnpm test
pnpm --filter @freighter/cli dev validate examples/app.yaml   # builds, then runs the built CLI with node
pnpm build   # compile everything (CLI, agent, dashboard); nothing runs TypeScript directly
pnpm dev   # dashboard
```
