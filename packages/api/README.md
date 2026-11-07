# @freighter/api

HTTP API for the control plane (phase 5). It is an [h3](https://h3.unjs.io) app mounted under `/api` by the Nuxt/Nitro server in `apps/dashboard`. It never touches the host itself: it keeps state in SQLite (`@freighter/registry`) and asks the root `freighter-agent` to act, over a unix socket.

## Bootstrap
```sh
useradd --system --no-create-home --shell /usr/sbin/nologin freighter
# install infra/systemd/freighter-agent.service and freighter-api.service, then:
systemctl enable --now freighter-agent freighter-api
sudo -u freighter freighter token create --name bootstrap --role admin   # prints the token once
```
The registry DB (`/var/lib/freighter/registry.db`) is owned by the `freighter` user, so run `token` commands as that user.

## Auth
`Authorization: Bearer fr_…`. Roles are cumulative: **viewer** (read), **deployer** (deploy, roll back, restart, logs), **admin** (secrets, tokens, audit, certs, sync). Only a SHA-256 of each token is stored. Ten failed attempts per address per minute are blocked with `429` (client address comes from `X-Forwarded-For` when `api.trustProxy` is true, which assumes the API listens on localhost behind HAProxy).

## Browser sessions
The dashboard signs in with `POST /v1/session {token}` (sets an `HttpOnly; SameSite=Strict` cookie), `GET /v1/session` returns the principal and `DELETE /v1/session` signs out. Cookie-authenticated writes need `X-Requested-With: freighter`; bearer-token clients don't. Requests with no credentials at all don't count toward the failed-attempt limiter.

## Endpoints (`/api/v1`)
| | | role |
| --- | --- | --- |
| `GET /health` (under `/api`) | liveness | none |
| `GET /apps`, `GET /apps/:app` | apps, services, recent deployments | viewer |
| `GET /apps/:app/domains` | the app's domains (`status: active\|pending`) and the DNS records to create (`dns.records`) | viewer |
| `POST /apps/:app/domains` `{hostname, service, tls}` | add a domain. It only waits (`pending`): nothing is routed and no certificate is requested yet → `201` | admin |
| `POST /apps/:app/domains/:hostname/verify` | check DNS (the name must resolve, only to the app's server). If it does, the domain goes live as a recorded, health-gated deployment → `202 {verified: true, id}`; otherwise `200 {verified: false, reason, found, expected}`. `*.localhost` needs no DNS | admin |
| `DELETE /apps/:app/domains/:hostname` | remove a waiting domain, or a live one through a deployment → `202 {id}` | admin |
| `GET /apps/:app/releases` · `/deployments?limit=` · `/env` | releases (live), history, secret names | viewer |
| `GET /deployments?limit=` · `GET /deployments/:id` · `GET /certs` | recent deployments · deployment status · certificates | viewer |
| `GET /apps/:app/metrics?minutes=` | per-service memory, CPU %, restarts, state over time | viewer |
| `POST /apps/:app/deployments` | body = `.tar.gz` with `app.yaml` at its root → `202 {id}` | deployer |
| `POST /apps/:app/rollback` `{release?}` | → `202 {id}` | deployer |
| `POST /apps/:app/{start,stop,restart}` `{service?}` | | deployer |
| `GET /apps/:app/logs?service=&lines=` | | deployer |
| `PUT /apps/:app/env/:KEY` `{value}` | set a secret (value never stored or logged by the API) | admin |
| `GET/POST /tokens`, `DELETE /tokens/:id` · `GET /audit` · `POST /certs/renew` · `POST /sync` | | admin |

Errors are `{"error": {"code", "message"}}`. Deployments run one at a time; poll `GET /deployments/:id` until `status` is `success` or `failed`.

```sh
tar -czf - -C ./myapp . | curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/gzip' \
  --data-binary @- https://freighter.example.com/api/v1/apps/myapp/deployments
# or, from CI:
FREIGHTER_URL=https://freighter.example.com FREIGHTER_TOKEN=... freighter push ./myapp
```

## Servers
Every app is pinned to one server (default `local`; the first deploy of a new app may name another with `?server=NAME`, after which any other server is refused with `409 pinned_to_other_server`). `GET /servers`, `GET /servers/:name` (viewer); `POST /servers {name, address}` returns the one-time enrollment command, `POST /servers/:name/enrollment` issues a new token, `POST /servers/:name/check` pings now, `DELETE /servers/:name` (admin; not `local`, not while apps are pinned). `POST /enroll {token, csr}` is public: an agent redeems its token for a certificate (rate-limited with the failed-login limiter). `GET /certs` and `POST /certs/renew` cover all servers, filter with `?server=`. Sync, health checks and metrics sampling visit every enrolled server independently, so one server being down only marks that server offline.

## SSH keys
`GET /ssh-keys`, `POST /ssh-keys {name, privateKey, passphrase?}`, `DELETE /ssh-keys/:id` (admin). The key is validated (and decrypted) by the local agent, stored encrypted, and never returned; duplicate names and fingerprints are refused with 409, and a key that apps use cannot be deleted. Pickers: `POST /git/branches {repository, sshKeyId?, server?}` (deployer) lists branches over SSH/HTTPS, `POST /git/inspect {repository, branch, sshKeyId?, subpath?, server?}` reads `app.yaml` (app name, build commands). `POST /git/deployments {repository, branch, sshKeyId?, server?, subpath?, provider?, autoDeploy?}` (admin) names the app from `app.yaml`, links the repository and queues the first deployment (the webhook secret is returned once).

## Git (link by URL)
`GET/PUT/PATCH/DELETE /apps/:app/git` (viewer/admin) link an app to a repository (`sshKeyId` picks an imported key; without it a deploy key is generated on PUT; the secret is returned once). `POST …/git/rotate-secret`, `…/git/rotate-key` (admin), `…/git/check`, `…/git/deploy` (deployer). `POST /hooks/:app` is the **public** webhook receiver for GitHub (`X-Hub-Signature-256`) and GitLab (`X-Gitlab-Token`); it is rate-limited on bad signatures and only ever triggers a fetch of the linked branch. `GET /deployments/:id/log?from=` follows a build log (deployer). See `docs/git-deploys.md`.

## Registry and sync
Observed state (apps, services, ports, hostnames) and deployment history are mirrored into SQLite after every job, on `POST /sync`, and every `api.syncSeconds` (default 60). Deployments made directly on the host with the CLI are imported from each app's `history.jsonl` (`source: "host"`); ones made through the API are linked to it, not duplicated. Rows left `queued`/`running` by a crashed API are marked failed on startup.

Uploads are streamed to `agent.artifactsDir` (limit `api.maxUploadMb`, default 200) and deleted when the job ends. Note that tar extraction happens as root in the agent; only give the `deployer` role to people and pipelines you would trust to run code on the host.
