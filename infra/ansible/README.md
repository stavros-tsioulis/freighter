# Ansible (placeholder)

Provisioning playbooks will live here. A host needs:

- HAProxy >= 2.4, loaded with `-f /etc/haproxy/freighter/backends.cfg` (see `freighter haproxy setup`)
- `certbot` (standalone mode is used; HAProxy forwards `/.well-known/acme-challenge/` to it)
- a self-signed placeholder PEM in `/etc/haproxy/freighter/certs/` so `bind :443 ssl crt <dir>/certs/` starts on an empty host
- `/etc/freighter/config.yaml` with at least `acme.email`
- the `freighter-renew.timer` from `infra/systemd/`

Remote servers (phase 7) additionally need:
- `freighter-agent` installed and `freighter-agent.service` enabled
- the agent port (default `7443/tcp`) open to the control plane's address only
- enrollment run once per server (`freighter server add …` on the control plane, `freighter-agent enroll …` on the server)

For deploying from Git (builds run on each server):
- `git` and `openssh-client`, and `systemd-run` (part of systemd)
- the language toolchain your apps build with (Node, pnpm, ...); builds run as the unprivileged `freighter-build` user, which Freighter creates on first use
- outbound access to your git host (SSH or HTTPS) and, for webhooks, a public HTTPS route to the API's `/api/v1/hooks/<app>`
