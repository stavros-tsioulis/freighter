# Try it locally

The Freighter repository includes a **lab**: two clean Debian servers in Docker, with systemd running as PID 1, HAProxy and Node installed, and Freighter set up but nothing deployed. Everything that matters is real. Units have limits, HAProxy reloads, health checks and rollbacks run, and the two servers enroll over mutual TLS.

You need Docker Desktop (or Docker with cgroup v2), about 4 GiB of free memory, Node 24 and pnpm.

```sh
git clone https://github.com/stavros-tsioulis/freighter.git
cd freighter
pnpm install
pnpm lab:up        # builds the images on first run, a few minutes
```

| Server | Runs | From your machine |
| --- | --- | --- |
| `control` | HAProxy, agent, API and dashboard | dashboard on `http://localhost:3000`, apps on `:8080` and `:8443` |
| `remote` | HAProxy, agent (not enrolled yet) | apps on `:8081` and `:8444` |

## Walkthrough

**Sign in.** Print an admin token and paste it at `http://localhost:3000`:

```sh
pnpm lab token
```

**Deploy an app**, then open `http://hello.localhost:8080`:

```sh
pnpm lab push hello
```

Refresh the page while you deploy it again. Traffic never drops. `pnpm lab push secure` deploys an app with `tls: auto` (the lab's certbot writes a self-signed certificate, so accept the browser warning).

**Break something.** Open a shell on the server with `pnpm lab shell` and kill the process with `pkill -f 'node server.mjs'`. systemd restarts it and the restart count goes up in the dashboard. Deploy a copy of the example whose `/health` returns 500 and watch it roll back while the old release keeps serving.

**Add the second server**, from the dashboard (**Servers**, then **Add server**, with name `remote` and address `remote`) or in one step:

```sh
pnpm lab enroll-remote
pnpm lab push remote-hello remote     # then open http://remote-hello.localhost:8081
```

**Deploy from Git.** `control` doubles as a Git host over SSH:

```sh
pnpm lab git-demo                                  # creates a repo, links it, first build and deploy
echo "Hello again" > docker/workspace/gitdemo/message.txt
pnpm lab git-push gitdemo "my change"              # push, webhook, sandboxed build, deploy
```

`pnpm lab:smoke` runs all of the above against a fresh lab and prints PASS or FAIL. `pnpm lab:down` deletes both servers.

## What the lab simulates

- **Certificates** come from a stand-in `certbot` that writes self-signed certificates, because Let's Encrypt can't reach a laptop. Everything around them (PEM files, HAProxy reloads, renewal checks) is real.
- **The Git host** is plain `sshd` with `git-shell`. Its webhook is signed exactly as GitHub signs one.
- **Docker is not a VM.** Firewalls, reboots and provisioning aren't covered, and the published ports aren't hardened, so keep the lab on a development machine.
