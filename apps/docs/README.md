# @freighter/docs

The Freighter documentation site, built with [VitePress](https://vitepress.dev). Content is Markdown under `guide/`, `install/`, `deploy/`, `operate/` and `reference/`. The sidebar lives in `.vitepress/config.ts`, and the theme (shared with the dashboard's look) is in `.vitepress/theme/`.

```sh
pnpm --filter @freighter/docs dev       # http://localhost:5173
pnpm --filter @freighter/docs build     # static site in .vitepress/dist
```

## Deploying with Freighter

`app.yaml` makes the site a Freighter app called `docs`. Link the repository with subdirectory `apps/docs` (the build installs and builds on the server), or build locally and upload:

```sh
pnpm --filter @freighter/docs build
tar -czf /tmp/docs.tgz -C apps/docs app.yaml serve.mjs .vitepress/dist
freighter deploy /tmp/docs.tgz
```

`serve.mjs` serves the built files on `$PORT` with clean URLs and a `/health` endpoint.

When behaviour changes in the code, update the matching page. The reference pages mirror `packages/core/src/config.ts` (config.yaml), `packages/manifest/src/schema.ts` (app.yaml), `apps/cli/src/commands/` (CLI) and `packages/api/src/app.ts` (API).
