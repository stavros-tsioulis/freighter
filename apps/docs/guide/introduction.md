# Introduction

Freighter deploys applications to Linux servers you control. It gives you the workflow of a hosted platform (push to deploy, rollbacks, domains with HTTPS, logs, a dashboard) while running everything with tools that are already on the server: **systemd** supervises the processes and **HAProxy** routes the traffic.

There is no cluster, and by default no container runtime or image registry. An app is a directory with an `app.yaml` in it. A release is that directory, unpacked under `/srv/apps/<app>/releases/`. A service is a systemd unit. Software that ships as a container image can run too, through [rootless Podman](/deploy/images), under the same unit.

## Who it is for

Freighter fits if you:

- run a handful of apps on one or a few VPSs,
- already use, or are happy to use, HAProxy in front of them,
- want deploys that are safe by default without learning an orchestrator,
- deploy code you wrote or trust, written in anything that runs as a Linux process (Node, Python, Go, Ruby, a static binary).

## The pieces

| Piece | What it does | Where it runs |
| --- | --- | --- |
| `freighter-agent` | The privileged helper. Installs units, unpacks releases, writes HAProxy files, requests certificates, reads logs. | Every server, as root |
| API and dashboard | Keeps state in SQLite, serves the web UI and the HTTP API, asks agents to act. | The control server, as the `freighter` user |
| `freighter` CLI | Deploys and operates apps from a shell on the server, manages tokens and servers, or pushes builds from CI. | Servers and CI |

The **control server** (sometimes called the master) is the one machine that runs the API and dashboard. By default it only manages: your apps run on the servers you add. It can also [run apps itself](/install/control-server#also-run-apps-on-this-server), through an agent that appears as the server called `local`. Other machines are **remote servers**. They only run the agent, and the control server reaches them over mutual TLS on port 7443.

You can stop at one server. Everything works with only the control server, and remote servers are added later when you need them.

## Where to start

- To see it working before touching a real server, follow [Try it locally](/guide/try-it). It starts two disposable servers in Docker.
- To install it, read [Requirements](/install/requirements), then [Set up the control server](/install/control-server).
- To understand the vocabulary first, read [Concepts](/guide/concepts).
