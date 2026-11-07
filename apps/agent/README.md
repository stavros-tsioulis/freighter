# @freighter/agent

The privileged half of the control plane. It runs as root, listens on a unix socket (default `/run/freighter/agent.sock`, mode `0660`, group `freighter`) and answers a fixed set of operations defined in `@freighter/protocol`: list/inspect apps, deploy an uploaded artifact, roll back, start/stop/restart, read logs, set/list secret *names*, certificate status/renewal, host stats, metrics, and artifact upload/delete. Nothing else is reachable: no shell, no arbitrary file reads (`app.deploy` only accepts artifacts that live inside `agent.artifactsDir`), and secret values never come back out.

```sh
freighter-agent                  # on a server, as root (see infra/systemd/freighter-agent.service)
pnpm --filter @freighter/agent dev --prefix /tmp/fr   # local development, no root needed
```

## Managing remote servers (phase 7)
The same protocol can be served over **mutual TLS** so a control plane on another host can manage this one. It is off by default.

```sh
# on the control plane (as the freighter user)
freighter server add vps-fra-1 --address vps1.example.com --control https://freighter.example.com
# prints a one-time command; run it on vps-fra-1 as root, after installing freighter-agent:
freighter-agent enroll --control https://freighter.example.com --token fre_… --ca-fingerprint SHA256:…
systemctl restart freighter-agent     # now also listens on :7443 (mTLS, TLS 1.3)
```
`enroll` makes the key and CSR locally, checks the CA against the fingerprint you pinned, writes `server.key`/`server.crt`/`ca.crt` to `/etc/freighter/agent`, and turns on `agent.remote` in `/etc/freighter/config.yaml`. Open the port to the control plane's address only. Artifacts are uploaded over the same connection into the server's own spool (`agent.artifactsDir`, capped by `agent.maxArtifactMb`) and removed after the deploy. See `packages/pki/README.md` for the trust model.

```yaml
# /etc/freighter/config.yaml (agent side)
agent:
  remote: { enabled: true, listen: 0.0.0.0, port: 7443, certDir: /etc/freighter/agent, clientCn: freighter-control-plane }
```

**Git deploys.** The agent also builds from repositories: `git.keygen`, `git.check`, `git.deploy`, `build.log`. It needs `git`, `ssh`, and `systemd-run` on the host. Host config (`/etc/freighter/config.yaml`):
```yaml
git: { allowLocal: false, knownHosts: accept-new, buildUser: freighter-build, buildDir: /var/lib/freighter-build, keyDir: /var/lib/freighter/git }
```
Deploy keys live in `keyDir/<app>/` (root, `0600`) and are never readable by builds; builds run in a sandboxed transient unit (see `docs/git-deploys.md`).

Deploys still go through `@freighter/core`, so they are serialized by the host lock and behave exactly like `freighter deploy`. In phase 7 the same protocol will be exposed over mTLS for remote servers.
