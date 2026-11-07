# @freighter/dashboard

The web UI (phase 6) and the host process for the API. A Nuxt 4 SPA (PrimeVue + Tailwind v4 + TanStack Query) served by the same Nitro server that mounts `@freighter/api` under `/api`.

| Page | What it shows | Role |
| --- | --- | --- |
| Apps | one row per app with service states, attention first; recent deployments; "Deploy from Git", "Upload archive" | viewer (deploy: deployer) |
| App → Services | state, ports, hostnames, restarts, memory and CPU with sparklines (15 min / 1 h / 6 h), start/stop/restart | viewer (actions: deployer) |
| App → Deployments | history (API and host-CLI deploys), deploy by uploading a `.tar.gz`, roll back with live status | viewer (actions: deployer) |
| App → Logs | journal tail, Live mode (3 s polling), copy/download | deployer |
| App → Secrets | secret names (values are write-only), set a secret, warns about secrets declared in `app.yaml` but missing | viewer (set: admin) |
| Servers | status, last seen, agent version, load/memory/disk, certificate expiry, app count; add a server (shows the enrollment command once), new token, check now, remove | viewer (manage: admin) |
| Certificates | expiry per `tls: auto` hostname, renew | viewer (renew: admin) |
| Tokens, Audit | create/revoke API tokens (shown once), activity log | admin |

## Sign-in
Paste an API token on `/login` (`freighter token create` on the server). The API validates it and stores it in an `HttpOnly; SameSite=Strict` cookie (`Secure` when served over HTTPS), valid for 7 days. Revoking the token ends the session. State-changing requests made with the cookie must carry `X-Requested-With: freighter`, which the UI adds and cross-site pages cannot. Responses carry `X-Frame-Options: DENY` and a CSP limited to framing/base/form directives (Nuxt's SPA shell needs an inline script, so there is no `script-src`).

## Metrics
The API asks the agent for a snapshot every `api.metricsSeconds` (15) and keeps `api.metricsRetentionHours` (6) of history in SQLite. CPU % is derived from systemd's `CPUUsageNSec`; it is blank across a new release (new unit) or a restart.

## Develop
```sh
pnpm --filter @freighter/agent dev --prefix /tmp/fr &      # fake host under /tmp/fr
FREIGHTER_PREFIX=/tmp/fr pnpm --filter @freighter/cli dev token create --name me --role admin --prefix /tmp/fr
FREIGHTER_PREFIX=/tmp/fr pnpm --filter @freighter/dashboard dev
pnpm --filter @freighter/dashboard typecheck   # vue-tsc via nuxt typecheck
pnpm --filter @freighter/dashboard test        # unit tests for formatting/sparkline helpers
```
Production: `pnpm --filter @freighter/dashboard build`, copy `.output/` to the server and run it with `infra/systemd/freighter-api.service`.
