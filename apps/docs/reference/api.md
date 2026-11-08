# HTTP API

The API is served by the control server under `/api`. Everything the dashboard does goes through it.

## Basics

- **Base URL:** `https://freighter.example.com/api/v1`
- **Authentication:** `Authorization: Bearer fr_…`. Each endpoint needs a minimum [role](/operate/access).
- **Errors:** a status code and `{"error": {"code": "…", "message": "…"}}`
- **Rate limiting:** ten failed authentications from one address per minute return `429`.
- **Long-running work** (deploys, rollbacks, domain changes) returns `202` with a deployment `id`. Poll `GET /deployments/:id` until `status` is `success` or `failed`.

```sh
TOKEN=fr_…
curl -s -H "Authorization: Bearer $TOKEN" https://freighter.example.com/api/v1/apps
```

## Health

| | | Role |
| --- | --- | --- |
| `GET /api/health` | liveness | none |

## Apps

| | | Role |
| --- | --- | --- |
| `GET /apps` | apps with their services | viewer |
| `GET /apps/:app` | one app, with services and recent deployments | viewer |
| `GET /apps/:app/releases` | releases on the server (`current`, `result`) | viewer |
| `GET /apps/:app/metrics?minutes=60` | memory, CPU %, restarts and state per service over time | viewer |
| `GET /apps/:app/logs?service=web&lines=200` | service journal | deployer |
| `POST /apps/:app/start`, `/stop`, `/restart` | body `{"service": "web"}`, or `{}` for all | deployer |

## Deployments

| | | Role |
| --- | --- | --- |
| `POST /apps/:app/deployments[?server=NAME]` | body: a `.tar.gz` with `app.yaml` at its root, `Content-Type: application/gzip`. Returns `202 {id}`. `server` applies to new apps only. | deployer |
| `POST /apps/:app/rollback` | `{"release": "r…"}`, or `{}` for the previous good release. Returns `202 {id}`. | deployer |
| `GET /apps/:app/deployments?limit=` | the app's history | viewer |
| `GET /deployments?limit=` | recent deployments across apps | viewer |
| `GET /deployments/:id` | status, release, commit, warnings, error | viewer |
| `GET /deployments/:id/log?from=` | build log, from a byte offset (for following) | deployer |

```sh
tar -czf - -C ./myapp . | curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/gzip' \
  --data-binary @- https://freighter.example.com/api/v1/apps/myapp/deployments
```

Deploying to an app pinned to another server returns `409 pinned_to_other_server`.

## Domains

| | | Role |
| --- | --- | --- |
| `GET /apps/:app/domains` | domains (`status: active` or `pending`) and the DNS records to create (`dns.records`) | viewer |
| `POST /apps/:app/domains` | `{"hostname", "service", "tls": "auto"\|"off"}`. Adds a pending domain, returns `201`. | admin |
| `POST /apps/:app/domains/:hostname/verify` | checks DNS. Returns `202 {verified: true, id}` when it goes live, or `200 {verified: false, reason, found, expected}`. | admin |
| `DELETE /apps/:app/domains/:hostname` | removes it. A live domain is removed through a deployment and returns `202 {id}`. | admin |

## Secrets

| | | Role |
| --- | --- | --- |
| `GET /apps/:app/env` | secret names | viewer |
| `PUT /apps/:app/env/:KEY` | `{"value": "…"}`. The value is never stored or logged by the API. | admin |

## Git

| | | Role |
| --- | --- | --- |
| `POST /git/branches` | `{repository, sshKeyId?, server?}`. Lists the branches. | deployer |
| `POST /git/inspect` | `{repository, branch, sshKeyId?, subpath?, server?}`. Reads `app.yaml`: app name, commit, build commands. | deployer |
| `POST /git/deployments` | `{repository, branch, sshKeyId?, server?, subpath?, provider?, autoDeploy?, appName?, settings?}`. Creates and links an app and queues its first deploy. The webhook secret is returned once. | admin |
| `GET /apps/:app/git` | the repository link | viewer |
| `PUT /apps/:app/git` | link: `{repository, branch, provider, subpath, autoDeploy, sshKeyId, settings?}`. Without `sshKeyId` a deploy key is generated. Returns the secret once. | admin |
| `PATCH /apps/:app/git` | change `branch`, `sshKeyId`, `autoDeploy` or `settings` (`null` clears them) | admin |
| `DELETE /apps/:app/git` | unlink | admin |
| `POST /apps/:app/git/rotate-secret`, `/rotate-key` | new webhook secret (returned once) or new deploy key | admin |
| `POST /apps/:app/git/check` | test access to the repository | deployer |
| `POST /apps/:app/git/deploy` | build and deploy the branch head. Returns `{id, coalesced}`. | deployer |
| `POST /hooks/:app` | **public** webhook receiver, verified by `X-Hub-Signature-256` (GitHub, Gitea, Forgejo) or `X-Gitlab-Token` | signature |
| `POST /manifest/render` | render dashboard settings to `app.yaml` text, as a preview | deployer |

## SSH keys

| | | Role |
| --- | --- | --- |
| `GET /ssh-keys` | names, types, fingerprints, usage | admin |
| `POST /ssh-keys` | `{name, privateKey, passphrase?}`. Imports a key, which is stored encrypted and never returned. | admin |
| `POST /ssh-keys/generate` | `{name}`. Creates an ed25519 key and returns its public half. | admin |
| `DELETE /ssh-keys/:id` | refused while apps use it | admin |

## Servers

| | | Role |
| --- | --- | --- |
| `GET /servers`, `GET /servers/:name` | status, host stats, agent version, certificate expiry, app count | viewer |
| `POST /servers` | `{name, address}`. Returns the one-time enrollment command. | admin |
| `POST /servers/:name/enrollment` | a new enrollment token, for re-enrolling or renewing | admin |
| `POST /servers/:name/check` | contact the server now | admin |
| `GET /version` | the commit the control plane runs | viewer |
| `GET /servers/:name/upgrade` | whether the agent can upgrade itself, its version against the control plane's, and the state and log of the last upgrade | admin |
| `POST /servers/:name/upgrade` | `{ref?}`. Starts an upgrade of a remote server (default ref: the control plane's own commit). `202` with the same body as above. | admin |
| `DELETE /servers/:name` | not `local`, and not while apps are pinned | admin |
| `POST /enroll` | **public**: `{token, csr}`. An agent redeems its token for a certificate. | token |

## Certificates, sync and admin

| | | Role |
| --- | --- | --- |
| `GET /certs[?server=]` | `tls: auto` hostnames and expiry | viewer |
| `POST /certs/renew[?server=]` | renew certificates that are due | admin |
| `POST /sync` | re-read every server into the registry now | admin |
| `GET /tokens`, `POST /tokens`, `DELETE /tokens/:id` | list, create (`{name, role}`, returned once), revoke | admin |
| `GET /audit` | the audit log | admin |

## Browser sessions

The dashboard uses `POST /session {token}`, which sets an `HttpOnly; SameSite=Strict` cookie valid for 7 days (`Secure` over HTTPS). `GET /session` returns who you are, and `DELETE /session` signs out. Writes authenticated with the cookie must send `X-Requested-With: freighter`. Bearer-token clients don't need it.
