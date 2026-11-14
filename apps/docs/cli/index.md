# The CLI

`freighter` runs Freighter from a terminal, a CI job or a script. It talks to the control server's API, so it works from anywhere, with the same roles as the dashboard. Anything the dashboard does, it does.

## Install

The control server serves the CLI that matches it, so the two never drift apart:

```sh
curl -fsSL https://freighter.example.com/install-cli | sh
```

It puts `freighter` in `~/.local/bin`. `freighter upgrade` fetches the version the control server serves now.

### Staying current

Once a day, in the background, an installed `freighter` asks the Freighter you are signed in to whether it serves a newer CLI. If it does, the next command you run at a terminal ends with one line:

```
A newer freighter is available (a1b2c3d -> e4f5a6b). Run: freighter upgrade
```

It never slows a command down, and it stays quiet in CI, in scripts (`--json`, `-q`) and when the output isn't a terminal. `FREIGHTER_NO_UPDATE_CHECK=1` turns it off.

## Sign in

```sh
$ freighter login https://freighter.example.com
Token (from API tokens in the dashboard): ········
Signed in to freighter.example.com as ci (admin).
```

The token is checked, then kept in `~/.config/freighter/config.json` (mode `0600`) as a *context*. Sign in to several Freighters and switch between them:

```sh
freighter context list
freighter context use staging
freighter --context prod ps shop        # for one command
```

In CI there is nothing to sign in to: set `FREIGHTER_URL` and `FREIGHTER_TOKEN`.

## A tour

```sh
$ freighter deploy                       # the app in this directory
$ freighter ps shop
SERVICE  STATE    RESTARTS  MEMORY  ADDRESS
web      running  0         118 MB  shop.example.com
worker   running  0         64 MB   -
$ freighter logs shop/web -f
$ freighter var set shop/web LOG_LEVEL=debug
$ freighter exec shop/web -- node scripts/migrate.mjs
$ freighter shell shop/web
```

## Addressing

| Written | Means |
| --- | --- |
| `shop` | the app |
| `shop/web` | its service `web` |
| `contabo-1` | a server |
| `contabo-1:/etc/hosts` | a path on a server |
| `files:/photos/a.jpg` | a path in a storage (`files`) |

Where a command takes an app and you are in a directory with an `app.yaml`, the app can be left out: it is the `name:` in that file. `freighter ps` there is `freighter ps shop`.

## Options every command has

| Option | |
| --- | --- |
| `-c, --context <name>` | use another sign-in for this command (`$FREIGHTER_CONTEXT`) |
| `--url <url>`, `--token <token>` | use these instead of a context (`$FREIGHTER_URL`, `$FREIGHTER_TOKEN`) |
| `--json` | print JSON instead of text, for scripts |
| `-q, --quiet` | print only what a script needs: ids, names, nothing on success |
| `-y, --yes` | don't ask before something that can't be undone |
| `--no-color` | plain text (also `$NO_COLOR`, and when the output isn't a terminal) |
| `-h, --help` | what a command does and every option it takes |

## What it prints

For people: short tables and one-line results, in color when the output is a terminal. Long work (a deploy, an upgrade) shows its steps as they happen and ends with one line that says how it went.

For scripts: `--json` prints one JSON value, to stdout, and nothing else; messages go to stderr. `-q` prints one id or name per line. Neither asks questions: a command that would ask refuses without `--yes`.

## Exit codes

| Code | |
| --- | --- |
| `0` | it worked |
| `1` | it failed (the message says why) |
| `2` | it was used wrongly: an unknown option, a missing argument |
| `3` | not signed in, or the token's role is too low |
| `4` | the app, server or other thing named doesn't exist |
| `5` | a deployment failed and was rolled back (or couldn't be) |
| `130` | interrupted with <kbd>Ctrl</kbd>+<kbd>C</kbd> |

`freighter exec` is the exception: it exits with the command's own exit code.

## Commands

| | |
| --- | --- |
| [Deploy](/cli/deploy) | `deploy`, `redeploy`, `rollback`, `release`, `deployment` |
| [Apps and services](/cli/apps) | `app`, `ps`, `start`, `stop`, `restart`, `logs`, `stats`, `exec`, `shell`, `project` |
| [Configure](/cli/configure) | `config`, `var`, `secret`, `domain`, `volume`, `git` |
| [Servers](/cli/servers) | `server`, `firewall`, `file`, `process`, `settings` |
| [Storage](/cli/storage) | `storage`, `storage file` |
| [Access](/cli/access) | `login`, `logout`, `whoami`, `context`, `token`, `ssh-key`, `registry`, `cert`, `audit` |
| [Scripting and CI](/cli/scripting) | JSON, waiting, exit codes in practice |
| [On the server](/cli/host) | `freighter host …`, what runs on the machine itself; and the old commands, mapped to the new |

Every command has `--help`, and `freighter help <command>` prints the same.

## Completion

```sh
freighter completion zsh > ~/.zfunc/_freighter     # bash, zsh or fish
```

Commands and subcommands complete.
