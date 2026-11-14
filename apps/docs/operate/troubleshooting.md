# Troubleshooting

Start with the deployment itself: the app's **Deployments** tab (open the row), `freighter deploy`'s output, or `GET /api/v1/deployments/:id`. Failed deploys include the failing checks and the last journal lines of the service.

## Deploys

| Symptom | Likely cause and fix |
| --- | --- |
| `missing secrets for shop: web/X` | a name under the service's `secrets:` has no value. Set it on the service's Variables tab or with `freighter env set shop web X`. |
| health check timed out | the app didn't answer `2xx` on its health path in time. Check it listens on `$PORT` (for routed services) and on `127.0.0.1`, and raise `healthcheck.timeout` if startup is slow. |
| service exited, or restarted during the settle window | read the journal lines in the error. A missing dependency, a bad `command`, or writing outside `shared/` (the filesystem is read-only) are the usual causes. |
| `another deploy or rollback is in progress` (CLI) or `a deployment is in progress` (409 from the API) | another deploy holds the server's lock. Wait for it, since deploys on one server run one at a time. |
| `pinned_to_other_server` (409) | the app already lives on another server. Leave out `--server`, or use a new app name. |
| `domains:` is rejected | domains moved out of `app.yaml`. Add them on the app's Domains tab. |
| `port is ignored for routed services` | a warning: a domain points at the service, so it must listen on `$PORT`. |
| `replicas > 1 is not supported yet` | a warning: one instance runs. |
| upload refused as too large | raise `api.maxUploadMb` on the control server, and `agent.maxArtifactMb` on the target server. |

## Domains and certificates

| Symptom | Likely cause and fix |
| --- | --- |
| *Verify* says the records don't match | DNS hasn't spread yet, or it points somewhere else as well. The message shows what was found and what was expected. |
| no DNS records are shown | set `api.publicIps` in `/etc/freighter/config.yaml` on the control server and restart `freighter-api`. |
| `certbot failed for host` | DNS doesn't point at this server yet, port 80 doesn't reach HAProxy, or the `freighter_acme` rule is missing from the :80 frontend. Use `tls: off` to go live without HTTPS meanwhile. |
| `set acme.email` | add `acme.email` to `config.yaml` before using `tls: auto`. |
| HAProxy won't start | the certs directory is empty (add the placeholder PEM), or `backends.cfg` isn't loaded. Run `haproxy -c -f /etc/haproxy/haproxy.cfg -f /etc/haproxy/freighter/backends.cfg`. |
| domain returns HAProxy's default page | the `use_backend … hostnames.map` line is missing from that frontend. Re-run `freighter host haproxy setup` and compare. |

## Git

| Symptom | Likely cause and fix |
| --- | --- |
| `permission denied (publickey)` | the key can't read this repository, or the generated deploy key wasn't added (or was rotated). |
| a private repository lists no branches | pick the SSH key first. Without one, only public HTTPS repositories work. |
| `host key verification failed` | the Git host's key changed. Remove the app's `known_hosts` under `/var/lib/freighter/git/<app>/` on the server. |
| webhook delivery shows `401` | secret mismatch. Rotate it on the Source tab and update the Git host. |
| delivery succeeds but nothing deploys | check *Last webhook* on the Source tab: wrong branch, auto-deploy off, or not a push event. |
| `app.yaml is for "x" but this app is "y"` | the manifest's `name` differs from the app's name. |
| build killed | raise `build.timeout` or `build.memory`. |
| can't delete an SSH key | apps still use it. Switch them to another key first. |

## Servers

| Symptom | Likely cause and fix |
| --- | --- |
| remote server *Offline* | the agent is stopped, port 7443 is blocked, or the address changed. On the server, check `systemctl status freighter-agent` and `journalctl -u freighter-agent`. |
| enroll: CA fingerprint doesn't match | you're not talking to the control server you meant, or the command was mistyped. Nothing was written. Check the URL. |
| enroll: token invalid or expired | tokens last an hour and work once. Press **Re-enroll** for a new command. |
| *Waiting to enroll* after enrolling | restart the agent: `systemctl restart freighter-agent`. |
| `freighter token create` fails with permission errors | run it as the registry owner: `sudo -u freighter freighter token create …`. |
| the dashboard shows nothing changed after a CLI deploy | it syncs every 60 seconds. Press **Sync** on the Apps page. |

## Getting more detail

```sh
journalctl -u freighter-agent -e        # agent: deploys, builds, certificates
journalctl -u freighter-api -e          # API: sync, metrics, requests
journalctl -u 'freighter-<app>--*' -e   # your app
freighter status <app>
```
