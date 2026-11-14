# Build in CI

If you'd rather build in GitHub Actions or GitLab CI and keep toolchains off your servers, build there and upload the result. No deploy key or webhook is needed.

1. Create a token with the **deployer** role (**API tokens**, then **New token**, or `sudo -u freighter freighter host token create ci-github --role deployer`).
2. Store it as the CI secret `FREIGHTER_TOKEN`, and your Freighter URL as `FREIGHTER_URL`.
3. Package everything the server needs to run the app (`app.yaml`, build output, production dependencies) as a `.tar.gz` with `app.yaml` at its root. `name:` in `app.yaml` decides which app is deployed.

## GitHub Actions

```yaml
name: deploy
on:
  push:
    branches: [main]

concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: corepack enable && pnpm install --frozen-lockfile && pnpm build
      - name: Package
        run: tar -czf artifact.tar.gz --exclude=.git --exclude=artifact.tar.gz .
      - name: Upload and wait for the deployment
        env:
          FREIGHTER_URL: ${{ vars.FREIGHTER_URL }}
          FREIGHTER_TOKEN: ${{ secrets.FREIGHTER_TOKEN }}
          APP: myapp                      # must equal name: in app.yaml
        run: |
          set -euo pipefail
          id=$(curl -fsS -X POST "$FREIGHTER_URL/api/v1/apps/$APP/deployments" \
                 -H "Authorization: Bearer $FREIGHTER_TOKEN" -H "Content-Type: application/gzip" \
                 --data-binary @artifact.tar.gz | jq -r .id)
          for _ in $(seq 1 300); do
            d=$(curl -fsS "$FREIGHTER_URL/api/v1/deployments/$id" -H "Authorization: Bearer $FREIGHTER_TOKEN")
            case "$(jq -r .status <<<"$d")" in
              success) echo "deployed $(jq -r .releaseId <<<"$d")"; exit 0 ;;
              failed)  echo "::error::$(jq -r .error <<<"$d")"; exit 1 ;;
            esac
            sleep 2
          done
          echo "::error::timed out waiting for the deployment"; exit 1
```

The Freighter repository has this pipeline and a GitLab one in `docs/ci/`.

## With the CLI

With the CLI on the runner (`curl -fsSL "$FREIGHTER_URL/install-cli" | sh`), `freighter deploy` does the packing, upload and waiting:

```sh
freighter deploy ./dist-app            # FREIGHTER_URL and FREIGHTER_TOKEN are in the environment
```

| Flag | Meaning |
| --- | --- |
| `--url`, `--token` | API base URL and token. `$FREIGHTER_URL` and `$FREIGHTER_TOKEN` are used when omitted. |
| `--server NAME` | the server for a *new* app. Existing apps stay on theirs. |
| `--no-wait` | return as soon as the deployment is queued |

## Limits

Uploads may be up to `api.maxUploadMb` (200 MB by default), and the receiving agent caps them at `agent.maxArtifactMb`. Archives are unpacked as root by the agent, so only give the deployer role to people and pipelines you'd trust to run code on the server.
