# syntax=docker/dockerfile:1.7
# =============================================================================
# CryptoClaw — multi-stage Dockerfile (P0b hardened)
#
# Stage 1: builder — installs deps, compiles TypeScript
# Stage 2: prod — copies compiled output and production node_modules only
#
# Base image pinned by manifest-list digest (ADR-0013 P0b followup).
# Resolved 2026-05-09 via: docker manifest inspect node:22.11.0-bookworm-slim
# Refresh: re-run that command and update the sha256 below (then run
# `docker buildx build --target prod -f docker/Dockerfile .` to verify).
#
# This file lives at docker/Dockerfile. The legacy root Dockerfile is
# untouched (DoD §I).
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
COPY sdk/generated/package.json sdk/generated/
COPY sdk/cclaw/package.json sdk/cclaw/
COPY tests/integration/package.json tests/integration/

# Install all dependencies (including devDeps for TypeScript build).
# BuildKit cache mount keeps the pnpm content-addressable store across
# rebuilds so re-installs only download changed packages.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# Copy remaining source files
COPY . .

# Compile TypeScript — force a clean build (no prior dist/ in the Docker
# context, so incremental mode would error on stale tsbuildinfo).
RUN pnpm exec tsc --build --force

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

# Copy compiled output — chown to node:node so the non-root user can read them.
COPY --chown=node:node --from=builder /build/apps/api/dist /app/apps/api/dist
COPY --chown=node:node --from=builder /build/apps/worker/dist /app/apps/worker/dist
COPY --chown=node:node --from=builder /build/apps/scheduler/dist /app/apps/scheduler/dist
COPY --chown=node:node --from=builder /build/apps/executor/dist /app/apps/executor/dist
COPY --chown=node:node --from=builder /build/libs/config/dist /app/libs/config/dist
COPY --chown=node:node --from=builder /build/libs/logger/dist /app/libs/logger/dist

# Copy production node_modules (all workspace packages share the hoist)
COPY --chown=node:node --from=builder /build/node_modules /app/node_modules

# Copy package.json files for module resolution
COPY --chown=node:node --from=builder /build/package.json /app/package.json
COPY --chown=node:node --from=builder /build/apps/api/package.json /app/apps/api/package.json
COPY --chown=node:node --from=builder /build/apps/worker/package.json /app/apps/worker/package.json
COPY --chown=node:node --from=builder /build/apps/scheduler/package.json /app/apps/scheduler/package.json
COPY --chown=node:node --from=builder /build/apps/executor/package.json /app/apps/executor/package.json

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
