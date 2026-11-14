# Logs and metrics

## Logs

Services log to stdout and stderr, and systemd's journal keeps the output. Freighter adds no log store of its own.

- **Dashboard.** The app's **Logs** tab (deployer). Choose a service and a number of lines. Turn on *Live* to refresh every 3 seconds. The view stays pinned to the newest line unless you scroll up. Copy or download what's shown.
- **CLI**, on the app's server:
  ```sh
  freighter logs shop web            # last 100 lines
  freighter logs shop web -n 500
  freighter logs shop web -F         # follow
  ```
- **journalctl**, directly. Unit names are `freighter-<app>--<service>.service`, plus `--<release>` for routed services:
  ```sh
  journalctl -u 'freighter-shop--web*' -f
  ```

Retention and disk use follow your journald settings (`/etc/systemd/journald.conf`).

### Build logs

Builds from Git keep their output with the deployment. Open a row on the app's **Deployments** tab, where the log follows live while the build runs. The API serves it at `GET /api/v1/deployments/:id/log`.

## Metrics

The API samples every service on every server every `api.metricsSeconds` (15) and keeps `api.metricsRetentionHours` (6) of history in the registry:

| Metric | Source |
| --- | --- |
| memory | systemd's memory accounting for the unit |
| CPU % | derived from systemd's `CPUUsageNSec` between samples. It's blank right after a new release or a restart, because the unit is new. |
| restarts | systemd's restart counter |
| state | `active`, `failed`, `activating` and so on |

The **Services** tab charts memory and CPU over the last 15 minutes, hour or 6 hours. The API serves the raw series at `GET /api/v1/apps/:app/metrics?minutes=60`.

Server-level numbers (load, memory, free disk, uptime) appear on the **Servers** page.

Set `api.metricsSeconds: 0` to turn sampling off.

## Status from the shell

```sh
freighter ps shop                           # each service's state, restarts and memory
systemctl list-units 'freighter-*'
systemctl show -p MemoryMax,CPUQuotaPerSecUSec 'freighter-shop--web*'
```
