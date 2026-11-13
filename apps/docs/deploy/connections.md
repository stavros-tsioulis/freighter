# Connections

A value in a service's `environment:` can point at another service instead of spelling out its address, so a frontend finds its API without anyone copying a domain around:

```yaml
name: shop
services:
  web:
    command: node web.js
    environment:
      API_URL: "@api.url"             # https://api.example.com
      API_HOST: "@api.domain"         # api.example.com
      API_LOCAL: "@api.internal"      # http://127.0.0.1:20003
      PAY_URL: "@billing/api.url"     # a service of another app in the same project
  api:
    command: node api.js
```

In the dashboard, typing `@` in a value lists the services, other apps' services and storages you can point at, filtered as you type; after the dot it lists the attributes and the service's variables.

The syntax is `@service.attribute`, or `@app/service.attribute` for another app. It can sit anywhere in a value (`"@api.url/v1"`). Write `@@` for a literal `@`; an `@` straight after a letter or digit, as in an email address, is left alone. The braced form `${service.attribute}` (or `${app/service.attribute}`) is the same reference and works right against other text; a literal `${` is written `$${`. Braces around anything else, such as `${HOME}`, are left as they are.

| Attribute | Value |
| --- | --- |
| `domain` | the service's first domain |
| `url` | the domain with its scheme: `https://…`, or `http://…` when the domain is HTTP only |
| `internal` | `http://127.0.0.1:<port>`, for calls that stay on the server |
| `port` | the service's port |
| *any `environment:` name* | that value from the service's own `environment:`, with its own connections resolved |

Values are filled in when the app goes live (a deploy, rollback or domain change), using the ports and domains in force then. A service with no domain gives an empty string for `.domain` and `.url`. Any other connection that can't be resolved fails the deploy before anything is touched, and says which one and why: no port, no such service. Secrets can't be referenced, because they are write-only.

## A service's own variables

`@self.NAME` (or `${self.NAME}`) is that value from the same service, so one value can be built from others without repeating them:

```yaml
environment:
  DB_HOST: db.internal
  DB_PORT: "5432"
  DATABASE_URL: "postgres://@self.DB_HOST:@self.DB_PORT/app"
```

In a URL, use the braced form, so the `@` between the password and the host stays a plain `@`: `redis://${self.REDIS_USER}:${self.REDIS_PASSWORD}@${self.REDIS_HOST}` gives `redis://user:secret@host`. Only plain variables can be used: a [secret](/deploy/secrets) can't be referenced.

It is the same as writing the service's own name (`@web.DB_HOST` in the service `web`), and values can build on values that themselves use `@self`. A value that leads back to itself, directly or through others, is refused with the chain (`web.A -> web.B -> web.A`). `@self` works in a service's own `environment:`, not in the app-level one. A service that is itself called `self` keeps `@self` for itself.

## When something changes

If a domain, port, variable or key that an app connects to changes, Freighter re-resolves the app's connections and redeploys its current release when a value it reads is now different, with the usual health check and rollback. The deployment says why ("restarted because billing changed"). Nothing happens when the values are the same.

## Across apps

`@app/service.attribute` works only between apps in the **same project**. `internal` also needs both apps on the same server; use `url` otherwise. The control plane tells each app's server about the other apps in its project before every deploy, so move an app into the project first.

## Volumes

`@volume:name.path` is the path a volume has for the service that holds the reference: where the service asked to see it, or the folder on the server for a command service that doesn't attach it. `@volume:shared.path` is the app's shared directory. See [volumes](/deploy/volumes).

## S3 storages

`@storage:name.attribute` reaches an [S3 storage](/deploy/storage): `url`, `domain`, `internal`, `publicUrl` (the [public endpoint](/deploy/storage#public-storage)), `region`, `accessKey` and `secretKey`. Storages are global, so they work from any project. The key pair is delivered through a root-only file instead of the unit.

## On the canvas

An arrow starts at the service whose `environment:` holds the reference. See [the project canvas](/operate/dashboard#project-canvas).
