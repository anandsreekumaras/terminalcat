# syntax=docker/dockerfile:1.9
#
# terminalcat — multi-stage Dockerfile.
#
# Use case: portable, sandboxed dev environment. The shell inside the
# container is the CONTAINER'S shell — it sees the container's filesystem
# and its own tmux server, NOT the host's. If you want web shell into a
# real VPS, use the bare-metal install (scripts/install.sh) instead. See
# the README's "Docker" section for the trade-offs.
#
# Build:   docker build -t terminalcat:local .
# Run:     docker compose up -d   (uses docker-compose.yml)

# ============================================================================
# Stage 1 — builder
# Compiles node-pty's native bindings, runs tsc, prunes dev deps.
# ============================================================================

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# python3 + build-essential — node-pty has no aarch64 prebuild and falls
# back to compiling from source. ca-certificates for HTTPS to the npm
# registry. None of this ships in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Install deps with the lockfile so the build is reproducible.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy the parts we actually compile / ship. Anything else (deploy/,
# scripts/, docs/, .git, etc.) is excluded via .dockerignore so it
# doesn't bloat the build context.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin

# Compile TS → dist/, then drop the dev-only deps (tsx, typescript,
# @types/*) from node_modules so the runtime image is lean.
RUN pnpm exec tsc -p . && pnpm prune --prod


# ============================================================================
# Stage 2 — runtime
# Minimal image: just Node + tmux + the built artifact. ~150 MB.
# ============================================================================

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# tmux is the entire reason terminalcat exists; install it.
# ca-certificates for the JWKS fetch (jose talks to <team>.cloudflareaccess.com).
# tini as PID 1 so SIGTERM (from `docker stop`) reaches our graceful-shutdown
# handler, not just node's default abrupt-exit behaviour.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/public        ./public
COPY --from=builder /app/bin           ./bin
COPY --from=builder /app/package.json  ./package.json

# Run as the unprivileged `node` user (already exists in the base image,
# uid 1000). Tmux sessions live in /home/node — mount a volume there in
# docker-compose.yml if you want persistence across `compose down`.
USER node

ENV NODE_ENV=production
ENV HOME=/home/node

# 7682 is bound on 127.0.0.1 inside the container. With
# `network_mode: host` (compose default) this is also the host's loopback.
# Without `network_mode: host`, you'd need to publish: `docker run -p 127.0.0.1:7682:7682`.
EXPOSE 7682

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
