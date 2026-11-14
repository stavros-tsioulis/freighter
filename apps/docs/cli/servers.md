# Servers

## server

```sh
freighter server list
freighter server show <name>
freighter server add <name> --address <host[:port]>
freighter server token <name>
freighter server check <name>
freighter server upgrade <name> [--ref <branch|tag|commit>] [--with <feature>...] [--no-wait]
freighter server restart <name>
freighter server remove <name>
```

```
$ freighter server list
SERVER      STATE    AGENT     LOAD  MEMORY        DISK FREE  APPS
local       online   a1b2c3d   0.3   2.1/8.0 GB    41 GB      3
contabo-1   online   a1b2c3d   0.9   5.8/11.7 GB   120 GB     9
```

`add` creates the server and prints the one-line command that enrolls it; `token` prints a fresh one for re-enrolling or renewing. `check` contacts the server now. `remove` is refused while apps are pinned to it. See [Add a remote server](/install/remote-server).

`upgrade` has the server's agent re-run the installer, at the version the control server runs unless you name one, and rolls back by itself if the control server can't reach the new agent. It follows the upgrade and exits with `5` if it was rolled back. `--with` adds a feature at the version already installed: `containers`, `storage`, `mounts`, `archives` or `firewall`. `restart` restarts the agent.

### server config

The server's `config.yaml`, as in the dashboard's settings. See [Server settings](/operate/server-settings).

```sh
freighter server config <name>
freighter server config <name> set <key>=<value>...
```

Keys are the dotted names from [config.yaml](/reference/config-yaml) (`agent.console.idleMinutes`). A setting that needs the agent restarted says so.

## firewall

```sh
freighter firewall <server>
freighter firewall <server> enable [--open <port>...]
freighter firewall <server> disable
freighter firewall <server> allow|deny|reject|limit <port>[/tcp|/udp] [--from <address>] [--to <address>] [--comment <text>] [--position <n>]
freighter firewall <server> delete <number>
freighter firewall <server> default <incoming|outgoing> <allow|deny|reject>
```

```
$ freighter firewall contabo-1
Firewall on (incoming: deny, outgoing: allow)
#  ACTION  TO         FROM       COMMENT
1  allow   22/tcp     anywhere   ssh
2  allow   80,443/tcp anywhere   web
3  limit   2222/tcp   10.0.0.0/8
$ freighter firewall contabo-1 allow 5432/tcp --from 203.0.113.7 --comment "reporting"
```

A change that would cut off SSH, the web ports or the agent is refused with the reason; `--yes` does it anyway. `delete` checks that rule `<number>` is still the one you listed. See [Firewall](/operate/firewall).

## file

The server's files, as in the [file explorer](/operate/files). Admin only. A path is `server:/path`.

```sh
freighter file ls <server>:<path>
freighter file cat <server>:<path>
freighter file get <server>:<path> [<local>]            # a file; a folder comes as a .zip
freighter file put <local> <server>:<path> [--overwrite]
freighter file mkdir <server>:<path>
freighter file mv <server>:<path> <server>:<path>
freighter file rm <server>:<path>... 
freighter file extract <server>:<path>... [--to <dir>]
freighter file chown <server>:<path>... [--owner <user>] [--group <group>] [-r]
```

```
$ freighter file ls contabo-1:/srv/apps/shop/shared
NAME       SIZE     MODIFIED      OWNER
uploads/   -        2h ago        shop
data.db    4.2 MB   11m ago       shop
$ freighter file put ./photo.jpg contabo-1:/srv/apps/shop/shared/uploads/
```

`rm` and `chown -r` ask first, as they can't be undone.

## process

```sh
freighter process list <server> [--sort cpu|mem] [--app <name>] [--all]
freighter process signal <server> <pid> <TERM|KILL|HUP|INT|STOP|CONT>
```

`list` is the [process list](/operate/processes), with Freighter's own processes marked. `signal` refuses PID 1, kernel threads and Freighter's own services, and a PID that was reused since you listed.

## settings

The control server's own settings (the public URL and the like), not a server's.

```sh
freighter settings
freighter settings set <key>=<value>...
```
