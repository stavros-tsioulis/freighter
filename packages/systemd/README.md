# @freighter/systemd

Phase 1: generate hardened systemd units from a manifest service (`renderUnit`) and drive them (`createSystemd`: install, start/stop/restart, status, journalctl args). Commands run via `execFile`, never a shell; all unit names are validated.

## Manual verification on a Linux host
```sh
pnpm --filter @freighter/cli dev unit web ../../examples/app.yaml > /tmp/freighter-myapp--web.service
systemd-analyze verify /tmp/freighter-myapp--web.service
# create user + dirs (Ansible later): useradd -r myapp; mkdir -p /srv/apps/myapp/{current,shared}; chown -R myapp /srv/apps/myapp
# install as freighter-myapp--web.service, systemctl start, then:
systemctl show -p MemoryMax,CPUQuotaPerSecUSec freighter-myapp--web.service
kill -9 $(systemctl show -p MainPID --value freighter-myapp--web.service)   # should restart after 3s
```
