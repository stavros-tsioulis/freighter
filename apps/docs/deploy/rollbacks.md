# Health checks and rollbacks

## How a release is judged

After a release starts, each service has to prove it's healthy before the deploy succeeds:

| Service | Healthy when |
| --- | --- |
| has a `healthcheck` and a port (or a domain) | `GET http://127.0.0.1:<port><path>` answers `2xx` within `healthcheck.timeout` (30s by default). It's polled every second, and a crash fails it immediately. |
| has no `healthcheck` | it's still running, with no restarts, 3 seconds after starting |

A health check on a service with no port and no domain is skipped, and the deploy warns about it.

```yaml
services:
  web:
    command: node server.js
    healthcheck:
      path: /health      # must start with /
      timeout: 45s       # how long a fresh release may take to become healthy
```

Make the health endpoint check what your app needs to serve requests (its database connection, for example), and keep it fast.

## Automatic rollback

If any service fails, the deploy fails and the previous release is re-applied and verified. For routed services the new instance never received traffic, so users notice nothing. The failed deployment records which checks failed and the last lines of the service's journal. You can see them on the **Deployments** tab, in `freighter deploy`'s output, or in `GET /deployments/:id`.

If the very first deploy of an app fails, its services are stopped, because there's no earlier release to return to.

## Roll back by hand

**Dashboard (deployer).** On the app's **Deployments** tab, press **Roll back**. The default target is the previous good release, or pick any release still on the server. Nothing is rebuilt: Freighter switches back to the files already in `releases/` and verifies them like a deploy.

**CLI**, on the server:

```sh
freighter releases shop                       # * marks the current release
freighter rollback shop                       # previous good release
freighter rollback shop r20261106-134501      # a specific one
```

**API:** `POST /api/v1/apps/shop/rollback` with `{"release": "r20261106-134501"}`, or an empty body for the previous one.

A rollback is a deployment of its own and shows up in the history. Domains and secrets aren't part of a release, so they stay as they are.

## Changing services without a deploy

Adding a service, removing one, or changing the environment, command, port, limits or restart policy of existing ones doesn't deploy your code again. Saving the configuration makes a new release from the running one (the same files, linked rather than copied, so the size of `node_modules` doesn't matter) with the new `app.yaml`, and then touches only the services whose unit would actually differ:

- a **new** service is started;
- a **changed** service is restarted; a routed one starts as a new instance, is health-checked, and only then does HAProxy switch to it and the old instance drain;
- a service whose value depends on one that moved (`@web.internal` after `web` got a new port) counts as changed too;
- an **unchanged** service keeps running exactly as it is, from the release it started in. That release is kept as long as anything runs from it;
- a **removed** service is stopped and its unit removed.

If a changed service doesn't come up, only the changed services are put back, the new release is dropped and the others were never touched. What you entered stays in the configuration so you can fix it.

It falls back to a full deploy (every service replaced) when the change needs more than that: a new or changed image to pull, or a change to the app's remote volumes. A change to the build commands of a Git app builds the code again, as before. Rolling back goes to a whole earlier release, as always.

## Cancel a deployment

A deployment that is waiting or running has a **Cancel** button on the Deployments tab (and in the progress dialog).

- **Waiting** (another deploy of that server is ahead of it): it never starts.
- **Running:** the server is told to stop. A `git` fetch, a build (its sandboxed unit is stopped) and an image pull are killed, and the deploy stops at its next step, with nothing of the new release left behind.
- **Already switching in:** the moment the new release's units are started and HAProxy is switched is never interrupted. If it is waiting for the new release to become healthy, it stops waiting and rolls back like any failed health check, so the old release keeps serving.
- A deployment that finishes before the stop arrives is left as it finished.

A canceled deployment shows as **Canceled** (recorded as failed, with the error `Canceled by <who>`). Agents from before this need an upgrade first.

## Keep enough releases

`releases.keep` (5 by default, minimum 2) sets how many releases stay on disk. The current and previous releases are never pruned. Raise it if you want to go further back.

## Restarts and stops

| | Effect |
| --- | --- |
| **Restart** | restarts the service in place. Routed services briefly drop requests. |
| **Stop** | stops the service until it's started again (or the next deploy) |
| **Start** | starts a stopped service |

These are on the app's **Services** tab (deployer), or `freighter start|stop|restart <app> [service]` on the server. systemd also restarts crashed services by itself, following `restart:` in `app.yaml`. A service that crashes 5 times within 60 seconds is left stopped.
