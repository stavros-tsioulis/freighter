# Concepts

### App

A named unit of deployment, such as `shop`. The name is lowercase letters, digits and single hyphens, starting with a letter. Freighter creates a system user with the same name, and the app's processes run as that user.

### Service

One long-running process of an app, declared under `services:` in `app.yaml`: `web`, `worker`, `scheduler`. Each service becomes a systemd unit named `freighter-<app>--<service>.service`. Routed services get one unit per release, `freighter-<app>--<service>--<release>.service`, so two releases can run side by side during a switch.

### Release

An immutable copy of the app's files, unpacked into `/srv/apps/<app>/releases/<id>/`. IDs look like `r20261107-142501` (UTC timestamp, with `-2`, `-3`… added when two land in the same second). The dashboard shows them without the leading `r`. The `current` symlink points at the release that is live. The last `releases.keep` releases (5 by default) are kept for rollbacks, and the current and previous ones are never pruned.

### Deployment

One attempt to change what runs: a deploy or a rollback. A deployment has a status (`queued`, `running`, `success`, `failed`), a trigger (upload, Git push, *Deploy latest*, or the host CLI), and for Git builds a commit and a build log.

### Server

A machine with `freighter-agent` on it. The control server's own agent, when it has one, is called `local`. Remote servers are added by name and address, then enrolled once.

### Domain

A hostname routed to one of an app's services, such as `shop.example.com` to `web`. Domains are set on the app (dashboard, API or `freighter domain`), not in `app.yaml`, so they survive redeploys and rollbacks. With `tls: auto` Freighter gets a Let's Encrypt certificate for the hostname and redirects HTTP to HTTPS.

### Routed and in-place services

A service that a domain points at is **routed**. It listens on `$PORT` (Freighter allocates one from `ports.min`–`ports.max`) and receives `HOST=127.0.0.1`, because HAProxy connects to `127.0.0.1:$PORT`. An app that binds to `localhost` may get only the IPv6 loopback, which HAProxy can't reach: bind to `$HOST`, or set `HOST` yourself in `environment` to override it. Deploys switch to it with no downtime. A service without a domain is **in place**. It is restarted during deploys and keeps the `port` from `app.yaml`, if it has one.

### Secret

An environment variable whose value is set separately from `app.yaml`, for example `DATABASE_URL`. `app.yaml` lists the names. Values are set with the dashboard, API or CLI, are stored only on the app's server, and can never be read back.

### Token and role

Everyone and everything that talks to the API uses an API token (`fr_…`). Each token has a role:

| Role | Can |
| --- | --- |
| **viewer** | see apps, deployments, servers, certificates, secret names |
| **deployer** | everything a viewer can, plus deploy, roll back, start, stop, restart, read logs and build logs |
| **admin** | everything, including secrets, domains, Git links, SSH keys, servers, tokens, the audit log, certificate renewal and sync |
