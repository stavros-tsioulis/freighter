# app.yaml

`app.yaml` describes one app. It sits at the root of an uploaded archive, or in the repository (at the subdirectory you chose) for Git deploys. Check one with `freighter validate -f app.yaml`.

## Complete example

```yaml
name: shop

build:
  commands:
    - pnpm install --frozen-lockfile
    - pnpm build
  timeout: 15m
  memory: 2G
  cpu: 2

services:
  web:
    command: node .output/server/index.mjs
    port: 3100
    resources:
      memory: 256M
      cpu: 0.8
    healthcheck:
      path: /health
      timeout: 30s
    restart: on-failure
  worker:
    command: node dist/worker.js
    resources:
      memory: 128M

environment:
  NODE_ENV: production

secrets:
  - DATABASE_URL
  - SESSION_SECRET

releases:
  keep: 5
```

## Top level

| Field | Type | Default | |
| --- | --- | --- | --- |
| `name` | identifier | required | The app's name: lowercase letters, digits and single hyphens, starting with a letter. It must match the app you deploy to. |
| `services` | map of identifier to [service](#services) | required | The app's processes. |
| `build` | [build](#build) | none | Commands that run before deploying, for Git deploys. |
| `environment` | map of `UPPER_SNAKE_CASE` to string | `{}` | Plain environment values for every service. |
| `secrets` | list of `UPPER_SNAKE_CASE` | `[]` | Names that must have a value (set separately) before a deploy. See [secrets](/deploy/secrets). |
| `releases.keep` | integer, 2 or more | `5` | How many releases to keep on disk. The current and previous ones are always kept. |
| `source` | object | none | `type: git`, `repository`, `branch` (default `main`). Accepted for documentation only: the repository link set in Freighter is what's used. |

A name can't be in both `environment` and `secrets`. `domains:` isn't allowed: domains are set on the app. See [Domains and HTTPS](/deploy/domains).

## services

Each key is the service name (an identifier, such as `web`) and becomes the unit `freighter-<app>--<service>.service`.

| Field | Type | Default | |
| --- | --- | --- | --- |
| `command` | string | required | What to run, from the release directory. It's split like a shell command line but not run through a shell, so use `sh -c '…'` if you need pipes or variable expansion. Relative programs are looked up on `PATH`. |
| `port` | integer | none | The port the service listens on, passed as `$PORT`. Ignored for routed services, which get an allocated port. |
| `resources.memory` | `<n>K`, `<n>M` or `<n>G` | unlimited | Hard memory limit (`MemoryMax`). The service is killed and restarted if it goes over. |
| `resources.cpu` | number, up to 64 | unlimited | CPU limit in cores (`CPUQuota`). `0.5` is half a core, `2` is two cores. |
| `healthcheck.path` | string starting with `/` | none | Polled at `http://127.0.0.1:<port><path>` after each deploy. `2xx` means healthy. Also used by HAProxy for routed services. |
| `healthcheck.timeout` | duration | `30s` | How long a new release may take to become healthy. |
| `healthcheck.interval` | duration | `10s` | Accepted, but not used yet. Deploys poll every second and HAProxy checks every 5 seconds. |
| `restart` | `on-failure`, `always`, `no` | `on-failure` | systemd's restart policy, with 3 seconds between restarts and at most 5 starts per minute. |
| `replicas` | integer | `1` | Accepted, but only one instance runs for now, and values above 1 produce a warning. |

Durations are a number followed by `ms`, `s`, `m` or `h`, such as `500ms`, `30s`, `15m` or `1h`.

## build

Used by Git deploys. The commands run in the checkout, one after another, inside a sandbox, and whatever they leave behind becomes the release. Uploaded archives are deployed as they are.

| Field | Type | Default | |
| --- | --- | --- | --- |
| `commands` | list of strings | required | Shell commands, run in order. The build fails at the first one that fails. |
| `timeout` | duration | `15m` | The build is killed after this. |
| `memory` | `<n>K`, `<n>M` or `<n>G` | `2G` | Memory limit for the whole build. |
| `cpu` | number | `2` | CPU limit in cores. |

## What each service gets

| | |
| --- | --- |
| User | a system user named after the app |
| Working directory | the release directory, `/srv/apps/<app>/releases/<id>` |
| Environment | `HOST=127.0.0.1` (routed services only), then `environment`, then secrets, then `PORT` |
| Writable | `/srv/apps/<app>/shared` and a private `/tmp` |
| Logs | stdout and stderr go to the journal |

## Apps without app.yaml

For Git deploys, everything above except `name` and `source` can be set in the dashboard instead. A committed `app.yaml` always takes precedence over those settings. See [Deploy from Git](/deploy/git#no-app-yaml-in-the-repository).
