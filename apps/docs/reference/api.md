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
| `GET /apps` | apps with their services; each has a `projectId` (or `null`) | viewer |
| `GET /apps/:app` | one app, with services, recent deployments and `images` (service to image reference) | viewer |
| `GET /apps/:app/releases` | releases on the server (`current`, `result`) | viewer |
| `GET /apps/:app/metrics?minutes=60` | memory, CPU %, restarts and state per service over time | viewer |
| `GET /apps/:app/logs?service=web&lines=200` | service journal | deployer |
| `POST /apps/:app/start`, `/stop`, `/restart` | body `{"service": "web"}`, or `{}` for all | deployer |

## Storage

An [S3 storage](/deploy/storage). Credentials are never returned, except the key pair in the response that creates or rotates it.

| Endpoint | | Role |
| --- | --- | --- |
| `GET /storages` | storages with their state and domains | viewer |
| `GET /storages/:name` | one storage | viewer |
| `POST /storages/test` | `{"backend": {…}, "secrets": {…}, "server": "…"}`: try a backend. For SFTP without `hostKey` it returns the server's `hostKey` to confirm | admin |
| `POST /storages` | `{"name": "uploads", "server": "…", "backend": {"kind": "local"}}` (or `sftp` / `smb` with `secrets`). `202` with the deployment `id`, `accessKey` and `secretKey` | admin |
| `PATCH /storages/:name` | `{"backend": {…}, "secrets": {…}, "public": true}`; what is left out stays. `public` turns the [public, read-only endpoint](/deploy/storage#public-storage) on or off (the storage shows `public` and `publicHostnames`). Redeploys the endpoint | admin |
| `POST /storages/:name/apply` | deploy the endpoint again with what is stored | admin |
| `GET /storages/:name/files` | `?path=` (default `/`). Buckets at the root, then the keys of a bucket or folder: `entries` (`name`, `type` `dir` or `file`, `size`, `mtimeMs`), `parent`, `truncated` | admin |
| `POST /storages/:name/files/mkdir`, `…/rename`, `…/delete` | `{path}`; `{path, newName}`; `{paths}` (same result as the file explorer's delete). Paths are `/bucket/key` | admin |
| `PUT /storages/:name/files/upload` | `?path=/bucket/key`, `&overwrite=1`; the body is the file, with a `Content-Length` | admin |
| `POST /storages/:name/files/link` | `{path, expires?}` with `path` a file (`/bucket/key`) and `expires` in seconds (60 to 604800, default 3600). Returns `{url, expiresAt}`: a link signed in its query string (AWS Signature V4) that downloads the file without a key until it expires. `409` when the storage has no domain. The audit log records the path and duration, never the link | admin |
| `GET /storages/:name/files/download` | `?path=/bucket/key`. The file | admin |
| `POST /storages/:name/rotate-keys` | new secret key, returned once | admin |
| `DELETE /storages/:name` | `{"confirm": "uploads"}`; refused while an app references it | admin |

A storage's domains, logs and deployments are those of its app, `storage-<name>`: use the app endpoints (`/apps/storage-uploads/domains`, …).

## Projects

A project only groups apps; it has no effect on how they run. An app is in at most one project.

| | | Role |
| --- | --- | --- |
| `GET /projects` | projects with their `appCount` | viewer |
| `POST /projects` | `{"name": "Storefront", "description": "…"}`; names are unique, ignoring case (`409` otherwise) | admin |
| `PATCH /projects/:id` | rename or re-describe | admin |
| `DELETE /projects/:id` | delete the project; its apps are kept and become ungrouped | admin |
| `GET /projects/:id/graph` | the canvas: apps with their services, the `edges` (connections) between services, each with `broken` (why it can't resolve, or `null`), and saved node `layout`. Use `none` as the id for apps without a project | viewer |
| `PUT /projects/:id/layout` | `{"positions": {"app:web": {"x": 0, "y": 0}}}`: where the apps sit on the canvas | deployer |
| `PUT /apps/:app/project` | `{"projectId": "prj_…"}` to move the app into a project, `{"projectId": null}` to take it out | deployer |

## Deployments

| | | Role |
| --- | --- | --- |
| `POST /apps/:app/deployments[?server=NAME]` | body: a `.tar.gz` with `app.yaml` at its root, `Content-Type: application/gzip`. Returns `202 {id}`. `server` applies to new apps only. | deployer |
| `POST /apps/:app/rollback` | `{"release": "r…"}`, or `{}` for the previous good release. Returns `202 {id}`. | deployer |
| `GET /apps/:app/deployments?limit=` | the app's history | viewer |
| `GET /deployments?limit=` | recent deployments across apps | viewer |
| `GET /deployments/:id` | status, release, commit, warnings, error | viewer |
| `POST /deployments/:id/cancel` | Stop a deployment. `202` with `status` `canceled` (it was waiting and will never start) or `stopping` (the server was told to stop it); `409` when it is already over or the agent predates canceling. It ends as `failed` with the error `Canceled by <token name>` | deployer |
| `GET /deployments/:id/log?from=` | build log, from a byte offset (for following) | deployer |

```sh
tar -czf - -C ./myapp . | curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/gzip' \
  --data-binary @- https://freighter.example.com/api/v1/apps/myapp/deployments
```

Deploying to an app pinned to another server returns `409 pinned_to_other_server`.

## Images and registries

Apps whose services all use [`image:`](/deploy/images) have nothing to upload.

| | | Role |
| --- | --- | --- |
| `POST /apps/:app/image-deployments[?server=NAME]` | `{"manifest": "<app.yaml text>"}`. The server pulls the images. Returns `202 {id}`. `400` if a service runs a command. | deployer |
| `POST /apps/:app/images` | `{"images": {"web": "ghcr.io/acme/shop:1.5"}}`. Runs another image for those services and keeps the rest of the current `app.yaml`. Returns `202 {id}`. | deployer |
| `POST /apps/:app/redeploy` | Pull the images of the app's current `app.yaml` again. Returns `202 {id}`. `404` for an app that was never deployed. | deployer |
| `GET /registries` | saved logins: host and user name (never the password) | deployer |
| `PUT /registries/:host` | `{username, password}`. Adds a login, or replaces the password of the one with that user name. A host can have several. Stored encrypted. | admin |
| `DELETE /registries/:host[?username=]` | `username` is required when the host has several logins | admin |
| `PUT /apps/:app/registry-logins/:host` | `{"username": "alice"}`, or `null` for the host's default. Which login the app pulls its images from that host with. | deployer |

An image deployment may carry `"logins": {"ghcr.io": "alice"}` next to `manifest`; the choice is saved for the app. With several logins for a registry and no choice, `image-deployments`, `redeploy` and `images` answer `409 login_required`. `GET /apps/:app` shows the choices as `registryLogins`.

The deployment fails with a reason if the server has no Podman or its agent predates images.

## Domains

| | | Role |
| --- | --- | --- |
| `GET /apps/:app/domains` | domains (`status: active` or `pending`) and the DNS records to create (`dns.records`) | viewer |
| `POST /apps/:app/domains` | `{"hostname", "service", "tls": "auto"\|"off"}`. Adds a pending domain, returns `201`. | admin |
| `POST /apps/:app/domains/:hostname/verify` | checks DNS. Returns `202 {verified: true, id}` when it goes live, or `200 {verified: false, reason, found, expected}`. | admin |
| `DELETE /apps/:app/domains/:hostname` | removes it. A live domain stops routing without a redeploy or restart; the call returns `202 {id}` for the deployment record that tracks it. | admin |
| `DELETE /apps/:app` | `{"confirm": "<app name>", "forget"?: true}`. Deletes the app from its server (services, routing, certificates, releases, shared data, secrets) and from the registry. `confirm` must equal the name. `409` while a deployment is queued or running. `forget` skips the server and removes only the registry's records; an app the server reports as `missing` is handled that way automatically. Irreversible. | admin |

## Secrets

| | | Role |
| --- | --- | --- |
| `GET /apps/:app/variables` | the environment of every service: `service`, `key`, `value` as written, `source` (`app.yaml`, `added`, `override`), `resolved` (connections filled in), `error` if one can't be resolved, `reference` | viewer |
| `PUT /apps/:app/services/:service/variables/:KEY` | `{"value": "…"}`. Adds or changes a variable of the service over app.yaml's and redeploys the current release to apply it | admin |
| `DELETE /apps/:app/services/:service/variables/:KEY` | removes an added variable, or takes an override back to app.yaml's value | admin |
| `GET /apps/:app/config` | the app's configuration: `text` (as app.yaml) and `settings` (the same as a form) | viewer |
| `PUT /apps/:app/config` | `{"settings": {…}}`. Replaces the configuration and redeploys the current release with it | admin |
| `GET /apps/:app/services/:service/env` | `names` of the service's secrets that have a value, and the `declared` ones | viewer |
| `PUT /apps/:app/services/:service/env/:KEY` | `{"value": "…"}`. The value is never stored or logged by the API. | admin |

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
| `POST /servers/:name/updates/check` | `{ref?}`. The server's agent runs git against its repository and reports whether `ref` (default `main`) has newer commits than what is installed, with the newest of them. Changes nothing. | admin |
| `POST /servers/:name/upgrade` | `{ref?}`. Starts an upgrade of a remote server (default ref: the control plane's own commit). `202` with the same body as above. `{containers: true}` instead installs Podman at the version already installed (the installer's `--with-containers`); likewise `{storage: true}` (rclone), `{mounts: true}` (cifs-utils, nfs-common) and `{archives: true}` (7z, unzip, bzip2, zstd); `409` if the agent predates it, `400` for the local server. | admin |
| `GET /servers/:name/processes` | The [process list](/operate/processes): `processes` (`pid`, `ppid`, `name`, `command`, `user`, `state`, `cpu` percent of one core, `rss` bytes, `threads`, `startedMs`, `starttime`, `unit`, `managed` with `kind` `app`, `storage`, `build` or `platform`), plus `cpus`, `memTotal`, `uptimeSeconds` | admin |
| `POST /servers/:name/processes/signal` | `{pid, starttime, signal}` with `signal` one of `TERM`, `KILL`, `HUP`, `INT`, `STOP`, `CONT`; `starttime` from the list, so a reused pid is refused (`409`). Refused too: PID 1, kernel threads, the agent, Freighter's own services | admin |
| `GET /servers/:name/metrics` | `?minutes=` (default 60, up to 1440). The machine's readings, oldest first: `load1`, `cpus`, `memUsed`, `memTotal`, `diskUsed`, `diskTotal` | viewer |
| `GET /servers/:name/fs` | `?path=` (default `/`). The [file explorer](/operate/files): a folder's `entries` (`name`, `type`, `size`, `mtimeMs`, `mode`, `owner`, `group`, `link`), its `parent`, and whether the list was `truncated` | admin |
| `POST /servers/:name/fs/mkdir` | `{path}` | admin |
| `POST /servers/:name/fs/rename` | `{path, name}` | admin |
| `POST /servers/:name/fs/copy`, `…/move` | `{paths, to, onConflict?}` with `onConflict` one of `fail` (default), `overwrite`, `rename`. Returns `{done, failed: [{path, error}]}`; items are independent | admin |
| `POST /servers/:name/fs/extract` | `{paths, to?, onConflict?}`. Unpacks each archive (by extension) into a folder named after it, in `to` or beside the archive; `onConflict` defaults to `rename`. Same result as copy | admin |
| `GET /servers/:name/fs/identities` | The server's `users` and `groups`, each `{name, id}`, for choosing an owner | admin |
| `POST /servers/:name/fs/chown` | `{paths, owner?, group?, recursive?}`, names or numbers; at least one of `owner`, `group`. `recursive` goes through folders (refused for `/`, `/etc`, `/usr` and the other top-level system folders, and for folders with a remote volume mounted). Same result as copy | admin |
| `POST /servers/:name/fs/delete` | `{paths}`. Same result | admin |
| `PUT /servers/:name/fs/upload` | `?path=` the file's full path, `&overwrite=1` to replace. The body is the file, with a `Content-Length`. Streamed to the server and put in place when complete | admin |
| `GET /servers/:name/fs/download` | `?path=`. The file, streamed | admin |
| `POST /servers/:name/fs/archive` | `{paths}`. Returns `{ticket, name}`; `GET /servers/:name/fs/archive/:ticket` within a minute streams a zip of them (folders included, links skipped and listed in the zip) | admin |
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
