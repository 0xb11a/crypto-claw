# CryptoClaw Operator Runbook

**Status:** Stub. Sections are filled in as phases complete; `[TBD]` marks work that lands in a later phase.

This runbook is the operator's first stop for any non-trivial operation against a deployed CryptoClaw stack. It complements `SPEC.md` (architecture) and `docs/decisions/` (rationale).

---

## 0. Local development (P0a)

This section covers the monorepo workflow introduced in P0a. The legacy
`scripts/` and `tests/test-*.js` system continues to work alongside it.

### Prerequisites

- Node.js 22.11.0 (use `.nvmrc`: `nvm use` or `fnm use`)
- pnpm 9.15.0 (enabled via corepack: `corepack enable && corepack prepare pnpm@9.15.0 --activate`)

### First-time setup

```bash
# From repo root:
pnpm install
```

### Develop

```bash
# Type-check the whole monorepo:
pnpm typecheck

# Lint (TS + legacy JS):
pnpm lint

# Run unit + integration tests:
pnpm test

# Run unit tests only (fast, no build needed):
pnpm test:unit

# Run integration tests (requires prior pnpm build to produce dist/ artifacts):
pnpm build && pnpm test:integration

# Start the API in watch mode (requires ts-node and tsconfig-paths):
pnpm dev:api

# Start the worker in watch mode:
pnpm dev:worker
```

### Build

```bash
# Compile all apps and libs to dist/:
pnpm build
```

### Container smoke test

```bash
docker buildx build --target prod -f docker/Dockerfile -t cclaw:smoke .
```

### §0.1 Local development with Docker Compose

`docker/docker-compose.dev.yml` provides a full local stack using the
`builder` image stage (not `prod`) so `tsx` and source files are available
for HMR.  The production stack is the legacy root `docker-compose.yml`
until P6 cutover.

```bash
# Start all services (api, worker, scheduler, executor stubs, redis):
docker compose -f docker/docker-compose.dev.yml up

# In a separate terminal — tail all logs:
docker compose -f docker/docker-compose.dev.yml logs -f

# Rebuild after dependency changes:
docker compose -f docker/docker-compose.dev.yml build

# Stop and remove containers (volumes kept):
docker compose -f docker/docker-compose.dev.yml down
```

Services:

| Service | Port | Notes |
|---|---|---|
| redis | 127.0.0.1:6379 | redis:7-alpine with healthcheck |
| api | 127.0.0.1:7878 | `pnpm --filter @cclaw/api dev` (tsx HMR) |
| worker | — | `pnpm --filter @cclaw/worker dev` |
| scheduler | — | `pnpm --filter @cclaw/scheduler dev` |
| executor | — | stub — exits with boot-defense banner (P3 wires signer) |

The bind-mount (`..:/build`) means edits to `apps/` or `libs/` are
reflected immediately in the running containers.  The anonymous
`/build/node_modules` volume prevents the host `node_modules/` from
masking the in-image installation (critical on macOS with native binaries).

`main.yml` runs on both `v2` and `main` branches during the rewrite
(P0b–P3); it reduces to `main`-only at P4 cutover (ADR-0011).

### §0.2 Pulling published images and verifying signatures

After a push to `v2` or `main` fires `main.yml`, images land at
`ghcr.io/0xb11a/crypto-claw`.

**Pull by sha tag:**

```bash
docker pull ghcr.io/0xb11a/crypto-claw:sha-<7chars>
```

**Verify cosign signature (keyless OIDC — ADR-0015):**

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/0xb11a/crypto-claw/\.github/workflows/main\.yml@.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/0xb11a/crypto-claw:sha-<7chars>
```

The `--certificate-oidc-issuer` is always `https://token.actions.githubusercontent.com`
(GitHub's public OIDC endpoint), NOT the Sigstore public-good instance.
If the workflow file is ever renamed the regexp pattern must change — see
ADR-0015 for the trade-off and ADR-0014 for the registry choice.

**Verify SBOM attestation:**

```bash
cosign verify-attestation \
  --type spdxjson \
  --certificate-identity-regexp '^https://github.com/0xb11a/crypto-claw/\.github/workflows/main\.yml@.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/0xb11a/crypto-claw:sha-<7chars>
```

Both commands exit 0 on success.  The attestation predicate is valid
SPDX-JSON (check with `| jq .payload | base64 -d | jq .`).

**Note on trivy gate (ADR-0016):** The `scan` job in `main.yml` runs
`severity: CRITICAL, ignore-unfixed: true` in P0b–P5.  A nightly scan
(P0c) will add a non-blocking HIGH advisory.  The gate tightens to
`HIGH,CRITICAL` in P6 alongside the distroless migration.

### Legacy system

The legacy agent scripts and tests are not in the pnpm workspace. Run them
as before:

```bash
cd tests && node run-all.js --offline
```

---

## 1. Provisioning a fresh host

[TBD — fills in during P6]

Outline:
- Host requirements: Docker Engine ≥ 24, compose v2, ≥ 2 vCPU, ≥ 4 GB RAM, ≥ 20 GB disk.
- Layout: `~/crypto-claw/{data,secrets,agents,.env.runtime}`.
- First-time setup: copy `.env.runtime.example` → `.env.runtime` (mode 0600); copy `secrets/signer.env.example` → `secrets/signer.env` (mode 0400); `docker compose pull && docker compose up -d`.
- Verify boot self-check, health endpoints, audit log first row.

## 2. Token rotation

[TBD — fills in during P1]

Outline:
- Edit `.env.runtime`, regenerate the affected `*_API_KEY` with `openssl rand -base64 32 | tr -d '/+=' | head -c 32`.
- `docker compose up -d --no-deps --force-recreate api worker scheduler` (and `agents` if the rotated token is its `CCLAW_API_TOKEN`).
- Verify: old token → 401 within 1 s of restart; audit log captures attempt with the previous identity.
- Multi-token rotation: rotate one identity at a time; agents reading the old token continue working until their container restart picks up the new value.

## 3. Backup (SQLite + Redis snapshots)

[TBD — fills in during P6]

Outline:
- Daily SQLite online backup runs as a scheduler job: `sqlite3 data/<SAFE_ID>.db ".backup data/backups/<SAFE_ID>-$(date +%F).db"`.
- Retention policy: 30 daily snapshots; older pruned on rotation.
- Redis (BullMQ state) is ephemeral by design; not backed up.
- Optional Litestream sidecar for continuous WAL streaming to S3-compatible storage; documented as opt-in.
- Manual on-demand backup: `docker compose exec scheduler node dist/apps/scheduler/cli/backup-now.js`.

## 4. Restore from backup

[TBD — fills in during P6]

Outline:
- `docker compose down`.
- Move corrupt DB aside: `mv data/<SAFE_ID>.db data/<SAFE_ID>.db.broken-$(date +%s)`.
- Copy snapshot: `cp data/backups/<SAFE_ID>-YYYY-MM-DD.db data/<SAFE_ID>.db`.
- `docker compose up -d`. Verify health endpoints and tail of audit log for backfilled state.
- Document the time window of lost activity in `docs/incidents/`.

## 5. Upgrade (image bump)

[TBD — fills in during P6]

Outline:
- Update the image tag in `docker-compose.yml` (e.g., `:vX.Y.Z` → `:vX.Y.Z+1`).
- `docker compose pull` to fetch the new image.
- `docker compose up -d`. Compose recreates containers in dependency order.
- `apps/api`'s entrypoint runs `prisma migrate deploy` automatically (advisory-lock-guarded); worker and scheduler wait for the migration row before reaching ready.
- Verify: tail `docker compose logs -f api` for `[boot] config OK; routes guarded; signer keys absent`.
- If api is unhealthy after 60 s, compose halts the recreate of dependents — diagnose before forcing.

## 6. Rollback (image downgrade)

[TBD — fills in during P6]

Outline:
- Forward-only migrations: rollback usually requires no DB action.
- Pin the previous image tag in `docker-compose.yml`; `docker compose pull && docker compose up -d`.
- If the rolled-back version's schema can't read the current DB shape (i.e., the upgrade introduced a destructive migration): restore from the most recent backup *before* the upgrade, then redeploy the prior tag.
- `prisma migrate resolve --rolled-back <migration-name>` if Prisma's migration history needs explicit reconciliation.

## 7. Multi-fund deployment

[TBD — fills in during P6]

Outline:
- One compose stack per `SAFE_ID`. Place each in its own directory: `~/crypto-claw/<SAFE_ID>/`.
- Each stack has its own `.env.runtime`, `secrets/signer.env`, and `data/<SAFE_ID>.db`.
- Different host port mappings to avoid collisions on `127.0.0.1:7878`.
- One Redis per stack (no cross-fund queue sharing).

## 8. Investigating a failed write (audit log)

[TBD — fills in during P1]

Outline:
- `cclaw system audit --since 2h --status 4xx,5xx` to list recent failed writes.
- `cclaw system audit --identity EXECUTOR --since 24h` to scope by identity.
- Audit rows include the redacted body and the error kind. Cross-reference with `docker compose logs api worker` filtered by request-id (logged on every request).

## 9. Stuck job / queue drain

[TBD — fills in during P3]

Outline:
- `cclaw system queues` to list BullMQ queues with depth and processing counts.
- `cclaw system queues drain --queue <name> --confirm` to drop pending jobs from a runaway queue.
- Failed jobs land in BullMQ's dead-letter; inspect via `cclaw system queues failed --queue <name>`.

## 10. Emergency stop

[TBD]

Outline:
- `docker compose stop scheduler worker` halts new jobs and the approval bot.
- `apps/api` keeps serving — `cclaw orders cancel --id <id>` for any in-flight orders.
- For a full halt: `docker compose down`. Existing in-flight executor children finish their transaction (Safe / Squads) but no new orders are issued.
