# Recipes

## Deploy from CI
```yaml
env: { FREIGHTER_URL: ..., FREIGHTER_TOKEN: ${{ secrets.FREIGHTER_TOKEN }} }
run: |
  curl -fsSL "$FREIGHTER_URL/install-cli" | sh
  freighter deploy ./dist          # exit 0 live, 5 rolled back
```
Use a **deployer** token (`freighter token create ci --role deployer -q`).

## A service keeps restarting
1. `freighter ps shop` — `retrying` and rising RESTARTS.
2. `freighter logs shop/web -n 300` — the last crash reason.
3. `freighter secret list shop/web` — a declared secret with no value is the usual cause.
4. `freighter var list shop/web --resolved` — a connection that can't resolve is shown with the reason.
5. Fix, then `freighter redeploy shop` (secrets need a redeploy to be picked up).

## A deployment failed
`freighter deployment list shop --failed` → `deployment show <id>` (error + warnings) → `deployment logs <id>`. The previous release is still running; `rollback` is only needed if the failure came after the switch.

## Database dump / restore (needs admin)
```sh
freighter exec shop/db -- pg_dump -U shop shop | gzip > shop-$(date +%F).sql.gz
gunzip -c shop.sql.gz | freighter exec -i shop/db -- psql -U shop shop
```

## Change a variable across all services
`freighter var set shop KEY=VALUE` (app-level; a service's own value wins). To see where a value comes from: `var list shop --json | jq`.

## New server
`freighter server add contabo-2 --address 203.0.113.9` prints the enroll one-liner for that machine; then `freighter server check contabo-2`, and `freighter firewall contabo-2 enable` once SSH access is confirmed.
