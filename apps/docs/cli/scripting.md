# Scripting and CI

## A token for the job

Create one with the least role that does the job: **deployer** deploys, restarts and edits variables; **admin** is needed for secrets, `exec` and servers. Keep it as `FREIGHTER_TOKEN`, with `FREIGHTER_URL` next to it. With those two set there is nothing to sign in to.

```sh
freighter token create ci-github --role deployer -q
```

## Deploy from CI

```yaml
- name: Deploy
  env:
    FREIGHTER_URL: ${{ vars.FREIGHTER_URL }}
    FREIGHTER_TOKEN: ${{ secrets.FREIGHTER_TOKEN }}
  run: |
    curl -fsSL "$FREIGHTER_URL/install-cli" | sh
    freighter deploy ./dist
```

`deploy` waits and exits `0` when the new release is live, `5` when it failed and the old one is running. That is the whole check. See [Build in CI](/deploy/ci).

## JSON

`--json` prints one JSON value to standard output and nothing else, so `jq` can take it from there:

```sh
freighter ps shop --json | jq -r '.[] | select(.state != "running") | .name'
freighter app list --json | jq -r '.[].name'
```

The fields are the API's, in the same names as in the [HTTP API](/reference/api). Errors in `--json` mode are `{"error": {"code", "message"}}` on standard error, with the exit code as usual.

## Waiting

Commands that start work wait for it by default and show its steps. For a script that wants to carry on:

```sh
id=$(freighter deploy --no-wait -q)          # the deployment id
freighter deployment logs "$id" -f           # follow it
freighter deployment show "$id" --json | jq -r .status
```

`--timeout <duration>` (`10m`) on a waiting command gives up and exits `1` without cancelling the deployment.

## exec in scripts

`exec` passes through the command's exit code, standard output and standard error, so it composes:

```sh
freighter exec shop/web -- node scripts/migrate.mjs || { echo "migration failed"; exit 1; }
freighter exec shop/db -- pg_dump -U shop shop | gzip > shop-$(date +%F).sql.gz
gunzip -c shop.sql.gz | freighter exec -i shop/db -- psql -U shop shop
```

Don't use `-t` in a script: a terminal merges the two output streams and turns line endings into `\r\n`.

## Confirmations

Anything that can't be undone asks first when a terminal is attached, and refuses without one. Pass `--yes` when you mean it.
