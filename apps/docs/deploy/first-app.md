# Your first app

This page deploys a small Node web server from a `.tar.gz`. The same app works with every other way of deploying.

## 1. Write the app

```js
// server.mjs
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3100);
createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.end(`${process.env.GREETING ?? "hello"} from ${process.env.HOSTNAME ?? "freighter"}\n`);
}).listen(port, "127.0.0.1");
```

Listen on `$PORT`. Once a domain points at the service, Freighter allocates its port for each release and passes it in that variable.

## 2. Describe it in app.yaml

```yaml
# app.yaml
name: hello

services:
  web:
    command: node server.mjs
    port: 3100
    resources:
      memory: 128M
    healthcheck:
      path: /health
      timeout: 20s
    environment:
      GREETING: hello

releases:
  keep: 5
```

Check it before you deploy:

```sh
freighter validate -f app.yaml
freighter unit web -f app.yaml      # prints the systemd unit Freighter will install
```

Every field is described in the [app.yaml reference](/reference/app-yaml).

## 3. Deploy

Pick whichever fits:

**From the dashboard.** Package the directory with `app.yaml` at the root of the archive:

```sh
tar -czf hello.tar.gz -C ./hello .
```

Then on the **Apps** page choose **Deploy**, then **Archive**, enter the app name `hello`, choose the file, and press **Upload and deploy**. The dialog follows the deployment until it succeeds or fails.

**From your machine or CI**, with a deployer token:

```sh
FREIGHTER_URL=https://freighter.example.com FREIGHTER_TOKEN=fr_… freighter push ./hello
```

`push` packs the directory, uploads it, and waits for the result.

**On the server itself**, as root:

```sh
freighter deploy ./hello -f ./hello/app.yaml
```

Add `--dry-run` to see what would change without changing anything.

## 4. Check it

```sh
freighter status hello
curl http://127.0.0.1:3100/
```

The app appears on the dashboard's **Apps** page with its services, release and status. Open it to see memory and CPU per service, deployments, logs and more.

## 5. Give it a domain

Open the app's **Domains** tab, add `hello.example.com` for the `web` service with automatic HTTPS, create the DNS record it shows, and press **Verify**. The domain goes live through a deployment, and the service now runs on a port Freighter allocates. See [Domains and HTTPS](/deploy/domains).

## What Freighter did

- Created the system user `hello` and the directories `/srv/apps/hello/{releases,shared}`.
- Unpacked the release into `/srv/apps/hello/releases/r20261107-142501/` and pointed `current` at it.
- Installed `freighter-hello--web.service` with `MemoryMax=128M`, the environment, and a sandbox (read-only system, private `/tmp`, no home directories, writable `shared/` only).
- Started it, polled `/health` until it answered, and recorded the deploy.

## Persistent data

Releases are replaced on every deploy, so never write data into the release directory. Use `/srv/apps/<app>/shared/`. It's owned by the app's user and is the only path the service can write to besides its private `/tmp`. Point your app at it with an environment value:

```yaml
services:
  web:
    environment:
      UPLOAD_DIR: /srv/apps/hello/shared/uploads
```
