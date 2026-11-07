# Environment and secrets

Services get their environment from three places, applied in this order (later ones win):

1. **`environment:` in `app.yaml`.** Plain values that are fine to commit.
2. **Secrets**, from `/etc/freighter/apps/<app>.env` on the app's server.
3. **`PORT`**, when the service has a port (allocated for routed services, `port:` otherwise). It always wins.

## Declare secrets

List the names in `app.yaml`. A name can't be both a plain value and a secret.

```yaml
environment:
  NODE_ENV: production
secrets:
  - DATABASE_URL
  - SESSION_SECRET
```

Names are `UPPER_SNAKE_CASE`. A deploy fails until every declared secret has a value, so set them before the first deploy. The app's **Secrets** tab warns about declared names that aren't set yet, with a button to set each one.

## Set a value

**Dashboard (admin).** On the app's **Secrets** tab, press **Set secret**, enter the name and value, and save.

**API (admin).**

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":"postgres://…"}' https://freighter.example.com/api/v1/apps/shop/env/DATABASE_URL
```

**CLI**, on the app's server, as root:

```sh
freighter env set shop DATABASE_URL=postgres://…
printf '%s' "$VALUE" | freighter env set shop SESSION_SECRET    # value from stdin keeps it out of shell history
freighter env list shop                                         # names only
```

Values can't contain newlines.

## Values are write-only

Once saved, a value can't be read back through the dashboard, the API or the CLI. Only names are listed. The API doesn't store or log values: it passes them to the agent, which writes them to the app's server in a root-owned `0600` file. To change a value, set it again.

New values take effect when the service next starts: restart the service, or deploy.

## What builds see

Nothing. Builds from Git run without the app's environment or secrets. If a build needs a token (a private package registry, for example), commit a config that reads it at runtime instead, or build in CI.
