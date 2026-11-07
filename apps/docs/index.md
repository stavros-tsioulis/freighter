---
layout: home
hero:
  name: Freighter
  text: Deploy to your own servers, without containers.
  tagline: Describe an app in one app.yaml. Freighter runs it as hardened systemd services, routes traffic through HAProxy, checks it is healthy before switching, and rolls back on its own when it is not.
  actions:
    - theme: brand
      text: Set up a server
      link: /install/requirements
    - theme: alt
      text: Try it in Docker first
      link: /guide/try-it
---

<div class="vp-doc home-body">

## An app is a file

```yaml
name: shop

build:
  commands:
    - pnpm install --frozen-lockfile
    - pnpm build

services:
  web:
    command: node .output/server/index.mjs
    healthcheck: { path: /health }
    resources: { memory: 256M, cpu: 0.5 }
  worker:
    command: node dist/worker.js

environment:
  NODE_ENV: production
secrets:
  - DATABASE_URL
```

Push it to a Git branch, upload it as a `.tar.gz`, or run `freighter deploy` on the server. Each service becomes a systemd unit with memory and CPU limits, its own Unix user and a read-only view of the system. Add `shop.example.com` on the app's Domains tab and Freighter routes it through HAProxy with a Let's Encrypt certificate.

## What you get

- **Zero-downtime deploys** for web services: the new release starts on a fresh port, passes its health check, and only then receives traffic. The old one drains and stops.
- **Automatic rollback**: a release that crashes or fails its health check never replaces the one that is running.
- **Builds from Git** in a sandbox on the server, triggered by a signed push webhook.
- **A dashboard** for apps, deployments, logs, metrics, domains, secrets and servers.
- **Many servers, one dashboard**: remote servers run a small agent that the control server talks to over mutual TLS.
- **Your HAProxy stays yours**: Freighter only writes its own maps and backends next to your config.

## What it is not

Freighter is not a container platform and not a VM. Apps share the host kernel and are isolated with systemd's sandboxing. That suits apps you wrote or trust. For code you don't trust, use stronger isolation.

</div>
