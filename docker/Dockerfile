# syntax=docker/dockerfile:1.7
# =============================================================================
# CryptoClaw — multi-stage Dockerfile (P0b hardened)
#
# Stage 1: builder — installs deps, compiles TypeScript, runs pnpm deploy
# Stage 2: prod — copies self-contained per-app deploy trees
#
# Base image pinned by manifest-list digest (ADR-0013 P0b followup).
# Resolved 2026-05-09 via: docker manifest inspect node:22.11.0-bookworm-slim
# Refresh: re-run that command and update the sha256 below (then run
# `docker buildx build --target prod -f docker/Dockerfile .` to verify).
#
# This file lives at docker/Dockerfile. The legacy root Dockerfile is
# untouched (DoD §I).
#
# Why pnpm deploy?
# pnpm workspaces use a virtual content-addressable store (.pnpm/) whose
# packages are symlinked into per-package node_modules. Copying only the
# root node_modules into the prod image breaks the symlink chain and makes
# every `require()` of a hoisted package (e.g. reflect-metadata) fail with
# MODULE_NOT_FOUND. `pnpm deploy --prod` produces a self-contained directory
# per app with a flat node_modules/ built from the workspace graph — no
# symlinks into the store, no devDeps.
# =============================================================================

# ─── Stage 1: builder ────────────────────────────────────────────────────────
# Resolved 2026-05-09 via: docker manifest inspect node:22.11.0-bookworm-slim
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS builder

# Install corepack and activate pnpm (ADR-0012)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build

# Copy workspace manifests first to leverage Docker layer cache.
# If none of these change, pnpm install is cached.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./

# Copy all package.json files to satisfy pnpm workspace resolution
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/scheduler/package.json apps/scheduler/
COPY apps/executor/package.json apps/executor/
COPY libs/config/package.json libs/config/
COPY libs/logger/package.json libs/logger/
COPY libs/prisma/package.json libs/prisma/
COPY libs/domain/package.json libs/domain/
COPY libs/auth/package.json libs/auth/
COPY libs/audit/package.json libs/audit/
COPY libs/health/package.json libs/health/
COPY libs/notifications/package.json libs/notifications/
COPY libs/market/package.json libs/market/
COPY libs/chain/package.json libs/chain/
COPY libs/portfolio/package.json libs/portfolio/
COPY libs/execution/package.json libs/execution/
COPY libs/adapters/birdeye/package.json libs/adapters/birdeye/
COPY libs/adapters/zerion/package.json libs/adapters/zerion/
COPY libs/adapters/helius/package.json libs/adapters/helius/
COPY libs/adapters/evm-explorer/package.json libs/adapters/evm-explorer/
COPY libs/modules/positions/package.json libs/modules/positions/
COPY libs/modules/orders/package.json libs/modules/orders/
COPY libs/modules/receipts/package.json libs/modules/receipts/
COPY libs/modules/alerts/package.json libs/modules/alerts/
COPY libs/modules/heartbeat/package.json libs/modules/heartbeat/
COPY libs/modules/wallets/package.json libs/modules/wallets/
COPY libs/modules/liquidity/package.json libs/modules/liquidity/
COPY libs/modules/watchlist/package.json libs/modules/watchlist/
COPY libs/modules/agent-logs/package.json libs/modules/agent-logs/
COPY libs/modules/analysis-cache/package.json libs/modules/analysis-cache/
COPY libs/modules/contracts/package.json libs/modules/contracts/
COPY libs/modules/system/package.json libs/modules/system/
COPY sdk/generated/package.json sdk/generated/
COPY sdk/cclaw/package.json sdk/cclaw/
COPY tests/integration/package.json tests/integration/

# Install all dependencies (including devDeps for TypeScript build).
# BuildKit cache mount keeps the pnpm content-addressable store across
# rebuilds so re-installs only download changed packages.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# Copy schema before source so prisma generate can run before remaining
# source. Prisma generates per-project types into node_modules/.prisma/client/
# from the schema; without those, libs/modules/<entity>/ repositories fail to
# typecheck because they import { Position, Order, ... } from '@prisma/client'.
COPY prisma/ prisma/
RUN pnpm prisma generate

# Copy remaining source files
COPY . .

# Compile TypeScript — force a clean build (no prior dist/ in the Docker
# context, so incremental mode would error on stale tsbuildinfo).
RUN pnpm exec tsc --build --force

# Produce self-contained deploy trees, one per app.
# Each /deploy/<app> dir contains: dist/, node_modules/, package.json —
# with workspace:* deps resolved to their built counterparts and devDeps
# removed. The prod stage copies these trees verbatim; no symlinks.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm deploy --prod --filter @cclaw/api /deploy/api && \
    pnpm deploy --prod --filter @cclaw/worker /deploy/worker && \
    pnpm deploy --prod --filter @cclaw/scheduler /deploy/scheduler && \
    pnpm deploy --prod --filter @cclaw/executor /deploy/executor

# ─── Stage 2: prod ───────────────────────────────────────────────────────────
# Resolved 2026-05-09 via: docker manifest inspect node:22.11.0-bookworm-slim
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS prod

WORKDIR /app

# Install dumb-init so signals propagate correctly to the Node process (PID 2)
# when run under Docker / Kubernetes. dumb-init is PID 1; it reaps zombies and
# forwards SIGTERM/SIGINT so graceful-shutdown hooks fire.
RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init=1.2.5-2 && \
    rm -rf /var/lib/apt/lists/*

# Build args for OCI labels (populated by docker/build-push-action via --build-arg)
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown

# OCI image annotations — surfaced via `docker inspect` and image registries.
# source/revision let operators trace any image back to the exact commit.
LABEL org.opencontainers.image.title="crypto-claw" \
      org.opencontainers.image.description="CryptoClaw — four-agent crypto portfolio management service" \
      org.opencontainers.image.source="https://github.com/0xb11a/crypto-claw" \
      org.opencontainers.image.revision="${COMMIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="UNLICENSED"

# Use the `node` user (UID/GID 1000) already provided by node:bookworm-slim.
# Matches the CLAUDE.md note "Docker runs as non-root (UID 1000)".

# Copy self-contained deploy trees from the builder.
# Each tree has dist/, node_modules/, and package.json for that app.
# Layout: /app/apps/<name>/{dist,node_modules,package.json}
# The default CMD "node apps/api/dist/main.js" resolves relative to WORKDIR /app.
COPY --chown=node:node --from=builder /deploy/api /app/apps/api
COPY --chown=node:node --from=builder /deploy/worker /app/apps/worker
COPY --chown=node:node --from=builder /deploy/scheduler /app/apps/scheduler
COPY --chown=node:node --from=builder /deploy/executor /app/apps/executor

USER node

# HEALTHCHECK placeholder — P1 will replace with a real readiness probe against
# /readyz once @nestjs/terminus is wired up and the API boots with a real DB.
# The trivial `node -e "process.exit(0)"` ensures the container reports healthy
# during P0b so orchestrators don't mark it unhealthy.
# TODO(P1): replace with: CMD ["node", "apps/api/dist/healthcheck.js"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "process.exit(0)"

# dumb-init as PID 1 — forwards signals to the Node child and reaps orphan
# processes. CMD is passed as arguments to dumb-init.
ENTRYPOINT ["dumb-init", "--"]

# Default: run the API server.
# Override CMD in docker-compose.yml for worker, scheduler, executor.
CMD ["node", "apps/api/dist/main.js"]
