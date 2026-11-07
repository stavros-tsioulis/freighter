For your setup, I'd recommend systemd + HAProxy + a lightweight deployment orchestrator, potentially one you build yourself.

You already have most of the infrastructure needed. Rather than introducing Docker, Kubernetes, or another container platform, I'd build around Linux's native service-management capabilities.

The interesting part is that systemd can act as your containerless application runtime, while a small management service provides the developer experience of Docker Compose, Coolify, or Dokku.

## 1. The architecture I'd recommend

One VPS, one systemd instance, a shared reverse proxy, and independently managed application processes.

The responsibilities are cleanly separated:

| Component          | Responsibility                                        |
| ------------------ | ----------------------------------------------------- |
| systemd            | Start, stop, restart, supervise, and isolate services |
| HAProxy            | Hostname routing, TLS, health checks, load balancing  |
| journald           | Collect service logs                                  |
| Deployment manager | Build, release, rollback, configure applications      |
| Management API/UI  | Give you a centralized view of services and servers   |
| Git/CI             | Build artifacts and trigger deployments               |

None of your applications needs to run inside a container.

## 2. Use systemd as your application runtime

systemd is already running on practically every mainstream Linux VPS distribution.

It offers many capabilities that people normally associate with a container orchestrator:

- Automatic restart on failure and startup on boot.
- Per-service CPU, memory, and task limits using cgroups.
- Process supervision and lifecycle operations.
- Service dependencies and startup ordering.
- Log capture through journald.
- Filesystem restrictions, user isolation, and other sandboxing controls.
- Socket activation and timer-based jobs.

For example, instead of running a Node application through PM2, Docker, or a custom daemon, you could use this:

```
# /etc/systemd/system/myapp.service

[Unit]
Description=My Application
After=network-online.target

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/srv/apps/myapp/current

ExecStart=/usr/bin/node dist/server.js

EnvironmentFile=/etc/myapps/myapp.env

Restart=on-failure
RestartSec=3

MemoryMax=256M
CPUQuota=80%

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

This gives you the essentials of a managed application service without a separate runtime daemon. Writable directories and executable paths need to be explicitly accommodated when using the stricter sandbox settings.

You can then operate it using:

```
systemctl start myapp
systemctl stop myapp
systemctl restart myapp
systemctl status myapp

journalctl -u myapp -f
```

You can also dynamically create transient services using `systemd-run`, although for persistent, version-controlled deployments I would generate unit files or use reusable template units.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.freedesktop.org\&sz=32)

freedesktop.org+1



## 3. Recreate Docker Compose's developer experience

This is where building your own software becomes worthwhile.

I'd introduce a declarative application manifest, for example `app.yaml`, that defines what an application needs.

```
name: myapp

source:
  type: git
  repository: git@github.com:org/myapp.git
  branch: main

build:
  commands:
    - pnpm install --frozen-lockfile
    - pnpm build

services:
  web:
    command: node .output/server/index.mjs
    port: 3100
    replicas: 1

    resources:
      memory: 256M
      cpu: 0.8

    healthcheck:
      path: /health
      interval: 10s

    restart: on-failure

  worker:
    command: node dist/worker.js

    resources:
      memory: 128M

environment:
  NODE_ENV: production

secrets:
  - DATABASE_URL
  - SESSION_SECRET
```

> **Amended:** `domains:` is no longer part of `app.yaml`. Domains are configured on the app (dashboard → app → Domains, `POST /v1/apps/:app/domains` followed by `.../verify`, or `freighter domain add` on the host) and stored on its server, so they survive redeploys and rollbacks and work the same for apps whose repository has no `app.yaml`. A manifest that still contains `domains:` is rejected with a message saying so.

This becomes the source of truth for your deployment manager.

A deployment would perform the following sequence:

1. Fetch source — Clone the requested Git commit or retrieve a compiled build artifact.
2. Build — Install dependencies and compile into an isolated release directory.
3. Prepare services — Allocate ports, inject environment configuration, generate systemd units.
4. Start and verify — Launch processes and confirm application health.
5. Switch traffic — Update HAProxy routing to healthy application instances.
6. Finalize — Record the deployment, remove obsolete processes, and retain a configurable number of releases.

One important limitation: building source directly on an unconstrained host is a security risk, particularly with third-party code. I'd favor CI-produced artifacts or an isolated build environment. The application runtime can still be completely containerless.

## 4. Keep HAProxy, but automate its configuration

I would absolutely keep your current HAProxy setup.

In fact, HAProxy has features that could make integrating it with your own management software easier than you might expect.

Two particularly useful capabilities are:

Hostname maps: Instead of maintaining many individual hostname ACLs, use a map from hostnames to backend names.

Runtime API: HAProxy supports modifying routing maps, inspecting backends, updating server state, and managing TLS certificate data without requiring a reload for every operation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.haproxy.com\&sz=32)

HAProxy config tutorials+1



There is one important caveat: runtime changes aren't necessarily persisted. Your manager should maintain the desired configuration on disk so changes survive HAProxy restarts. Dynamic servers, for instance, are not automatically restored after reloads.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.haproxy.com\&sz=32)

HAProxy Runtime API+1



### Zero-downtime deployments

I'd design your deployment system to support two concurrently running versions of the same application.

Before deployment

Version 1

HAProxy

App v1 — :3100

During deployment

Health checking

HAProxy

v1 :3100

Live traffic

v2 :3101

Health checks

After successful deployment

Version 2

HAProxy

App v2 — :3101

The old process is drained and stopped after new traffic has switched to v2.

If health checks fail, keep v1 serving traffic and terminate v2. If they succeed, switch routing and gracefully retire v1.

This achieves zero-downtime process replacement for suitably designed HTTP apps. Database migrations, background jobs, WebSocket connections, and long-lived requests require additional handling.

## 5. How I'd organize the VPS filesystem

A consistent filesystem layout is important when you're managing multiple projects.

```
/srv/apps/
  myapp/
    releases/
      20261106-001/
      20261106-002/
    current -> releases/20261106-002/
    shared/
      uploads/
      data/

  another-app/
    releases/
    current -> releases/...
    shared/

/etc/myapps/
  myapp.env
  another-app.env

/etc/systemd/system/
  myapp.service
  another-app.service

/etc/haproxy/
  haproxy.cfg
  maps/
    hostnames.map
```

Each release is immutable. Persistent data lives outside the release directory, and configuration is kept separate.

This makes rollback much easier than overwriting application files in place. The management system can select an earlier release and restart or switch traffic to it.

For deployments with no interruption, keep separate systemd units for the old and new release while transitioning traffic.

## 6. Existing solutions versus building your own

There are existing tools worth considering, although many deployment platforms assume Docker.

| Tool                     | Containers required? | Assessment                                              |
| ------------------------ | -------------------- | ------------------------------------------------------- |
| systemd + custom scripts | No                   | Best minimal foundation                                 |
| Ansible                  | No                   | Excellent for provisioning and repeatable configuration |
| Capistrano               | No                   | Useful SSH-based release deployment                     |
| PM2                      | No                   | Convenient for Node.js, but overlaps with systemd       |
| Dokku                    | Yes                  | Convenient PaaS, but not aligned with your requirements |
| Kamal                    | Yes                  | Strong deployment workflow, Docker-based                |

Dokku and Kamal both rely on container-based application deployment.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://kamal-deploy.org\&sz=32)

Installation+1



I would use Ansible for VPS provisioning and systemd for continuous supervision, with a thin custom deployment layer on top.

One qualification: Docker is not inherently too heavy for every small VPS. Its applications share the host kernel, and resource consumption depends heavily on what you run. However, if you don't need image isolation or container networking, eliminating that complexity is a reasonable design choice.

## 7. If you build your own management software

I'd design it as two components that can eventually support multiple VPSs.

Central control plane

Nuxt dashboard · API · SQLite

Application registry, desired configuration, deployment history, access control, orchestration.

Authenticated management connection

VPS Agent A

systemd, HAProxy, releases, resource metrics

VPS Agent B

systemd, HAProxy, releases, resource metrics

The agent would be a small executable responsible for applying changes to its local VPS. It wouldn't need to do much on its own.

I would implement it with a narrow set of operations:

- Install and manage application services.
- Stage, activate, and roll back releases.
- Allocate application ports and configure HAProxy.
- Manage secrets and environment configuration.
- Stream logs and report resource usage.
- Report health and deployment status.

For the API-to-agent communication, HTTPS with mTLS would be appropriate. For an initial single-VPS implementation, using SSH rather than a resident agent would be even simpler.

Crucially, don't give the management API unrestricted root shell execution. Use a dedicated privileged helper with a small, validated operation surface. Run each application under a separate unprivileged user with scoped filesystem access.

### Where AI agents fit

I'd put AI on top of this system, rather than making AI the system itself.

For example, an AI agent could inspect service logs, diagnose crash loops, identify configuration problems, propose resource-limit changes, or prepare an upgrade.

But service operations should remain deterministic. AI should invoke well-defined operations like `getServiceLogs`, `stageDeployment`, or `rollbackDeployment`, not freely execute arbitrary root commands on a production server.

Also, while systemd provides substantial sandboxing and resource controls, it is not an equivalent security boundary to a VM. For mutually untrusted applications or unsafe build scripts, stronger isolation is appropriate.

## 8. My suggested implementation order

For a small VPS, I'd start with the smallest possible useful system rather than immediately building a complete hosting platform.

| Phase | Deliverable                                                         |
| ----- | ------------------------------------------------------------------- |
| 1     | systemd service templates with restart policies and resource limits |
| 2     | Declarative YAML manifest and basic deployment CLI                  |
| 3     | Versioned releases, health checks, and rollback                     |
| 4     | Automated HAProxy routing and SSL integration                       |
| 5     | Central API, SQLite service registry, deployment history            |
| 6     | Nuxt dashboard for service status, deployments, logs, and metrics   |
| 7     | Remote VPS agents and multi-server orchestration                    |

I'd avoid introducing a queue, distributed scheduler, service discovery, or additional databases until the system genuinely needs them.

One other consideration is resource usage during deployments: running two versions temporarily doubles that application's process footprint. On a very constrained VPS, you may need to choose between brief downtime and peak memory requirements.

My preferred end state: a containerless, Compose-like deployment platform built on systemd and HAProxy, with a lightweight management plane that can eventually manage any number of Linux VPSs.

That lets you retain your existing networking and SSL setup, avoid unnecessary runtime overhead, and gradually evolve the system from a simple deployment CLI into a reusable infrastructure-management product.
