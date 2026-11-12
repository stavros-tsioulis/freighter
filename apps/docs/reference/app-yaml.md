# app.yaml

`app.yaml` describes one app, and **starts** it: the first deploy reads it and the values become the app's configuration, kept on its server. After that Freighter doesn't read `app.yaml` again. A later deploy that carries a different file still deploys, with a warning that the file wasn't applied. From then on you change the configuration in the dashboard (the app's **Settings** tab) or with [`freighter config`](/reference/cli#config), and the current release is redeployed with it.

It sits at the root of an uploaded archive, or in the repository (at the subdirectory you chose) for Git deploys. In the dashboard, a Git deploy fills the settings form in from it, so you can adjust the values before the first deploy. Check a file with `freighter validate -f app.yaml`.

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
  environment:
    PUBLIC_API_URL: "@api.url"

environment:
  TZ: UTC

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
    environment:
      NODE_ENV: production
    secrets:
      - DATABASE_URL
      - SESSION_SECRET
  worker:
    command: node dist/worker.js
    resources:
      memory: 128M
    secrets:
      - DATABASE_URL

releases:
  keep: 5
```

## Top level

| Field | Type | Default | |
| --- | --- | --- | --- |
| `name` | identifier | required | The app's name: lowercase letters, digits and single hyphens, starting with a letter. It must match the app you deploy to. |
| `services` | map of identifier to [service](#services) | required | The app's processes. |
| `build` | [build](#build) | none | Commands that run before deploying, for Git deploys. |
| `environment` | map of `UPPER_SNAKE_CASE` to string | `{}` | Plain values every service gets at run time. A service's own `environment` wins over it. May contain [references](/deploy/connections). Build-time values go in `build.environment`. |
| `releases.keep` | integer, 2 or more | `5` | How many releases to keep on disk. The current and previous ones are always kept. |
| `source` | object | none | `type: git`, `repository`, `branch` (default `main`). Accepted for documentation only: the repository link set in Freighter is what's used. |

`secrets:` belong to each [service](#services), not to the app. (An `environment:` at the top is the app's, for every service; see above.) The app-level `volumes:` map declares [remote volumes](/deploy/volumes#remote-volumes) (SMB, NFS). `domains:` isn't allowed: domains are set on the app. See [Domains and HTTPS](/deploy/domains).

## services

Each key is the service name (an identifier, such as `web`) and becomes the unit `freighter-<app>--<service>.service`.

| Field | Type | Default | |
| --- | --- | --- | --- |
| `command` | string | one of `command` / `image` | What to run, from the release directory. It's split like a shell command line but not run through a shell, so use `sh -c '…'` if you need pipes or variable expansion. Relative programs are looked up on `PATH`. |
| `image` | image reference | one of `command` / `image` | Run this container image with Podman instead of a command: `nginx`, `ghcr.io/org/app:1.2`, `registry:5000/team/app@sha256:…`. See [Deploy images](/deploy/images). |
| `containerPort` | integer | the port the image declares | Images only: the port the image listens on inside the container. Freighter publishes it on the service's port (`127.0.0.1` only) and also sets `$PORT`. When you leave it out, the port the image declares with `EXPOSE` is used if there is exactly one (Grafana: 3000, nginx: 80). An image that declares several or none is published onto the service's own port, as if it honoured `$PORT`, and the deployment log says so: set `containerPort` then. |
| `volumes` | map of name to absolute path | none | Folders of the app, kept in `/srv/apps/<app>/shared/volumes/<name>`, that the service sees at that path (inside the container for images, bound into the unit for commands, not under system directories). See [volumes](/deploy/volumes). |
| `port` | integer | picked for you | The port the service listens on, passed as `$PORT`. Ignored for routed services, which get an allocated port. When you leave it out, Freighter picks a free port at random in the `ports` range of [config.yaml](/reference/config-yaml) and keeps it from deploy to deploy, so `@service.port` and `@service.internal` work for any service. |
| `resources.memory` | `<n>K`, `<n>M` or `<n>G` | unlimited | Hard memory limit (`MemoryMax`). The service is killed and restarted if it goes over. |
| `resources.cpu` | number, up to 64 | unlimited | CPU limit in cores (`CPUQuota`). `0.5` is half a core, `2` is two cores. |
| `healthcheck.path` | string starting with `/` | none | Polled at `http://127.0.0.1:<port><path>` after each deploy. `2xx` means healthy. Also used by HAProxy for routed services. |
| `healthcheck.timeout` | duration | `30s` | How long a new release may take to become healthy. |
| `healthcheck.interval` | duration | `10s` | Accepted, but not used yet. Deploys poll every second and HAProxy checks every 5 seconds. |
| `restart` | `on-failure`, `always`, `no` | `on-failure` | systemd's restart policy, with 3 seconds between restarts and at most 5 starts per minute. |
| `proxy.timeout` | duration | HAProxy's `30s` | Routed services: how long HAProxy waits on the service before giving up, for uploads, streaming and slow responses. |
| `replicas` | integer | `1` | Accepted, but only one instance runs for now, and values above 1 produce a warning. |
| `environment` | map of `UPPER_SNAKE_CASE` to string | `{}` | Plain environment values for this service. These are the initial values: variables added or changed on the service's **Variables** tab are laid over them. Values may contain [connections](/deploy/connections). |
| `secrets` | list of `UPPER_SNAKE_CASE` | `[]` | Names that must have a value (set separately) before a deploy. See [secrets](/deploy/secrets). A name can't be in both `environment` and `secrets`. |

Set exactly one of `command` and `image` on each service. An app can mix both kinds.

An `app.yaml` with `environment:` or `secrets:` at the top, from before they belonged to services, is refused. Move them under the services that use them. Releases that are already deployed keep working: their top-level values count for every service, and secrets and variables saved for the app move to its services the next time the app is deployed or its Variables are opened.

Durations are a number followed by `ms`, `s`, `m` or `h`, such as `500ms`, `30s`, `15m` or `1h`.

## build

Used by Git deploys. The commands run in the checkout, one after another, inside a sandbox, and whatever they leave behind becomes the release. Uploaded archives are deployed as they are.

| Field | Type | Default | |
| --- | --- | --- | --- |
| `commands` | list of strings | required | Shell commands, run in order. The build fails at the first one that fails. |
| `timeout` | duration | `15m` | The build is killed after this. |
| `memory` | `<n>K`, `<n>M` or `<n>G` | `2G` | Memory limit for the whole build. |
| `cpu` | number | `2` | CPU limit in cores. |
| `environment` | map of `UPPER_SNAKE_CASE` to string | `{}` | Plain values the build commands see, and only them: not the services, and not the app's run-time `environment`. No secrets. A value may use the public address of a service, `@service.url` or `@service.domain` (also `@other-app/service.url` for an app in the same project), filled in from the domains as they are when the build starts: a framework that bakes the API address into the bundle can get it here. A service with no domain yet gives an empty value, and the build log says so. Ports, `.internal`, credentials and run-time values are refused. `CI=1` and `NODE_ENV=development` are set for builds and can be changed here; where the build keeps its files (`HOME`, the package-manager caches) can't. |

## What each service gets

| | |
| --- | --- |
| User | a system user named after the app |
| Working directory | the release directory, `/srv/apps/<app>/releases/<id>` |
| Environment | `HOST=127.0.0.1` (routed services only), then the app's `environment`, then the service's own, then secrets, then `PORT` |
| Writable | `/srv/apps/<app>/shared` and a private `/tmp` |
| Logs | stdout and stderr go to the journal |

### Images

A service with `image:` runs in a rootless Podman container as the app's user instead of as a host process. Its `environment`, secrets and `PORT` are passed into the container, `resources` limit the whole container, `healthcheck` and zero-downtime releases work the same way, and logs still go to the journal. The `build` block, the working directory and the release directory's files are not used by an image. See [Deploy images](/deploy/images).

## Apps without app.yaml

For Git deploys, everything above except `name` and `source` can be set in the dashboard instead. A committed `app.yaml` always takes precedence over those settings. See [Deploy from Git](/deploy/git#no-app-yaml-in-the-repository).
