# How it works

## Architecture

```
                 browser / CLI / CI / git webhooks
                               │ HTTPS
                               ▼
┌──────────────────── control server ─────────────────────┐
│  HAProxy :80 :443 ──▶ API + dashboard (127.0.0.1:3000)  │
│                        user "freighter", SQLite registry│
│                               │ unix socket             │
│                               ▼                         │
│                        freighter-agent (root)           │
│                        systemd · HAProxy files · certbot│
└───────────────────────────────┬─────────────────────────┘
                                │ mutual TLS, :7443
                ┌───────────────┴───────────────┐
                ▼                               ▼
     ┌──── remote server ────┐       ┌──── remote server ────┐
     │ freighter-agent (root)│       │ freighter-agent (root)│
     │ HAProxy · your apps   │       │ HAProxy · your apps   │
     └───────────────────────┘       └───────────────────────┘
```

The API never touches the host itself. It runs unprivileged and sends a fixed set of operations to an agent: deploy this artifact, roll back, restart a service, read logs, set a secret. The agent on the control server listens on a unix socket (`/run/freighter/agent.sock`, group `freighter`). Agents on remote servers serve the same operations over TLS 1.3 and accept only the control server's client certificate.

Nothing else is reachable through the agent: there is no shell, no arbitrary file access, and secret values never come back out.

## What happens during a deploy

1. **Validate.** `app.yaml` is parsed and checked. Every name listed under `secrets:` must already have a value, or the deploy stops here.
2. **Lock.** The server takes a host-wide lock, so two deploys never interleave port allocation or HAProxy writes. A second deploy started meanwhile is refused (from the CLI) or queued (from the API).
3. **Stage.** The directory or `.tar.gz` is unpacked into a new, immutable release directory `releases/r20261107-142501`.
4. **Start.** Units are installed for each service. What happens next depends on whether a domain points at the service:
   - **Routed services** (a domain points at them) start a *new instance* next to the old one, on a port Freighter allocates and passes in `$PORT`.
   - **In-place services** (workers, internal services on a fixed port) are restarted, with a short gap.
5. **Verify.** A service with a `healthcheck` is polled at `http://127.0.0.1:<port><path>` every second until it answers `2xx` or its timeout runs out. A service without one must still be running, with no restarts, after a 3-second settle window.
6. **Switch.** For routed services, HAProxy's maps and backends are rewritten, the whole config is validated with `haproxy -c`, and HAProxy reloads gracefully. The old instance drains for `drainSeconds` (default 5) and stops.
7. **Record.** The deploy is appended to the app's `history.jsonl`, and old releases are pruned down to `releases.keep`.

If any step fails after the release was staged, the previous release is re-applied and verified, and the deploy reports the failing checks with the last lines of the service's journal. The running version never stops serving. When a first deploy fails, its services are stopped because there is nothing to go back to.

## Where state lives

| State | Location | Owner |
| --- | --- | --- |
| Releases, `current` symlink, `shared/` data, history | `/srv/apps/<app>/` on the app's server | agent |
| Secrets | `/etc/freighter/apps/<app>.env` on the app's server | agent |
| Domains | `/srv/apps/<app>/domains.json` on the app's server | agent |
| Tokens, servers, deployment history, metrics, Git links, SSH keys | `/var/lib/freighter/registry.db` on the control server | API |

Each server is the source of truth for what runs on it. The registry mirrors it: the API re-reads every server after each job and every `api.syncSeconds` (60 by default). Deploys made directly on a server with `freighter deploy` are picked up from `history.jsonl` and appear in the dashboard too.

## Apps are pinned to a server

Every app lives on exactly one server, chosen on its first deploy (`local` unless you pick another). Later deploys go to the same server, and a deploy that names a different one is refused. To move an app, deploy it under the new server and remove the old one by hand.
