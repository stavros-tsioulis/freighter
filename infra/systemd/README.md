# systemd

- App units are generated, not hand-written: see `packages/systemd` (`renderUnit`).
- `freighter-renew.{service,timer}`: daily `freighter certs renew`. Install both into `/etc/systemd/system/`, then
  `systemctl enable --now freighter-renew.timer`. Adjust `ExecStart` to wherever the `freighter` binary lives.
- `freighter-agent.service`: the root helper the API talks to over `/run/freighter/agent.sock`.
- `freighter-api.service`: the unprivileged API/dashboard (user `freighter`). Put it behind HAProxy like any other app.

Setup: `useradd --system --no-create-home --shell /usr/sbin/nologin freighter`, install both units, start the agent,
then create the first admin token as that user (see `packages/api/README.md`).
