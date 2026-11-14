# Freighter lab: two clean servers in Docker

A sandbox for trying Freighter the way you would on a fresh VPS. It gives you **two Debian servers with systemd as PID 1**, HAProxy and Node, with Freighter installed but nothing deployed:

| server | what runs | reachable from your machine |
| --- | --- | --- |
| `control` | HAProxy, `freighter-agent`, the API + dashboard | dashboard `http://localhost:3000` · apps `:8080` (http) / `:8443` (https) |
| `remote` | HAProxy, `freighter-agent` (not enrolled yet) | apps `:8081` (http) / `:8444` (https) |

Everything that matters is real: systemd units with memory/CPU limits and sandboxing, HAProxy routing and reloads, health checks, rollbacks, the root agent, mutual-TLS enrollment between the two servers. App host names use `*.localhost`, which resolves to your own machine, so no DNS or `/etc/hosts` edits are needed.

## Start

Needs Docker Desktop (or Docker with cgroup v2) and ~4 GiB of RAM.

```sh
pnpm lab:up                 # first run builds the images (a few minutes); same as ./docker/lab.sh up
pnpm lab:smoke              # optional: runs the whole walkthrough below against a fresh lab and prints PASS/FAIL
```

Every `lab.sh` command is also available through pnpm from the repo root: `pnpm lab <command>` (e.g. `pnpm lab token`, `pnpm lab shell remote`, `pnpm lab push hello`), plus the shortcuts `pnpm lab:up`, `pnpm lab:down`, `pnpm lab:smoke`.

`pnpm lab:down` (or `./docker/lab.sh down`) deletes both servers; the next `up` is a clean slate again (`stop`/`start` keep state).

## Walkthrough

**1. Sign in.** Create an admin token on the control server and use it at <http://localhost:3000>:

```sh
./docker/lab.sh token             # prints fr_… once
```

**2. Deploy an app** (pick one):

```sh
./docker/lab.sh push hello        # CLI, from docker/examples/hello
# or in the dashboard: Overview → Deploy app → upload a tarball:
tar -czf /tmp/hello.tgz -C docker/examples/hello .
```

Then open <http://hello.localhost:8080>. Redeploy while you refresh the page: traffic never drops (blue/green on HAProxy). Try `tls: auto`: `./docker/lab.sh push secure`, then <http://secure.localhost:8080> redirects to <https://secure.localhost:8443> (self-signed; accept the warning).

**3. Break things.** On the control server (`./docker/lab.sh shell`):

```sh
systemctl list-units 'freighter-*'                 # one unit per service/release, with limits
systemctl show -p MemoryMax,CPUQuotaPerSecUSec 'freighter-hello--web--*'
journalctl -u 'freighter-hello--web--*' -f         # the logs the dashboard shows
pkill -f 'node server.mjs'                         # systemd restarts it; Restarts goes up in the dashboard
```
Make `/health` fail in a copy of the example (or exit on start), deploy it, and watch it roll back automatically while the old release keeps serving.

**4. Manage a second server.** Either in the dashboard (**Servers → Add server**: name `remote`, address `remote`; it shows the enrollment command, with control URL `http://control:3000`) or in one go:

```sh
./docker/lab.sh enroll-remote                      # server add + freighter-agent enroll + restart + check
./docker/lab.sh push remote-hello remote           # deploy to the remote server
```
Open <http://remote-hello.localhost:8081>. The app is pinned to `remote`; deploying it to `local` is refused. `./docker/lab.sh shell remote` and `systemctl stop freighter-agent` makes it show as offline while `control` keeps working.

**5. Deploy from Git over SSH.** `control` doubles as the lab's git host: it runs `sshd` and a `git` user (git-shell only) that accepts one lab key, with repositories under `/home/git/repos`. `pnpm lab git-demo` imports that key into Freighter (**Settings → SSH keys**, or `freighter ssh-key import`), creates the repository `git@localhost:repos/gitdemo.git`, lets Freighter name the app from its `app.yaml`, links it and deploys it. A `post-receive` hook sends the signed push webhook, exactly the request GitHub would send.

```sh
pnpm lab git-demo                                   # first push builds and deploys; open http://gitdemo.localhost:8080
echo "Hello again" > docker/workspace/gitdemo/message.txt
pnpm lab git-push gitdemo "my change"               # push -> webhook -> clone over SSH -> sandboxed build -> deploy
pnpm lab git-demo remote                            # same, but the app is built and run on the remote server (needs enroll-remote first)
```
Try it in the dashboard too: **Settings → SSH keys → Import key** (paste the output of `pnpm lab shell` → `cat /opt/freighter-lab/lab_key`), then **Overview → New app from Git** with `git@localhost:repos/<name>.git` after `lab-git-demo init <name> git-hello` (run it inside `pnpm lab shell`). Pick the key, watch the branch list fill, and see “Will deploy as …” before you deploy.

Watch the deployment appear with its commit and live build log under **gitdemo → Deployments**, and the repository settings under **Source**. The page shows who built it (`freighter-build`, the sandbox user). Break the build (`pnpm lab shell`, then `lab-git-demo break gitdemo`, `lab-git-demo push gitdemo`) and see the previous version keep serving. For `gitremote` the clone happens on the remote server, which reaches `git@control:repos/gitremote.git` with the key Freighter sent it over mutual TLS (deleted again right after the clone). See [docs/git-deploys.md](../docs/git-deploys.md).

**Your own apps:** put a directory with an `app.yaml` (see `docker/examples/hello`) in `docker/workspace/` and run `./docker/lab.sh push /work/<dir> [remote]`. Services must listen on `$PORT` if a domain points at them. Domains are not in `app.yaml`: add them on the app's Domains tab (add, then verify DNS), with `POST /v1/apps/<app>/domains` and `.../verify`, or `freighter domain add <app> host=web:off` (the lab's example apps get theirs from `lab.sh`).

## What is simulated (and what is not)

* **The git host is a plain `sshd` + git-shell on `control`**, not GitHub or GitLab: no web UI, no accounts, one lab key (generated into the image at build time, so never reuse it anywhere). The push webhook is sent by a hook that signs it the way GitHub does; with the real GitHub/GitLab you would add the webhook yourself and it must be reachable from the Internet.
* **certbot is a shim.** Without public DNS and an Internet-reachable port 80 nothing could be issued, so `/usr/local/bin/certbot` writes a **self-signed** certificate where Let's Encrypt would. It exercises the rest of the `tls: auto` path (PEM assembly, HAProxy reload, renewal checks) but not ACME itself.
* **Docker, not a VM.** The containers are `privileged` with the host cgroup namespace so systemd can manage cgroups and namespaces like on a real server. Firewalls, kernel upgrades, reboots of the real host and Ansible provisioning are not covered.
* **Not hardened for exposure.** Ports are published on all interfaces by Docker; keep this on a development machine.
* The dashboard is reached directly on `:3000`; in production you would route it through HAProxy like any other app.

## Layout

```
docker/
  Dockerfile        build stage (pnpm install, dashboard build) + the "clean server" image
  compose.yaml      control + remote
  lab.sh            up / down / shell / token / enroll-remote / push / smoke …
  rootfs/           files placed on the servers: haproxy.cfg (with the lines `freighter host haproxy setup` prints), units, config, wrappers
  examples/         hello, secure (tls: auto), remote-hello
  workspace/        your own apps (mounted at /work on control)
```

## Troubleshooting

* *`up` hangs or systemd does not boot*: Docker needs cgroup v2 (current Docker Desktop has it). Check `./docker/lab.sh logs control`.
* *Port already in use*: change the published ports in `compose.yaml`. If you change the HTTPS ones (8443/8444), also change the matching `PUBLIC_HTTPS_PORT` build arg so HTTP→HTTPS redirects point at the right port.
* *Code changes*: rebuild with `docker compose -f docker/compose.yaml up -d --build` (state of recreated containers is reset).
