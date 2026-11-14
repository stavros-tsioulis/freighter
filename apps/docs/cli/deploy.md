# Deploy

## deploy

```sh
freighter deploy [path] [options]
```

Deploys what is at `path`: a directory (the default is `.`), a `.tar.gz`, or an `app.yaml` on its own. The app is the `name:` in `app.yaml`. A directory is packed first, without `.git` and what your `.gitignore` leaves out.

```
$ freighter deploy
Packing .   12.3 MB, 214 files
Deploying shop to freighter.example.com
  staging release r20261114-101502
  starting web, worker
  waiting for 2 services to be healthy
  switching shop.example.com
shop is live on r20261114-101502 (41s)
```

It waits for the deployment and exits when it is over. If a health check fails, the previous release keeps running, and the command says so and exits with `5`.

| Option | |
| --- | --- |
| `--app <name>` | the app, when it isn't the `name:` in `app.yaml` (it must match, so this only checks) |
| `--server <name>` | which server a **new** app goes on |
| `--no-wait` | print the deployment id and return |
| `--dry-run` | check `app.yaml` and show what would change; changes nothing |
| `-v, --verbose` | the whole deployment log instead of the steps |

### From an image

Nothing is uploaded: the server pulls it. See [Deploy images](/deploy/images).

```sh
freighter deploy --image ghcr.io/org/shop:1.4 --app shop --port 3000
freighter deploy                                  # an app.yaml whose services all have image:
```

| Option | |
| --- | --- |
| `--image <ref>` | the image to run (`docker://` prefix and digests are fine) |
| `--app <name>` | the app to create or update (required with `--image`) |
| `--port <n>` | the port the app listens on in the container, when the image doesn't say |
| `--login <host>=<user>` | which [registry login](/cli/access#registry) pulls it |

### From a Git repository

Freighter builds it on the server, and deploys on every push. See [Deploy from Git](/deploy/git).

```sh
freighter deploy --git git@github.com:org/shop.git --branch main
```

| Option | |
| --- | --- |
| `--git <repo>` | create the app from this repository (named after its `app.yaml`) |
| `--branch <name>` | default `main` |
| `--key <name>` | an imported [SSH key](/cli/access#ssh-key); without one a deploy key is made and printed |
| `--subpath <dir>` | where in the repository the app is |
| `--no-auto` | don't deploy on push |

## redeploy

```sh
freighter redeploy [app] [--no-wait]
```

Releases the app again with its current configuration: images are pulled again, a Git app is built from the branch head. Use it to pick up a new `latest`, or after changing a [secret](/cli/configure#secret).

## rollback

```sh
freighter rollback [app] [release] [--no-wait]
```

Back to the previous good release, or the one named. Configuration goes back with it.

## release

```sh
$ freighter release list shop
RELEASE              CURRENT  WHEN    RESULT
r20261114-101502     yes      2m ago  success
r20261113-174411              1d ago  success
r20261112-203648              2d ago  failed
```

## deployment

Every deploy, rollback and config change is a deployment.

```sh
freighter deployment list [app] [-n 20] [--failed]
freighter deployment show <id>
freighter deployment logs <id> [-f]
freighter deployment cancel <id>
```

`list` without an app shows the latest across all of them. `logs -f` follows one that is still running. `cancel` stops one that is queued or running (the previous release keeps running).
