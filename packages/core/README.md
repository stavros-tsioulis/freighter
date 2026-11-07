# @freighter/core

Deploy engine. All I/O goes through `Deps` (`deps.ts`), so tests use temp dirs and a fake host. `defaultDeps({ prefix })` relocates everything under a directory and no-ops host commands for local runs.

## Layout (per app, under `/srv/apps/<app>`)
```
releases/<id>/     immutable release (id = rYYYYMMDD-HHMMSS[-n]); contains app.yaml
current -> releases/<id>
shared/            persistent data, owned by the app user
history.jsonl      append-only deploy/rollback log
state.json         live routed instances (unit, port, hostnames)
(<appsRoot>/.lock  host-wide lock held while a deploy/rollback runs)
```

## Deploy
1. validate manifest, require secrets, take the per-app lock
2. stage the artifact (dir or `.tar.gz`) into a new release, write its `app.yaml`
3. `applyRelease`: repoint `current`, install/enable units, remove units of dropped services, restart
4. **verify** (skip with `--no-verify`):
   - service with `healthcheck`: poll `http://127.0.0.1:<port><path>` each second until 2xx or `healthcheck.timeout`; fail fast on a crash
   - service without: must still be `active` with no restarts after a 3 s settle window
5. success → record history, prune to `releases.keep` (default 5; current and previous are always kept)
6. failure → previous release is re-applied automatically and the command exits 1 with the failing checks and the last journal lines. A failed *first* deploy stops the services.

**Routed vs in-place.** A service that one of the app's domains points at is *routed* (domains are configured on the app, stored in `<apps>/<app>/domains.json`, and are not part of `app.yaml`; `setDomains` redeploys the current release with new routing): each release runs as its own instance unit (`freighter-<app>--<service>--<release>`) on a port Freighter allocates (passed as `$PORT`; the manifest `port` is ignored). The new instance is health-checked first, then HAProxy is switched, then the old instance drains and stops, so there is no downtime and a failed release never receives traffic. Services without a domain (workers, fixed-port internals) are restarted in place with a short gap.

All units run from `releases/<id>/` rather than `current`; `state.json` records the live port/unit/hostnames per routed service. Deploys hold a host-wide lock so port allocation and HAProxy writes never interleave. See `packages/haproxy/README.md` for the HAProxy and TLS setup.

## Rollback
`freighter rollback <app> [release]` re-applies the previous good release (or the one named) and verifies it. `freighter releases <app>` lists releases (`*` = current).

## Local run (no root, no systemd)
```sh
pnpm --filter @freighter/cli dev deploy ../../examples/hello -f ../../examples/hello/app.yaml --prefix /tmp/freighter-demo
pnpm --filter @freighter/cli dev deploy ../../examples/hello -f ../../examples/hello/app.yaml --prefix /tmp/freighter-demo
pnpm --filter @freighter/cli dev releases hello --prefix /tmp/freighter-demo
pnpm --filter @freighter/cli dev rollback hello --prefix /tmp/freighter-demo
```
(`--prefix` skips verification since nothing really runs.)

## On a Linux VPS (as root)
```sh
freighter deploy ./hello -f ./hello/app.yaml && curl localhost:3100
# make /health return 500, redeploy: expect an automatic rollback and the old version still answering
freighter releases hello
freighter rollback hello
# two deploys at once: the second is rejected by the lock
```
