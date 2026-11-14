# On the server

`freighter host` runs on a server itself, as root (or as the `freighter` user on the control server), and works on the machine's files directly, with no API and no token. It is for setting a server up and repairing one. Everything else is [over the API](/cli/).

`--prefix <dir>` on any of these relocates every path under that directory and skips `systemctl`, `useradd` and health checks, for trying things without root.

## host token

```sh
sudo -u freighter freighter host token create <name> [--role viewer|deployer|admin]
```

Makes a token straight in the registry. It is how you get the first admin token before there is anything to sign in to; after that, [`freighter token`](/cli/access#token) does the same over the API.

## host deploy, host unit

```sh
freighter host deploy <dir|artifact.tar.gz> [-f app.yaml] [--dry-run] [--no-verify]
freighter host unit <service> [-f app.yaml]
```

`deploy` puts an app live on this server without the control server knowing, for a server that isn't connected to one. `unit` prints the systemd unit Freighter would write for a service.

## host haproxy, host certs

```sh
freighter host haproxy setup           # the lines to add to your existing HAProxy config
freighter host haproxy config          # a complete haproxy.cfg for a Freighter-only HAProxy
freighter host haproxy sync            # rebuild Freighter's HAProxy files and reload if they changed
freighter host certs status
freighter host certs renew [--force]
```

## host app delete

```sh
freighter host app delete <app> [--yes]
```

Deletes an app from this server only, as root, when the control server can't (or no longer exists). The dashboard shows the app as *missing* until you [delete it there](/cli/apps#app) too. The system user goes only if the installer made it.

## validate

```sh
freighter validate [app.yaml]
```

Not a host command: it checks an `app.yaml` anywhere, with no server and no sign-in, and lists each problem. Exit code `1` if there are any.

## The agent

`freighter-agent` is the agent itself, started by `freighter-agent.service`.

```sh
freighter-agent enroll --control <url> --token <token> --ca-fingerprint SHA256:… [--port 7443]
```

`enroll` connects a remote server to a control server. See [Add a remote server](/install/remote-server).

## From the old commands

| Before | Now |
| --- | --- |
| `freighter push <dir>` | `freighter deploy <dir>` |
| `freighter push --image <ref> --name <app>` | `freighter deploy --image <ref> --app <app>` |
| `freighter git add <repo>` | `freighter deploy --git <repo>` |
| `freighter git link/show/check/deploy/rotate-secret/unlink` | the same, `freighter git …` |
| `freighter deploy <dir>` (as root on the server) | `freighter host deploy <dir>` |
| `freighter redeploy <app>` | `freighter redeploy <app>` |
| `freighter rollback <app> [release]` | the same |
| `freighter releases <app>` | `freighter release list <app>` |
| `freighter status <app>` | `freighter ps <app>` |
| `freighter logs <app> <service> -n 100 -F` | `freighter logs <app>/<service> -n 100 -f` |
| `freighter start\|stop\|restart <app> [service]` | `freighter start\|stop\|restart <app>[/<service>]` |
| `freighter env set <app> <service> KEY=VALUE` | `freighter var set <app>/<service> KEY=VALUE` (a secret: `freighter secret set`) |
| `freighter env list <app> <service>` | `freighter secret list <app>/<service>` (names of the secrets); `freighter var list` for variables |
| `freighter config show\|set <app>` | `freighter config show\|apply <app>` |
| `freighter domain add <app> <host>=<service>` | `freighter domain add <app> <host> --service <service>` |
| `freighter app delete <app> --local` | `freighter host app delete <app>` |
| `freighter server add\|list\|check\|upgrade\|remove\|token` | the same, `freighter server …`, now over the API |
| `freighter token create\|list\|revoke` | `freighter token …` over the API; `freighter host token create` for the first |
| `freighter registry`, `freighter ssh-key` | the same |
| `freighter haproxy …`, `freighter certs …` | `freighter host haproxy …`, `freighter cert …` (over the API); `freighter host certs …` on the server |
| `freighter validate`, `freighter unit` | `freighter validate`, `freighter host unit` |
| `--url`, `--token`, `$FREIGHTER_URL`, `$FREIGHTER_TOKEN` | the same, or sign in once with `freighter login` |
