# Environment and secrets

Environment belongs to a service: each service gets only its own values. They come from three places, applied in this order (later ones win):

1. **`environment:` under the service in `app.yaml`.** Plain values that are fine to commit.
2. **Secrets**, from `/etc/freighter/apps/<app>/<service>.env` on the app's server.
3. **`PORT`**, when the service has a port (allocated for routed services, `port:` otherwise). It always wins.

## Declare secrets

List the names under the service that needs them. A name can't be both a plain value and a secret of the same service.

```yaml
services:
  web:
    command: node server.js
    environment:
      NODE_ENV: production
    secrets:
      - DATABASE_URL
      - SESSION_SECRET
  worker:
    command: node worker.js
    secrets:
      - DATABASE_URL
```

A secret needed by two services is set once for each.

Names are `UPPER_SNAKE_CASE`. A deploy fails until every declared secret has a value, so set them before the first deploy. The service's **Variables** tab warns about declared names that aren't set yet, with a button to set each one.

## Set a value

**Dashboard (admin).** Select the service, open its **Variables** tab, and in the *Secrets* section press **Set secret**, enter the name and value, and save.

**API (admin).**

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":"postgres://…"}' https://freighter.example.com/api/v1/apps/shop/services/web/env/DATABASE_URL
```

**CLI**, on the app's server, as root:

```sh
freighter env set shop web DATABASE_URL=postgres://…
printf '%s' "$VALUE" | freighter env set shop web SESSION_SECRET    # value from stdin keeps it out of shell history
freighter env list shop web                                         # names only
```

Values can't contain newlines.

## Values are write-only

Once saved, a value can't be read back through the dashboard, the API or the CLI. Only names are listed. The API doesn't store or log values: it passes them to the agent, which writes them to the app's server in a root-owned `0600` file for that service. To change a value, set it again.

New values take effect when the service next starts: restart the service, or deploy.

## What builds see

Nothing. Builds from Git run without the app's environment or secrets. If a build needs a token (a private package registry, for example), commit a config that reads it at runtime instead, or build in CI.
