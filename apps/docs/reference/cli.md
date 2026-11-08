# CLI

Freighter has two commands: `freighter`, for operating apps, and `freighter-agent`, for the agent. `freighter <command> --help` shows the options for any command.

Commands fall into three groups, depending on what they talk to:

| Group | Runs | Talks to |
| --- | --- | --- |
| [On the server](#on-the-server) | on the app's server, as root | the server directly, with no API involved |
| [Control plane](#control-plane) | on the control server, as the `freighter` user | the registry database |
| [Over the API](#over-the-api) | anywhere | the HTTP API, with `--url` and `--token` (or `$FREIGHTER_URL` and `$FREIGHTER_TOKEN`) |

Any command that works on local files accepts `--prefix <dir>`, which relocates every path under that directory and skips `systemctl`, `useradd` and health checks. It's for trying things without root.

## On the server

### validate

```sh
freighter validate [-f app.yaml]
```

Parse and check a manifest. Exits non-zero with each problem listed.

### unit

```sh
freighter unit <service> [-f app.yaml]
```

Print the systemd unit Freighter would generate for a service.

### deploy

```sh
freighter deploy <dir|artifact.tar.gz> [-f app.yaml] [--dry-run] [--no-verify]
```

Deploy a directory or archive. `-f` defaults to `app.yaml` in the current directory. `--dry-run` shows what would happen. `--no-verify` skips health checks and automatic rollback.

### rollback, releases

```sh
freighter rollback <app> [release] [--no-verify]
freighter releases <app>
```

Switch back to the previous good release, or the one named. `releases` lists them, with `*` marking the current one.

### status, logs

```sh
freighter status <app>
freighter logs <app> <service> [-n 100] [-F]
```

Current release and service states. Service logs from the journal: `-n` sets the line count, `-F` follows.

### start, stop, restart

```sh
freighter start|stop|restart <app> [service]
```

Without a service, applies to all of the app's services.

### env

```sh
freighter env set <app> KEY=VALUE
freighter env set <app> KEY            # value read from stdin
freighter env list <app>               # names only
```

### domain

```sh
freighter domain list <app>
freighter domain add <app> <hostname>=<service>[:auto|:off]
freighter domain remove <app> <hostname>
```

Changes routing directly, without the DNS check the dashboard does, and redeploys a deployed app with the new routing. `tls` defaults to `auto`.

### haproxy, certs

```sh
freighter haproxy setup                # print the lines to add to your existing HAProxy config
freighter haproxy config               # print a complete haproxy.cfg for a Freighter-only HAProxy
freighter haproxy sync                 # rebuild Freighter's HAProxy files and reload if changed
freighter certs status                 # expiry per tls: auto hostname
freighter certs renew [--force]        # renew what's due (daily by timer), or everything
```

## Control plane

Run these as the user that owns the registry, normally with `sudo -u freighter`.

### token

```sh
freighter token create --name <label> [--role viewer|deployer|admin]
freighter token list
freighter token revoke <id>
```

`create` prints the token once. The role defaults to `viewer`.

### server

```sh
freighter server add <name> --address <host[:port]> [--control https://freighter.example.com]
freighter server token <name> [--control …]
freighter server list
freighter server check <name>
freighter server upgrade <name> [--ref <branch|tag|commit>] [--no-wait]
freighter server remove <name>
```

`upgrade` has the server's agent re-run the installer for a version (default: the one this control server runs) and rolls it back by itself if this control server can't reach the new agent afterwards. It follows the upgrade until it ends and exits non-zero if it was rolled back; `--no-wait` starts it and returns. `list` shows each agent's version and marks the ones that are behind. See [Upgrading a server](../install/remote-server.md#upgrading-a-server).

`add` and `token` print a one-time enrollment command. `--control` (or `$FREIGHTER_URL`) is the URL the new server uses to reach this one. `remove` is refused while apps are pinned to the server.

## Over the API

### push

```sh
freighter push <dir|artifact.tar.gz> [--url URL] [--token TOKEN] [--server NAME] [--no-wait]
```

Upload and deploy. A directory is packed first, and the app name comes from its `app.yaml`. `--server` only applies to new apps. Needs a deployer token.

### git

```sh
freighter git add <repo> [--branch main] [--key NAME] [--subpath DIR] [--server NAME] [--no-auto]
freighter git link <app> --repo <repo> [--branch main] [--key NAME] [--provider github|gitlab|other] [--subpath DIR] [--server NAME] [--no-auto]
freighter git show <app>
freighter git check <app>
freighter git deploy <app> [--no-wait]
freighter git rotate-secret <app>
freighter git unlink <app>
```

`add` creates an app from a repository (named after its `app.yaml`), links it and deploys it. `link` links an existing app. Without `--key`, a deploy key is generated for the app and printed. `--no-auto` turns off deploy on push. `check` tests that the server can reach the repository. `deploy` builds the branch head now.

### ssh-key

```sh
freighter ssh-key import <name> --file <path|-> [--passphrase P]
freighter ssh-key generate <name>
freighter ssh-key list
freighter ssh-key remove <name>
```

Needs an admin token. `remove` is refused while apps use the key.

## freighter-agent

```sh
freighter-agent                       # run the agent (as root, normally from freighter-agent.service)
freighter-agent enroll --control <url> --token <token> --ca-fingerprint SHA256:… [--port 7443]
```

`enroll` connects a remote server to a control server. See [Add a remote server](/install/remote-server).
