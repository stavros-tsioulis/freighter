# syntax=docker/dockerfile:1
#
# A throw-away "clean server" for trying Freighter: Debian with systemd as PID 1, HAProxy and Node, with Freighter
# installed (units + CLI) but nothing deployed. Build context is the repository root:
#   docker build -f docker/Dockerfile --target server --build-arg ROLE=control .

# ---------- build the Freighter workspace ----------
FROM node:24-bookworm AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @freighter/cli --filter @freighter/agent --filter @freighter/dashboard build

# ---------- the "server" ----------
FROM debian:bookworm-slim AS server
ARG ROLE=control
ARG PUBLIC_HTTPS_PORT=8443
ENV container=docker DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus haproxy openssl ca-certificates curl tar gzip procps iproute2 less nano jq sudo util-linux git openssh-client openssh-server \
      podman uidmap slirp4netns fuse-overlayfs dbus-user-session \
 && rm -rf /var/lib/apt/lists/* \
 # Units that make no sense (or fail) inside a container.
 && systemctl mask getty.target console-getty.service systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service systemd-remount-fs.service sys-kernel-debug.mount sys-kernel-tracing.mount \
      apt-daily.timer apt-daily-upgrade.timer dpkg-db-backup.timer e2scrub_all.timer fstrim.timer

# Node (same Debian base as the build stage, so the binary runs as is) and the built workspace.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# npm and corepack too: builds run `pnpm`/`npm` (via corepack) as the sandboxed build user, and you may want them in a shell.
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable
COPY --from=build /app /opt/freighter

COPY docker/rootfs/ /
COPY docker/examples/ /opt/freighter-lab/examples/

# haproxy.cfg is the "existing" HAProxy config an operator would already have, plus the lines `freighter haproxy setup`
# prints. The redirect target must be the *published* HTTPS port so a browser on the host can follow it.
RUN sed -i "s/__PUBLIC_HTTPS_PORT__/${PUBLIC_HTTPS_PORT}/g" /etc/haproxy/haproxy.cfg \
 && chmod +x /usr/local/bin/freighter /usr/local/bin/freighter-agent /usr/local/bin/certbot /usr/local/bin/lab-post-receive /usr/local/bin/lab-git-demo \
 # HAProxy refuses to start with an empty certs dir, so ship a placeholder like the docs say.
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=lab-placeholder" \
      -keyout /tmp/p.key -out /tmp/p.crt 2>/dev/null \
 && cat /tmp/p.crt /tmp/p.key > /etc/haproxy/freighter/certs/lab-placeholder.pem && rm /tmp/p.key /tmp/p.crt \
 && chmod 600 /etc/haproxy/freighter/certs/lab-placeholder.pem \
 # The user that runs the API, and the directories the docs tell an operator to create.
 && useradd --system --home-dir /var/lib/freighter --shell /usr/sbin/nologin freighter \
 && install -d -o freighter -g freighter -m 0755 /var/lib/freighter \
 && install -d -o root -g freighter -m 0770 /var/lib/freighter/artifacts \
 && install -d -m 0755 /srv/apps /etc/freighter/apps /etc/freighter/agent \
 # A "git host" to deploy private repositories from over SSH: user `git` (git-shell only) that accepts one lab key.
 && useradd --create-home --shell /usr/bin/git-shell git && usermod -p '*' git \
 && install -d -o git -g git -m 0755 /home/git/repos /home/git/secrets \
 && install -d -m 0700 /home/git/.ssh && chown git:git /home/git/.ssh \
 && ssh-keygen -q -t ed25519 -N "" -C "freighter-lab" -f /opt/freighter-lab/lab_key \
 && install -m 0600 -o git -g git /opt/freighter-lab/lab_key.pub /home/git/.ssh/authorized_keys \
 && echo "${ROLE}" > /etc/freighter/lab-role \
 && systemctl enable haproxy freighter-agent ssh \
 && if [ "${ROLE}" = "control" ]; then systemctl enable freighter-api; fi \
 && ln -sf /opt/freighter-lab/examples /root/examples

STOPSIGNAL SIGRTMIN+3
WORKDIR /root
CMD ["/lib/systemd/systemd"]
