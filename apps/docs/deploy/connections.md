# Connections

A value in `environment:` can point at another service instead of spelling out its address, so a frontend finds its API without anyone copying a domain around:

```yaml
name: shop
services:
  web:
    command: node web.js
  api:
    command: node api.js
environment:
  API_URL: "@api.url"             # https://api.example.com
  API_HOST: "@api.domain"         # api.example.com
  API_LOCAL: "@api.internal"      # http://127.0.0.1:20003
  PAY_URL: "@billing/api.url"     # a service of another app in the same project
```

The syntax is `@service.attribute`, or `@app/service.attribute` for another app. It can sit anywhere in a value (`"@api.url/v1"`). Write `@@` for a literal `@`; an `@` straight after a letter or digit, as in an email address, is left alone.

| Attribute | Value |
| --- | --- |
| `domain` | the service's first domain |
| `url` | the domain with its scheme: `https://…`, or `http://…` when the domain is HTTP only |
| `internal` | `http://127.0.0.1:<port>`, for calls that stay on the server |
| `port` | the service's port |
| *any `environment:` name* | that value from the service's app, with its own connections resolved |

Values are filled in when the app goes live (a deploy, rollback or domain change), using the ports and domains in force then. If a connection can't be resolved, the deploy fails before anything is touched and says which one and why: no domain yet, no port, no such service. Secrets can't be referenced, because they are write-only.

## Across apps

`@app/service.attribute` works only between apps in the **same project**. `internal` also needs both apps on the same server; use `url` otherwise. The control plane tells each app's server about the other apps in its project before every deploy, so move an app into the project first.

## On the canvas

Environment is shared by all of an app's services, so each service of the app (other than the target) is shown as connected to what its environment points at. See [the project canvas](/operate/dashboard#project-canvas).
