# Configure

Everything here changes an app's [configuration](/reference/app-yaml). Changes that only touch one service's environment restart that service; the rest redeploy the current release. Each one is a [deployment](/cli/deploy#deployment): the command waits for it, or `--no-wait` returns the id.

## config

```sh
freighter config show [app]
freighter config edit [app]
freighter config apply [app] -f <app.yaml> [--no-wait]
freighter config diff [app] -f <app.yaml>
```

`show` prints the configuration as `app.yaml`. `edit` opens it in `$EDITOR` and applies it when you save a valid file. `apply` replaces it with a file; `diff` shows what that would change, without changing anything.

## var

An app's variables: the plain `environment:` values, the ones a service can read with [connections](/deploy/connections) like `@api.url`.

```sh
freighter var list [app[/service]] [--resolved]
freighter var set <app[/service]> KEY=VALUE... [--build]
freighter var unset <app[/service]> KEY... [--build]
```

```
$ freighter var list shop/web
KEY         VALUE                  FROM
LOG_LEVEL   info                   service
TZ          UTC                    app
API_URL     @api.url               service
$ freighter var list shop/web --resolved
API_URL     https://api.example.com
```

With a service, `set` writes the service's own value. With just the app, it writes the app-level value every service gets (a service's own value wins). `--build` is for the build's environment, which can only use `@service.url` and `@service.domain`. Only the service that changed restarts. `--resolved` adds what each connection works out to, and why one can't be.

## secret

Secrets are write-only: nothing prints them, and they never go in `app.yaml`. A service declares which it needs under `secrets:`.

```sh
freighter secret list <app/service>
freighter secret set <app/service> KEY            # asks for the value, without echoing it
freighter secret set <app/service> KEY --stdin    # reads it from standard input
```

```
$ printf %s "$DB_PASSWORD" | freighter secret set shop/web DATABASE_URL --stdin
$ freighter secret list shop/web
NAME           SET
DATABASE_URL   yes
SENTRY_DSN     no
```

`list` shows names and whether each has a value, never the value. A value is not accepted as an argument, so it never lands in your shell history. [Redeploy](/cli/deploy#redeploy) for a service to pick up a changed secret.

## domain

```sh
freighter domain list [app]
freighter domain add [app] <hostname> --service <service> [--http]
freighter domain verify [app] <hostname>
freighter domain remove [app] <hostname>
```

```
$ freighter domain add shop shop.example.com --service web
Added shop.example.com to shop/web. At your DNS provider, add:
  A      shop.example.com   203.0.113.7
Then run: freighter domain verify shop shop.example.com
$ freighter domain verify shop shop.example.com
shop.example.com is live (certificate issued)
```

`add` waits for nothing: the domain is *waiting for DNS* until `verify` finds the records (it also accepts a hostname proxied through Cloudflare). `--http` serves it without HTTPS. Removing a domain only updates routing; nothing is redeployed. See [Domains and HTTPS](/deploy/domains).

## volume

```sh
freighter volume list [app]
freighter volume password [app] <name>        # asks; or --stdin
```

The app's [volumes](/deploy/volumes), local and remote, with where each is mounted and whether it is. `password` sets the password of an SMB or NFS volume, write-only like a secret.

## git

An app that builds from a repository. See [Deploy from Git](/deploy/git).

```sh
freighter git show [app]
freighter git link [app] <repo> [--branch main] [--key <name>] [--subpath <dir>] [--no-auto]
freighter git check [app]
freighter git deploy [app] [--no-wait]
freighter git rotate-secret [app]
freighter git rotate-key [app]
freighter git unlink [app]
```

`link` points an existing app at a repository; to create the app from one, use [`deploy --git`](/cli/deploy#from-a-git-repository). `check` tests that the server can reach the repository with the key. `deploy` builds the branch head now. `rotate-secret` changes the webhook secret and prints the new one; `rotate-key` makes a new deploy key and prints its public half.
