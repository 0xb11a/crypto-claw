# =============================================================================
# CryptoClaw — multi-stage Dockerfile (P0a, 2-stage)
#
# Stage 1: builder — installs deps, compiles TypeScript
# Stage 2: prod — copies compiled output and production node_modules only
#
# Hardening (P0b): multi-arch, trivy, cosign, syft, non-root user tightening.
# This file lives at docker/Dockerfile. The legacy root Dockerfile is
# untouched (DoD §I).
# =============================================================================

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:22.11.0-bookworm-slim AS builder

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

# Install all dependencies (including devDeps for TypeScript build)
RUN pnpm install --frozen-lockfile

# Copy remaining source files
COPY . .

# Compile TypeScript
RUN pnpm build

# ─── Stage 2: prod ───────────────────────────────────────────────────────────
FROM node:22.11.0-bookworm-slim AS prod

WORKDIR /app

# Create non-root user (Docker best practice; UID 1000 matches CLAUDE.md note)
RUN groupadd --gid 1000 node-app && \
    useradd --uid 1000 --gid 1000 --no-create-home --shell /bin/false node-app

# Copy compiled output
COPY --from=builder /build/apps/api/dist /app/apps/api/dist
COPY --from=builder /build/apps/worker/dist /app/apps/worker/dist
COPY --from=builder /build/apps/scheduler/dist /app/apps/scheduler/dist
COPY --from=builder /build/apps/executor/dist /app/apps/executor/dist
COPY --from=builder /build/libs/config/dist /app/libs/config/dist
COPY --from=builder /build/libs/logger/dist /app/libs/logger/dist

# Copy production node_modules (all workspace packages share the hoist)
COPY --from=builder /build/node_modules /app/node_modules

# Copy package.json files for module resolution
COPY --from=builder /build/package.json /app/package.json
COPY --from=builder /build/apps/api/package.json /app/apps/api/package.json
COPY --from=builder /build/apps/worker/package.json /app/apps/worker/package.json
COPY --from=builder /build/apps/scheduler/package.json /app/apps/scheduler/package.json
COPY --from=builder /build/apps/executor/package.json /app/apps/executor/package.json

USER node-app

# Default: run the API server.
# Override CMD in docker-compose.yml for worker, scheduler, executor.
CMD ["node", "apps/api/dist/main.js"]
