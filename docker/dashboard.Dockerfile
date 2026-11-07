# syntax=docker/dockerfile:1
#
# The Freighter dashboard and API as a container, for hosts without systemd such as Railway. It is a control plane
# only (no agent, no apps): it manages the servers you enroll. Build context: the repository root.
#   docker build -f docker/dashboard.Dockerfile -t freighter-dashboard .
#   docker run -p 3000:3000 -v freighter-data:/var/lib/freighter -e FREIGHTER_BOOTSTRAP_TOKEN=fr_... freighter-dashboard

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @freighter/dashboard build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NITRO_HOST=::
# State lives here: the registry database, the private CA and the encryption key. Mount a volume on it.
# VOLUME /var/lib/freighter
WORKDIR /app
COPY --from=build /app/apps/dashboard/.output ./
EXPOSE 3000
# The platform's PORT wins (Railway sets it); 3000 otherwise.
CMD ["node", "--enable-source-maps", "server/index.mjs"]
