# Apps and services

## app

```sh
freighter app list [--project <name>] [--server <name>]
freighter app show [app]
freighter app delete [app] [--forget]
freighter app move [app] --project <name|none>
```

```
$ freighter app list
APP       SERVER      STATE     SERVICES  RELEASE            DOMAIN
shop      contabo-1   deployed  2/2       r20261114-101502   shop.example.com
blog      contabo-1   deployed  1/1       r20261113-085455   blog.example.com
search    contabo-1   missing   0/1       -                  -
```

`show` is everything about one app: where it runs, its release and previous one, its source, and its services.

`delete` removes the services, routing, certificates, every release, the shared directory, the secrets and the deploy key, and the dashboard's records. It asks you to type the app's name; `--yes` skips that. Its Git repository stays. `--forget` drops only the dashboard's records, for an app whose server is gone for good. There is no undo.

## ps

```sh
freighter ps [app]
```

```
$ freighter ps shop
SERVICE  STATE      RESTARTS  MEMORY  CPU   ADDRESS
web      running    0         118 MB  2%    shop.example.com
worker   retrying   7         64 MB   0%    -
```

`retrying` is a service that crashed and that systemd is starting again. Without an app, it lists every service of every app.

## start, stop, restart

```sh
freighter start [app[/service]]
freighter stop [app[/service]]
freighter restart [app[/service]]
```

Without a service, all of the app's. Routed services drop requests briefly while they restart; `stop` asks first.

## logs

```sh
freighter logs [app[/service]] [-n 100] [-f]
```

The journal of a service, or of all of an app's, with each line tagged by service. `-n` is how many lines (up to 1000), `-f` keeps following.

## stats

```sh
freighter stats [app] [--since 1h]
```

Memory, CPU and restarts, as in the dashboard's charts. `--json` gives the samples.

## exec

```sh
freighter exec <app/service> [-i] [-t] [-e KEY=VALUE]... -- <command> [args...]
```

Runs a command in a service and exits with its exit code. A host service runs it **as the app's user**, in the directory its unit runs in, with its environment and secrets. An image service runs it **inside its container**.

```
$ freighter exec shop/web -- node scripts/migrate.mjs
applied 3 migrations
$ echo $?
0
```

| Option | |
| --- | --- |
| `-i, --stdin` | pass this command's standard input to it: `cat dump.sql \| freighter exec -i db/postgres -- psql -U app` |
| `-t, --tty` | give it a terminal (colors, `top`, prompts). Needs a terminal on your side |
| `-e, --env KEY=VALUE` | set a variable for the command, on top of the service's |

Without `-t`, output isn't a terminal's: no colors, and standard error stays separate. Arguments after `--` go to the command as they are, with no shell in between. For a pipeline or `&&`, name the shell: `freighter exec shop/web -- sh -c 'cd uploads && ls | wc -l'`.

Admin only. Every use is in the [audit log](/cli/access#audit) with the service and the command's name, never its arguments or output.

## shell

```sh
freighter shell <app/service>
```

An interactive shell in the service: `bash` (else `sh`), the same as the dashboard's [console](/operate/console). It is `exec -it` with the shell as the command, so everything above applies. Close it with `exit` or <kbd>Ctrl</kbd>+<kbd>D</kbd>; a dropped connection ends the shell on the server.

## project

Projects group apps; they change nothing about how they run.

```sh
freighter project list
freighter project create <name> [--description <text>]
freighter project rename <name> <new-name>
freighter project delete <name>
freighter project show <name>
```

`show` prints the project's apps and the [connections](/deploy/connections) between their services. Deleting a project keeps its apps.
