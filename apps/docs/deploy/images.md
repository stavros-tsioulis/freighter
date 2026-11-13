# Deploy images

A service can run a container image instead of a command. Freighter pulls the image on the server, runs it with Podman under systemd, and gives it the same zero-downtime releases, health checks, rollbacks, domains and secrets as any other service. Use it for software that ships as an image, or for apps you already build into one.

Images are optional. Apps that run a command need no container runtime, and a server only needs Podman if one of its apps uses an image.

## Prepare the server

Install Podman when you set up the server, or add it later by re-running the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --role agent --with-containers
```

You can also do this from the dashboard: on a remote server's page, under *Agent and software*, **Containers → Add container support…** runs the installer with that flag for you.

`--with-containers` (or `FREIGHTER_WITH_CONTAINERS=1`) installs `podman`, `uidmap`, `slirp4netns`, `fuse-overlayfs`, `dbus-user-session` and, where the release has it, `passt`. Upgrades keep what's installed. Servers without Podman refuse an image deploy with a message saying so.

Containers run rootless, as the app's own user. The first image deploy for an app gives that user a range of subordinate user ids and a private runtime directory under `/run` (`/run/freighter-<app>`, created by the unit itself). No login session or `systemd-logind` is needed, so this works on minimal server images too.

## Describe the app

```yaml
name: shop

services:
  web:
    image: ghcr.io/acme/shop:1.4
    port: 3000              # where Freighter publishes it, on 127.0.0.1
    containerPort: 8080     # where the image listens (default: the one port the image declares)
    healthcheck:
      path: /health
    resources:
      memory: 512M
      cpu: 1
    volumes:
      uploads: /var/uploads
    secrets:
      - DATABASE_URL
```

- The service's `environment`, its secrets and `PORT` are passed into the container. Secrets never appear on a command line.
- `resources` limit the whole container.
- `volumes` are directories under `/srv/apps/<app>/shared/volumes/<name>`. They survive releases and are removed with the app. See [volumes](/deploy/volumes) for command services and for SMB and NFS shares.
- Add a [domain](/deploy/domains) to route traffic to the service. Routed services get a fresh port per release, and traffic moves over once the new container is healthy.
- `build:` doesn't apply to images, and an app can mix image and command services.

## Deploy

In the dashboard, **Apps → Deploy → Container image** takes an app name, one or more image services (image, ports, volumes, limits, health check, environment, secret names) and, with several servers, the server to run on. It shows the equivalent `app.yaml`, then pulls the image and follows the deployment's log. It warns if the server has no Podman.

With the [CLI](/reference/cli#push), against your control server:

```sh
freighter push app.yaml --url https://freighter.example.com --token $FREIGHTER_TOKEN
# or, without a file
freighter push --image ghcr.io/acme/shop:1.4 --name shop --port 3000
```

There is nothing to upload: the server pulls the image. The deployment log shows the pull, the resolved digest, the health check and the traffic switch, in the dashboard under **Deployments** like any other.

On the server itself, `sudo freighter deploy -f app.yaml` does the same.

### Pinned digests

Tags move. When a release is built, Freighter pulls the image, records its digest (`ghcr.io/acme/shop@sha256:…`) in the release, and runs that digest. So a [rollback](/deploy/rollbacks) returns to exactly the image that release was verified with, even if the tag now points somewhere else. Old images are removed when the releases that used them are pruned (`releases.keep`).

### Redeploy a tag

Pushed a new `:latest` or fixed `:1.4`? Pull it again and release the result. In the dashboard, open the app's **Source** tab and choose **Pull again and redeploy**; **Change image** on a service runs a different image (usually a new tag) and keeps the rest of `app.yaml`. From the CLI:

```sh
freighter redeploy shop
```

It reuses the app's current `app.yaml`, so only the image changes. If the new image fails its health check, the old release keeps serving.

## Private registries

Public images need nothing. For a private registry, save a login (admin token), in the dashboard under **Registry logins** or with the CLI. It's stored encrypted, sent to the server only for the pull, and never shown again:

```sh
echo "$GHCR_TOKEN" | freighter registry add ghcr.io --username acme --password-stdin
freighter registry list
freighter registry remove ghcr.io
```

You can also add a login right where you need it (admins): the **Deploy → Container image** form lists each registry its images come from and offers **Add login for a private image**; an app's **Source** tab has **Add login** next to a registry without one; and when a pull fails with an authentication error, the deployment shows **Add or replace the login** for that registry, after which **Back to the form** keeps what you typed so you can deploy again. Deployers who can't add logins are told to ask an admin.

Use `docker.io` for Docker Hub.

### Several logins for one registry

A registry can have more than one login (say, two GitHub accounts). Each app pulls with the one chosen for it, per registry. In **Deploy → Container image**, a registry with several logins shows a **Pull with** picker, and the deploy button waits until you choose; the choice is remembered for the app, so redeploys, **Pull again** and **Change image** use it. Change it any time on the app's **Source** tab. From the CLI, `freighter push app.yaml --login ghcr.io=alice` chooses (and remembers) it, and `freighter registry remove ghcr.io --username alice` says which login to delete. With one login for a registry nothing needs choosing. With several and no choice, a deploy is refused rather than guessing which account to use. A login applies to every image from that registry host. Prefer an access token with read-only access to the package over a password.

## From CI

Build and push the image, then tell Freighter to pull it:

```yaml
- run: docker build -t ghcr.io/acme/shop:${{ github.sha }} . && docker push ghcr.io/acme/shop:${{ github.sha }}
- run: |
    sed -i "s|image: .*|image: ghcr.io/acme/shop:${{ github.sha }}|" app.yaml
    freighter push app.yaml
  env:
    FREIGHTER_URL: ${{ vars.FREIGHTER_URL }}
    FREIGHTER_TOKEN: ${{ secrets.FREIGHTER_TOKEN }}
```

A unique tag per build, as here, gives the deployment history something readable to show. With a moving tag, run `freighter redeploy shop` instead.

Over the API, `POST /apps/:app/image-deployments` takes `{"manifest": "<app.yaml text>"}` and `POST /apps/:app/redeploy` takes no body. See the [API reference](/reference/api#images-and-registries).

## Limits

- Podman only; there is no Docker support. Images must be pullable by Podman (`linux/amd64` or `linux/arm64`, matching the server).
- One container per service and one instance per service, like other services.
- Containers are rootless and use user networking, so they can't bind ports below 1024. Inside a container `127.0.0.1` is the container itself; the server's loopback is `host.containers.internal` (`10.0.2.2`). That is how a container reaches another service's published port, for example `host.containers.internal:24814`. It also means a container can reach anything listening on the server's loopback, including other apps' ports, so run only images you trust.
- Apps linked to a Git repository can use image services too, but private registry logins aren't passed to Git deploys yet. Deploy those through **Deploy → Container image** or `freighter push`.
- The dashboard's **Container image** form needs every service to be an image. To mix in command services, upload an archive.
