---
name: freighter-cli
description: Operate a Freighter (self-hosted deploy platform) from the terminal with the `freighter` CLI — deploy apps, read logs and status, set variables and secrets, manage domains, servers, firewall, storage, tokens, and run commands or shells inside services. Use whenever the user mentions freighter, `freighter deploy`, deploying or redeploying an app, rolling back, app.yaml, a service's logs/env vars/secrets, adding a domain, `freighter exec`/`shell`, CI deploys with FREIGHTER_TOKEN, or asks you to "check what's running on my server", even if they never say "CLI".
---

# Using the freighter CLI

`freighter` talks to a Freighter control server's HTTP API with a bearer token (`fr_…`). Anything the dashboard does, it does. Prefer it over ssh or poking at systemd: it respects roles, writes the audit log and waits for deployments properly.

## Before anything else

1. `freighter whoami` — shows the context, URL and role. If it fails with exit 3, there is no sign-in: ask the user to run `freighter login <url>` (interactive; suggest `! freighter login <url>` so they can type the token themselves). Never ask for a token in chat or put one on a command line you echo; CI uses `FREIGHTER_URL` + `FREIGHTER_TOKEN`.
2. Roles are `viewer` < `deployer` < `admin`. Viewer reads; deployer deploys, restarts, edits variables; admin also sets secrets, uses `exec`/`shell`, manages servers and tokens. A 403/exit 3 usually means the role is too low: say so rather than retrying.
3. `--help` on any command is accurate and cheap; `freighter help <command>` is the same.

## Addressing

`shop` = app, `shop/web` = service, `contabo-1` = server, `contabo-1:/etc/hosts` = path on a server, `files:/a.jpg` = path in a storage. In a directory with an `app.yaml`, the app can be left out (it's `name:`).

## Flags every command has

`-c/--context`, `--url/--token`, `--json` (one JSON value on stdout, messages on stderr), `-q` (ids/names only), `-y/--yes` (skip confirmations), `--no-color`. As an agent, **use `--json` when you will parse the output and `-q` when you only need ids**; use plain output when summarizing for the user. Commands that would ask a question refuse without a terminal — pass `--yes` only when the user has actually asked for that action.

## Exit codes

0 ok · 1 failed · 2 misused (bad option) · 3 not signed in / role too low · 4 not found · 5 deployment failed and rolled back · 130 interrupted. `exec` exits with the remote command's own code.

## Core workflows

**What's running / is it healthy**
```sh
freighter app list
freighter ps shop                 # STATE "retrying" = crash loop
freighter logs shop/web -n 200    # add -f to follow
freighter stats shop --since 1h
freighter deployment list shop --failed
```

**Deploy** — waits and exits 0 when live, 5 if it failed (old release keeps running)
```sh
freighter deploy [path] [--server <name>] [--dry-run] [-v]
freighter deploy --image ghcr.io/org/shop:1.4 --app shop --port 3000
freighter deploy --git git@github.com:org/shop.git --branch main
freighter redeploy shop           # re-pull images / rebuild branch head; also picks up changed secrets
freighter rollback shop [release]
```
When a deploy fails, read the reason before retrying: `freighter deployment show <id>` then `freighter deployment logs <id>`. Use `--no-wait -q` in scripts to get the id and follow it yourself.

**Configure** — each change is a deployment; only the touched service restarts for variable changes
```sh
freighter var list shop/web --resolved
freighter var set shop/web LOG_LEVEL=debug       # service-level; `shop` alone = every service
freighter secret list shop/web                   # names only; values are write-only
printf %s "$VALUE" | freighter secret set shop/web KEY --stdin
freighter config diff shop -f app.yaml           # always diff before apply
freighter config apply shop -f app.yaml
```
Never pass a secret as an argument or echo it; use `--stdin` from an environment variable the user already has. Variables may reference other services (`@api.url`, `@self.KEY`, `${api.host}`); plain values only — secrets never go in `app.yaml`.

**Domains** — `domain add` waits for nothing; the domain is pending until DNS exists
```sh
freighter domain add shop shop.example.com --service web   # prints the DNS records to create
freighter domain verify shop shop.example.com              # after DNS propagates
```

**Run things inside a service** (admin; audited)
```sh
freighter exec shop/web -- node scripts/migrate.mjs
freighter exec shop/web -- sh -c 'ls uploads | wc -l'     # name the shell for pipes/&&
cat dump.sql | freighter exec -i shop/db -- psql -U shop shop
freighter shell shop/web                                   # interactive; needs a real terminal
```
Host services run as the app's user; image services run inside the container. Don't use `-t`/`shell` from a non-interactive session — they need a terminal. Prefer read-only commands unless the user asked to change data.

**Servers, firewall, storage, access** — see `references/commands.md`. Firewall changes that could cut off SSH/web/agent are refused by the server with the reason; don't bypass with `--yes` unless the user confirms.

## Habits that avoid trouble

- Look before changing: `app show`, `config show`, `var list`, `config diff`, `deploy --dry-run`.
- Destructive commands (`app delete`, `server remove`, `rollback` over data changes, `firewall … delete`) — confirm with the user first, state what will be lost.
- Don't loop on a failing command. Exit code + message tell you which kind of failure it is (see above); report it.
- `freighter upgrade` updates the CLI itself (verifies a hash, keeps `.prev`); `--check` only looks.
- Contexts live in `~/.config/freighter/config.json`; `freighter context list|use` switches Freighters. Confirm which one you're on before a mutating command if there's more than one.

## More

- `references/commands.md` — compact command reference for everything not in the workflows above.
- `references/recipes.md` — CI deploys, debugging a crash loop, DB dumps, migrating an env var, setting up a server.
