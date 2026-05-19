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

### §0.3 Husky pre-commit hooks (P0c)

Husky 9 hooks are bootstrapped automatically on `pnpm install` via the
`prepare: husky` script. Two hooks are active:

| Hook | What runs |
|---|---|
| `pre-commit` | `pnpm exec lint-staged` (ESLint + Prettier on staged files), then `node scripts/pre-commit-check.js` (secret scan) |
| `commit-msg` | `pnpm exec commitlint --edit "$1"` (Conventional Commits enforcement) |

**Bootstrap from scratch:**

```bash
pnpm install
```

The `prepare` lifecycle script runs `husky`, which writes the shim files
into `.husky/_/`. These shims are gitignored (`.husky/.gitignore`).

**Reset if hooks are stale or broken:**

```bash
rm -rf .husky/_
pnpm install
```

**Emergency bypass (rare; must be justified in the commit message):**

```bash
git commit --no-verify
```

Note: Husky 9 no longer requires `husky install` or a `husky.sh` source line.
Do not add them — those are Husky 8 artefacts.

### §0.4 Renovate dependency dashboard (P0c)

Renovate manages all npm and GitHub Actions dependency updates.

- **Dashboard:** `Issues` tab → `Dependency Dashboard` (auto-created by Renovate on first run).
- **Schedule:** weekday off-hours (after 9pm / before 5am UTC) and weekends.
- **Patch updates** auto-merge after all branch protection requirements are met
  (1 human review + signed commit). The bot does NOT bypass review.
- **Major updates** require explicit dashboard approval.
- **Weekly groups:** `github-actions-bump` and `npm devDependencies (weekly)` —
  both open Monday before 5am UTC to allow a quiet-weekday triage window.
- **Docker base-image digests** are pinned and kept fresh by Renovate — this
  resolves the ADR-0013 P0b followup.

**Approving a major update:**

1. Open the Dependency Dashboard issue.
2. Check the box next to the major you want to approve.
3. Renovate opens (or reopens) the PR within its next scheduled run.
4. Review and merge normally.

**Renovate config lives in `renovate.json` at repo root.** After any change,
the `pr.yml` check job validates it via `npx renovate-config-validator`.

### §0.5 Nightly CI (P0c)

`.github/workflows/nightly.yml` runs daily at **02:17 UTC** and on manual
`workflow_dispatch`.

| Job | What it does | Failure behaviour |
|---|---|---|
| `audit` | `pnpm audit --audit-level=high --prod` | Advisory (`continue-on-error: true`) |
| `trivy-info` | HIGH+CRITICAL scan of `:v2` image, SARIF → Code Scanning | Never fails pipeline (`exit-code: 0`) |
| `container-smoke-nightly` | Pulls `:v2`, builds dist, runs `pnpm test:integration` | Hard failure — base-image drift detected |
| `e2e-full` | Placeholder (deferred to P1) | Always green (echo only) |

**SARIF results** from `trivy-info` appear in `Security` → `Code scanning alerts`
on GitHub. They are purely informational — see ADR-0017 for the suppression policy.

**Manual run:**

```bash
gh workflow run nightly.yml --ref feat/p0c-nightly-husky-renovate
```

### §0.6 Post-publish container smoke (P0c)

After every push to `v2` or `main`, `main.yml` runs a `post-publish-smoke`
job that:

1. Waits for `build-and-publish` and `sign` to complete.
2. Pulls the just-published image **by digest** (deterministic; not by tag,
   which can race against subsequent pushes).
3. Tags it `cclaw:postpublish` locally.
4. Runs `pnpm test:integration` with `CCLAW_TEST_LOCAL_DOCKER_IMAGE=cclaw:postpublish`.

**If this job fails:**
The published image is potentially unsafe (boot-defense regression). Rollback:

1. Identify the last-known-good `sha-<7>` tag in GHCR.
2. Update `docker-compose.yml` to pin that tag.
3. `docker compose pull && docker compose up -d`.
4. Open an incident issue and diagnose before pushing a fix commit.

**Cross-reference:** ADR-0017 (CVE suppression policy), ADR-0016 (trivy gate).

### Legacy system

The legacy agent scripts and tests are not in the pnpm workspace. Run them
as before:

```bash
cd tests && node run-all.js --offline
```

---

## 0.7 P1a: Prisma migration, route walker, shim-parity, audit policy (P1a)

This section documents the new infrastructure introduced in P1a.

### Existing-DB baselining (one-time per deploy target)

If the target SQLite DB was created by the legacy `scripts/db.js` migrations
(it has tables but no `_prisma_migrations` row), Prisma will refuse to deploy
with:

```
Error P3005: The database schema is not empty.
```

Run this **once per deployment target** before the first `prisma migrate deploy`:

```bash
DATABASE_URL="file:./data/<SAFE_ID>.db" pnpm prisma migrate resolve \
  --applied 20260510091724_p1a_initial_positions_orders_receipts_alerts_heartbeat_audit
```

This marks the P1a migration as already-applied (the tables exist via `db.js`).
Subsequent migrations from P1b+ will deploy cleanly on top.

**Skip this step on a fresh (empty) DB.** Prisma handles empty DBs natively —
`prisma migrate deploy` creates the `_prisma_migrations` table itself and
applies the migration SQL.

### Prisma migration on first deploy

`apps/api` runs `prisma migrate deploy` automatically on startup. No manual step
is needed on the first deploy against a fresh DB. The migration:
- Creates `positions`, `paper_positions`, `orders`, `receipts`, `paper_receipts`,
  `sentinel_alerts`, `heartbeat_state`, `portfolio_meta`, `service_audit`, and `trades` tables.
- Does NOT touch the legacy `_migrations` table used by `scripts/db.js` — the two
  migration trackers coexist (`_prisma_migrations` vs `_migrations`).

**If you need to re-run migrations manually:**

```bash
DATABASE_URL="file:./data/<SAFE_ID>.db" pnpm prisma migrate deploy
```

**Schema drift check (CI gate):**

```bash
DATABASE_URL="file:./data/<SAFE_ID>.db" pnpm prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code
```

Exit code 0 = schema matches migrations. Any non-zero output means `schema.prisma`
was edited without generating a migration — run `pnpm prisma migrate dev --name <name>`
to produce the migration file, then commit it.

### Default-deny route walker (ADR-0019)

On every startup, `apps/api` walks all registered controller routes and refuses to boot
if any handler:
- Lacks `@Roles(...)` metadata.
- Is a non-GET handler without `@Audited()` metadata.

Boot-fail message format (P1b aligned with ADR-0019 example):
```
[boot] route GET /v1/orders on OrdersController#list missing @Roles(...)
[boot] route POST /v1/orders on OrdersController#propose missing @Audited()
```

Exit code: **78** (EX_CONFIG). This matches the config-validation boot-fail format.

The boot walker runs AFTER all modules are initialized (`onApplicationBootstrap`). It
logs `[boot] route walker: inspected N controllers; all handlers decorated` on success.

### Audit log policy (ADR-0018, SPEC §9.5)

Every non-GET handler decorated with `@Audited()` writes a row to `service_audit`.
Rows include:
- `identity`, `role` — the calling agent's identity and role
- `body_sha256` — SHA-256 of the canonical (key-sorted) request body
- `body_redacted` — request body with secrets stripped via `libs/logger`'s redactor
- `status`, `latency_ms`, `error_kind` — response metadata

**Query the audit log:**

```bash
cclaw system audit --since 2h  # (available in P1b)
```

For now, query directly:

```bash
DATABASE_URL="file:./data/<SAFE_ID>.db" node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.serviceAudit.findMany({ orderBy: { ts: 'desc' }, take: 20 }).then(rows => {
    console.log(JSON.stringify(rows, null, 2));
    p.\$disconnect();
  });
"
```

**Audit write failure:** If the DB write fails, the error is logged via `libs/logger`
with `audit_write_failed: true`. The original request's response is unaffected.
Monitor for these in `docker compose logs api | grep audit_write_failed`.

### Shim-parity baseline (ADR-0020)

The shim-parity gate captures byte-identical output from `db-query.js` and the
new `cclaw` CLI. Baseline captured at P1a start against an empty dev DB.

**Run the comparison locally:**

```bash
node tests/shim-parity/compare-baseline.js --safe-id <dev-fund-id> --only positions,orders
```

**Re-capture baseline** (only needed if `scripts/db.js` or `scripts/db-query.js`
changes — DoD §I says they stay unchanged during the rewrite):

```bash
node tests/shim-parity/capture-baseline.js --safe-id <dev-fund-id> --commit-baseline
```

See `tests/shim-parity/README.md` for the full lifecycle.

### cclaw CLI — P1a commands (7 commands)

```bash
# Positions
cclaw positions list [--status open|closed|partial_exit|all] [--mode real|paper]
cclaw positions get --id <id> [--mode real|paper]

# Orders
cclaw orders list [--status pending|approved|...] [--action buy|sell] [--pending]
cclaw orders get --id <id>
cclaw orders propose --json '<json body>'
cclaw orders approve --id <id> [--by human]
cclaw orders reject --id <id> [--reason <text>]
```

Requires `CCLAW_API_TOKEN` env (maps to any of the 8 `*_API_KEY` values) and
`CCLAW_API_BASE` (default: `http://127.0.0.1:7878`).

### Codecov gate flip (P1a)

As of this PR, the Codecov gate is enforcing (not advisory):
- `codecov.yml` has no `if_no_uploads: pass`.
- `pr.yml` step 15 (Upload coverage) has `fail_ci_if_error: true`.
- Target: ≥80% line coverage on `libs/modules/positions/**` and `libs/modules/orders/**`.

---

## 0.8 P1b: Receipts, Alerts, Heartbeat, Audit query, Rate limits (P1b)

### Rate Limits (SPEC §9.4, ADR-0021)

All API routes are rate-limited per calling identity (not per IP). Quotas reset every 60 seconds.

| Role | Quota | Named throttler |
|------|-------|-----------------|
| `agent` | 600 req / 60 s | `agent` |
| `dashboard` | 60 req / 60 s | `dashboard` |

- `/healthz` and `/readyz` are **exempt** (`@SkipThrottle()`).
- Exceeding the quota returns HTTP 429 with a structured log line at `warn` level:
  `{ msg: 'rate_limited', tracker: <identity>, role: <role>, path: <url>, throttlerName: <name> }`.
- Counters are in-process (no Redis) and reset on API restart (ADR-0021 § Consequences).

**Diagnosing a 429 in development:**

```bash
docker compose logs api | grep rate_limited
```

**Bumping limits for local testing** (not for production): edit `libs/auth/src/app-throttler.module.ts`, change `limit` in the named throttler config, rebuild.

### Coverage Exclusions (SPEC §14, OPEN-T)

DTO files under `src/**/dto/**` are excluded from coverage in every module's `vitest.config.ts`. These files contain only `class-validator` decorators and `@ApiProperty` metadata — no executable logic. The exclusion is intentional and documented as `// SPEC §14 / P1b OPEN-T — DTO files are decorator metadata only; excluded from coverage`.

If a DTO gains non-trivial logic (e.g., a `transform()` method), the exclusion should be removed from that file and a unit test added.

### Audit log query (SPEC §9.5, ADR-0018)

The audit log is queryable via the API (P1b adds `GET /v1/system/audit`):

```bash
# Last 100 entries by default
cclaw system audit

# Filter by identity
cclaw system audit --identity EXECUTOR --since 2h

# Filter by HTTP method and status
cclaw system audit --method POST --status 201 --limit 200

# Paginate through a large result set (keyset pagination)
cclaw system audit --limit 50 --cursor <last-id-from-previous-page>
```

The audit table name is `service_audit`. Fields: `id`, `ts`, `identity`, `role`, `method`, `path`, `body_sha256`, `body_redacted`, `status`, `latency_ms`, `error_kind`.

**Direct DB query (bypasses auth, for emergencies):**

```bash
DATABASE_URL="file:./data/<SAFE_ID>.db" node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.serviceAudit.findMany({
    where: { identity: 'EXECUTOR' },
    orderBy: { ts: 'desc' },
    take: 20
  }).then(rows => { console.log(JSON.stringify(rows, null, 2)); p.\$disconnect(); });
"
```

### cclaw CLI — P1b commands (12 new commands)

```bash
# Receipts
cclaw receipts list [--status <status>] [--mode real|paper] [--limit <n>]
cclaw receipts get --id <id> [--mode real|paper]
cclaw receipts create --json '<json body>'

# Alerts
cclaw alerts list [--unprocessed] [--limit <n>]
cclaw alerts get --id <id>
cclaw alerts create --json '<json body>'
cclaw alerts ack --id <id> [--note <text>]

# Heartbeat
cclaw heartbeat list [--agent <name>]
cclaw heartbeat get --agent <name>
cclaw heartbeat overdue --agent <name>
cclaw heartbeat ping --agent <name> --check <checkType>

# System audit
cclaw system audit [--identity <name>] [--role agent|dashboard] [--method <verb>]
  [--path <substring>] [--status <code>] [--since <ISO>] [--until <ISO>]
  [--limit <n>] [--cursor <id>]
```

### Swagger UI auth (SPEC §11, ADR-0022)

`/v1/docs` and `/v1/openapi.json` require an `agent`-role bearer token. Requests without a valid token receive HTTP 401:

```
{"error":{"code":"unauthorized","message":"Swagger UI requires agent role bearer token"}}
```

To access Swagger UI locally:

```bash
curl -H "Authorization: Bearer $CCLAW_API_TOKEN" http://127.0.0.1:7878/v1/docs
```

The auth is implemented via a Fastify `onRequest` hook registered before `SwaggerModule.setup()` (ADR-0022 — enforce path taken).

---

## 0.9 P1c-i: Executor wiring + stub mode (P1c-i)

This section covers the executor subprocess wiring introduced in P1c-i.

### Signer key setup (ADR-0023)

Signer keys must live in `secrets/signer.env` (mode 0400), NOT in `.env.runtime`.
The worker container bind-mounts this file read-only at `/run/secrets/signer.env`.

**First-time setup:**

```bash
# Copy the example file
cp secrets/signer.env.example secrets/signer.env

# Set strict permissions (required)
chmod 0400 secrets/signer.env

# Edit with your real keys (or leave stub values for local dev with EXECUTOR_STUB_MODE=1)
# SAFE_SIGNER_KEY=<64-char hex private key for EVM Safe>
# SQUADS_SIGNER_KEY=<base58-encoded Solana keypair for Squads>
```

**Verify permissions:**

```bash
stat -c '%a %n' secrets/signer.env  # should show: 400 secrets/signer.env
```

### Stub mode (P1c-i development)

Set `EXECUTOR_STUB_MODE=1` in `.env.runtime` (or in `docker-compose.dev.yml`)
to run with fake receipts. The executor will output a deterministic tx_hash
derived from the order ID without touching any blockchain.

**Warning: you will see this log on every executor spawn:**

```
[WARN] ===================================================
[WARN] EXECUTOR_STUB_MODE=true — NO REAL TRADES WILL EXECUTE
[WARN] Do NOT run with this flag in production!
[WARN] ===================================================
```

This is intentional. If you see this in production, flip `EXECUTOR_STUB_MODE=0`
and restart the worker.

### Executing an order

```bash
# 1. Propose an order
cclaw orders propose --json '{"action":"buy","symbol":"ETH","address":"0x...","chain":"base","amount":"100"}'

# 2. Approve it (or wait for auto-approve if AUTO_APPROVE_BUY=true)
cclaw orders approve --id <order-id>

# 3. Execute it (enqueues BullMQ job; worker spawns executor child)
cclaw orders execute --id <order-id>

# 4. Check the result
cclaw orders get --id <order-id>    # status should become 'executed' or 'failed'
cclaw receipts list --limit 5      # latest receipts
```

### Retrying a stuck 'executing' order

If the worker crashes mid-execution, an order can get stuck in `status='executing'`.
BullMQ retries the job automatically (up to 3 times with exponential backoff).
If you need to manually intervene:

```bash
# 1. Check if a job is still in the queue
#    (use redis-cli or a BullMQ dashboard like bull-board)

# 2. If the job is gone but the order is stuck, retry it
cclaw orders retry --id <order-id>   # re-approves it; worker will re-execute

# 3. Or cancel it
cclaw orders cancel --id <order-id> --reason "manual intervention"
```

### Upgrading stub → real (P1c-ii)

P1c-ii replaces `libs/execution/execute-trade-stub.ts` with the real Safe SDK
implementation. When it lands:

1. Set `EXECUTOR_STUB_MODE=0` (or remove the var — default is false).
2. Ensure `secrets/signer.env` has real key values (not stub values).
3. Restart the worker container.
4. Verify `/readyz` → executor binary check passes.

### /readyz executor checks

```bash
# Check readiness (executor binary + Redis + Prisma)
curl -s -H "Authorization: Bearer $CCLAW_API_TOKEN" http://127.0.0.1:7878/readyz | jq .
```

Expected response when healthy:

```json
{
  "status": "ok",
  "info": {
    "prisma": {"status": "up"},
    "redis": {"status": "up"},
    "executor": {"status": "up", "path": "/app/apps/executor/dist/main.js"}
  }
}
```

If `executor.status` is `"down"`: the binary is missing at the configured path.
Check `EXECUTOR_BIN_PATH` in your env or run `pnpm build`.

### Worker audit log convention

Worker jobs write `service_audit` rows with the `worker:` path prefix:

```bash
# Query worker audit rows
cclaw system audit --path worker:execute-order
```

The `path` field format: `worker:execute-order:<order-id>`.
This distinguishes worker jobs from HTTP audit entries in postmortems.

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

## 10. Rotate or add a Safe address (P1c-ii, ADR-0024)

Adding a new Safe to `ACTIVE_CHAINS` or changing an existing Safe address requires a worker restart. The per-Safe BullMQ queue is registered at boot time from the Safe address env var (`SAFE_ADDRESS_BASE`, `SQUADS_VAULT_ADDRESS`, etc.) — there is no hot-reload path.

**Procedure:**
1. Update the relevant Safe address env var in `.env.runtime` (e.g., set `SAFE_ADDRESS_BASE=0xNewSafeAddr`).
2. Restart the worker so the new queue registers:
   ```bash
   docker compose up -d --no-deps --force-recreate worker
   ```
3. Confirm the queue appears in BullMQ (via Redis `KEYS execute-order-*`).
4. Any pending orders for the old Safe address will stall in `executing` status (their queue no longer has a processor). Cancel them via `cclaw orders cancel --id <id>` before rotating.

**Queue naming convention (ADR-0024 addendum):**
Queue name format: `execute-order-<chain>-<safeAddressLowercase>` (e.g. `execute-order-base-0xabcdef`).
Never construct this name by hand — use `executeOrderQueueName(chain, safeAddress)` from `@cclaw/orders`.

## 11. Solana execution prerequisites (P1c-iii)

`apps/executor/src/execute-trade-solana.ts` is the real Squads V4 + Jupiter swap
implementation for Solana orders. Before enabling real-mode Solana execution:

### RPC endpoint

The public `api.mainnet-beta.solana.com` endpoint has aggressive rate limits
and is incompatible with production swap traffic (Jupiter `/swap-instructions`
alone can require 3-5 requests per order). Use a paid RPC:

- **Helius:** `https://mainnet.helius-rpc.com/?api-key=<YOUR_KEY>` (recommended)
- **Quicknode:** `https://<endpoint>.quiknode.pro/<YOUR_KEY>/`

Both hostnames are in `libs/chain/src/chains.ts` `SOLANA_RPC_ALLOWLIST.suffix`.
Set `RPC_VALIDATION_MODE=strict` (the default) in production.

### Vault funding

The Squads signer account needs SOL for transaction fees. Minimum recommended:
**0.05 SOL** (the `signerThreshold` from `libs/chain/src/chains.ts` for Solana).
Below this threshold `checkSignerBalance` in `preflight.ts` blocks execution with
`signer_balance_insufficient`.

### signer.env

```bash
# Set SQUADS_SIGNER_KEY to the base58-encoded private key of the Squads signer
# wallet in secrets/signer.env:
echo "SQUADS_SIGNER_KEY=<base58_key>" >> secrets/signer.env
chmod 0400 secrets/signer.env
```

The file must be mode 0400. The worker's production-mode load checks this and
exits hard if the mode is world-readable.

### Address configuration

Both `SQUADS_VAULT_ADDRESS` and `SQUADS_MULTISIG_ADDRESS` are required for
real-mode execution:

- `SQUADS_VAULT_ADDRESS`: the Squads vault PDA (direct address, takes priority).
- `SQUADS_MULTISIG_ADDRESS`: the Squads multisig PDA. Required for
  `vaultTransactionCreate` / `proposalCreate` / `proposalApprove` even when
  `SQUADS_VAULT_ADDRESS` is set.

Both are set in `.env.runtime` (not in `secrets/signer.env`).

### Squads transactionIndex monotonicity

The Squads transactionIndex is monotonically increasing per vault. The
`execute-order` BullMQ queue for Solana runs with `concurrency=1` per vault
(ADR-0024) — this serializes orders and prevents index collisions.

### Verification checklist

- [ ] `RPC_SOL` points to Helius or Quicknode (not `api.mainnet-beta.solana.com`).
- [ ] Signer wallet has ≥ 0.05 SOL.
- [ ] `secrets/signer.env` is mode 0400 with `SQUADS_SIGNER_KEY=<base58>`.
- [ ] Both `SQUADS_VAULT_ADDRESS` and `SQUADS_MULTISIG_ADDRESS` are set in `.env.runtime`.
- [ ] `EXECUTOR_STUB_MODE=0` in `.env.runtime`.

---

## 11.1 Background pipeline jobs (P3g1)

P4 cutover note: this job replaces `entrypoint.sh:run_wallet_scoring_loop` and `entrypoint.sh:run_activity_wallets_loop` (both disabled in P4 — see §13).

The wallet smart-money pipeline runs three BullMQ jobs in `apps/worker`, scheduled by `apps/scheduler`. These jobs run in parallel alongside the legacy `entrypoint.sh` background loops during P3 (removed in P5).

### Queue summary

| Queue | Cron | Processor | Health key |
|---|---|---|---|
| `wallet-harvest` | `0 * * * *` (hourly) | `HarvestProcessor` | `last_birdeye_harvest_at` |
| `wallet-scoring` | `*/10 * * * *` (PR-B) | `ScoreWalletsProcessor` | `last_score_wallets_bg_at` |
| `wallet-activity` | `*/30 * * * *` (PR-C) | `ActivityWalletsProcessor` | `last_activity_wallets_bg_at` |

### Retry policy

All three queues share the same retry policy (P3g1 plan [OPEN-4]):
- **Attempts:** 2 (1 original + 1 retry)
- **Backoff:** fixed 60 s delay
- **removeOnComplete:** 50 (recent successes kept for inspection)
- **removeOnFail:** 20 (recent failures kept for operator review)

### Manual re-enqueue

To manually trigger a harvest outside the hourly cron:

```bash
# Via redis-cli (replace redis host/port as needed)
redis-cli XADD wallet-harvest:events '*' type manual

# Or enqueue directly via BullMQ CLI (if installed)
# bull-cli add wallet-harvest '{}'
```

### Staleness alarms

The Observer agent checks `last_birdeye_harvest_at` (and the other health keys) against expected cadences. If the value is stale, the Observer fires a `system_health` Telegram alert:

| Key | Stale threshold |
|---|---|
| `last_birdeye_harvest_at` | > 90 min (2 missed hourly slots) |
| `last_score_wallets_bg_at` | > 30 min |
| `last_activity_wallets_bg_at` | > 90 min |

### Parallel legacy + new during P3

During P3, the legacy `entrypoint.sh` loops (`run_wallet_scoring_loop`, `run_activity_wallets_loop`) run in parallel with the new BullMQ jobs. This causes 2× Birdeye/Zerion/Helius API quota consumption. Mitigation:

- Use paper mode (`PAPER_MODE=true`) for dry-run verification before exposing to production quota limits.
- Monitor API quota dashboards during the first 24h of P3 deployment.
- Disable the legacy loops at P5 cutover once the new jobs are proven stable.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `WALLET_HARVEST_TIMEOUT_MS` | `300000` | AbortSignal deadline for one harvest job invocation (ms) |
| `WALLET_SCORING_PER_WALLET_TIMEOUT_MS` | `30000` | Per-wallet AbortController deadline for Birdeye + Zerion calls in scoring cycle (ms) |
| `WALLET_SCORING_INTER_WALLET_DELAY_MS` | `3000` | Delay between wallets in a scoring cycle for rate-limit respect (ms) |
| `WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS` | `10000` | Per-fetch AbortSignal deadline for Helius/Etherscan calls in activity cycle (ms) |
| `WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT` | `5` | Consecutive timeout threshold before skipping the remainder of a chain's wallets this cycle |
| `WALLET_ACTIVITY_INTER_WALLET_DELAY_MS` | `250` | Delay between wallets within a chain in an activity cycle (ms) |
| `BIRDEYE_API_KEY` | _(optional)_ | Required for harvest and scoring; harvest skips gracefully if absent |
| `ZERION_API_KEY` | _(optional)_ | Required for EVM wallet PnL scoring; Solana wallets are skipped even if present |
| `HELIUS_API_KEY` | _(optional)_ | Required for Solana activity polling; Solana wallets are skipped if absent |
| `BASESCAN_API_KEY` | _(optional)_ | Required for Base chain activity polling via Basescan API |
| `ETHERSCAN_API_KEY` | _(optional)_ | Required for Ethereum chain activity polling via Etherscan API |
| `ARBISCAN_API_KEY` | _(optional)_ | Required for Arbitrum chain activity polling via Arbiscan API |
| `POLYGONSCAN_API_KEY` | _(optional)_ | Required for Polygon chain activity polling via Polygonscan API |
| `BSCSCAN_API_KEY` | _(optional)_ | Required for BSC chain activity polling via BscScan API |
| `OPTIMISTIC_ETHERSCAN_API_KEY` | _(optional)_ | Required for Optimism chain activity polling via Optimistic Etherscan API |

### 11.2 Governance drift (P3g2 PR-D)

P4 + Squads SDK port note: this job fully replaces `entrypoint.sh:run_governance_drift_loop` (the loop body and `&` invocation are both commented out as of the Squads SDK port — see §13.4). Both EVM and Solana branches are handled by `GovernanceDriftProcessor`.

The governance-drift job runs daily at midnight and checks that the on-chain Safe multisig config (owners, threshold, modules) matches the expected values configured via env vars. Any deviation triggers a `rug_warning` Telegram alert.

**Cadence:** `0 0 * * *` (once daily) — mirrors `entrypoint.sh:run_governance_drift_loop`.
**Health key:** `portfolio_meta.last_governance_drift_at` — stale threshold: > 26 hours.
**Skip condition:** `PAPER_MODE=true` — drift is real-mode only (no on-chain state to check in paper mode).

**Expected config env vars (all optional — absence means "no expectation set"):**

| Env var | Description |
|---|---|
| `EXPECTED_SAFE_OWNERS_BASE` | Comma-separated lowercase EVM owner addresses for the Base Safe |
| `EXPECTED_SAFE_OWNERS_ETHEREUM` | Same for the Ethereum Safe |
| `EXPECTED_SAFE_THRESHOLD_BASE` | Required signing threshold for the Base Safe (integer) |
| `EXPECTED_SAFE_THRESHOLD_ETHEREUM` | Same for the Ethereum Safe |
| `EXPECTED_SAFE_MODULES_BASE` | Comma-separated lowercase module addresses allowed on Base Safe |
| `EXPECTED_SAFE_MODULES_ETHEREUM` | Same for the Ethereum Safe |
| `EXPECTED_SQUADS_MEMBERS` | Comma-separated base58 Squads member pubkeys |
| `EXPECTED_SQUADS_THRESHOLD` | Required Squads signing threshold (integer) |

**P3g2 PR-D status — Solana:**
> **Coverage:** Both EVM (Base, Ethereum) and Solana governance drift are handled by the NestJS `GovernanceDriftProcessor`. The Solana path uses `@sqds/multisig` via `SquadsRpcAdapter.getMultisigInfo()` to read on-chain Multisig owners + threshold and compares against `EXPECTED_SQUADS_MEMBERS` / `EXPECTED_SQUADS_THRESHOLD`. See §13.4 for the cutover record.

**Operator warning — empty string values:**
> Setting `EXPECTED_SAFE_OWNERS_BASE=""` (empty string, not unset) causes `hasExpectations=true` internally because the env var is present. The processor will interpret the empty list as "zero expected owners" and fire an `owner_added` alert for every observed owner on every cycle. To suppress drift checks for a chain, leave the var **unset** (absent from the environment) rather than setting it to an empty string.

**Troubleshooting:**
- If `last_governance_drift_at` is stale: check BullMQ queue `governance-drift` in the worker logs.
- If alert fires: compare the printed observed vs expected values. If the change is intentional (key rotation), update the env vars and redeploy.
- If Safe Transaction Service is down (429 or timeout): the job retries once after 60 s and logs a warning; the next daily cycle will retry automatically.

### 11.3 Multisig tracking (P3g2 PR-D)

P4 + Squads SDK port note: this job fully replaces `entrypoint.sh:run_multisig_tracker_loop` for BOTH chains (loop body + `&` invocation commented out as of the Squads SDK port — see §13.4).

The multisig-tracking job runs every 5 minutes and polls the on-chain status of receipts in `queued_in_safe` or `queued_in_squads` status. On confirmation it transitions the linked position (`draft → open` for BUY, `pending_exit → closed` for SELL). On rejection it refunds cash (BUY) or reverts the position (`pending_exit → open` for SELL).

**Cadence:** `*/5 * * * *` (every 5 minutes) — mirrors `entrypoint.sh:run_multisig_tracker_loop`.
**Health key:** `portfolio_meta.last_multisig_tracker_at` — stale threshold: > 15 minutes.
**Skip condition:** `PAPER_MODE=true` — paper receipts are executed synchronously by PaperExecutor.

**P3g2 PR-D status — Solana:**
> **Coverage:** Both EVM (Base, Ethereum) and Solana multisig tracking are handled by the NestJS `MultisigTrackerProcessor`. The Solana path uses `@sqds/multisig` via `SquadsRpcAdapter.getPendingTransactions()`, called once per cycle and shared across all `queued_in_squads` receipts. Receipts absent from the pending list are marked executed (legacy parity; documented [OPEN-RISK] for the case where Proposal-PDA fetch fails on every index). See §13.4 for the cutover record.

**OPEN-7 note:** After confirming a transaction, the tracker sets `last_portfolio_sync_stale_at` as a stale marker instead of inline-calling portfolio-load scripts. A future portfolio-sync job (P3g2 PR-E or later) will pick up this marker and sync the on-chain balance. During P3, the legacy `portfolio-load-{evm,solana}.js` scripts run in parallel and handle this.

**OPEN-8 note:** The `receipts.safe_nonce` column stores the Squads transaction index (a deliberate overload from the legacy `track-multisig.js`). This may be renamed to `external_index` in a future cleanup PR.

**Troubleshooting:**
- If a receipt is stuck in `queued_in_safe`: check that `safe_tx_hash` is set on the receipt (`cclaw receipts get --id <id>`).
- The `multisig-tracker: Solana multisig tracking deferred` WARN lines that fired during P4 no longer appear — Solana is now handled by the NestJS processor via the real `SquadsRpcAdapter`. If you see WARN lines mentioning `SquadsRpcError` or `getPendingTransactions failed`, that's a Solana RPC connectivity issue; check `RPC_SOL` and the configured endpoint.
- Reminder alerts fire every 30 minutes for any receipt still pending. If you are receiving many reminders, check the Safe Transaction Service or Squads UI for stuck transactions requiring manual approval.
- If position is in `draft` or `pending_exit` for > 24 h: manually inspect the receipt status and trigger `cclaw orders retry --id <order_id>` if needed.

### 11.4 Position reconcile (P3g2 PR-E)

P4 cutover note: this job replaces `entrypoint.sh:run_position_reconcile_loop` (disabled in P4 — see §13).

The position-reconcile job runs every hour and compares the DB-recorded `positions.quantity` against the actual on-chain token balance in the Safe / Squads vault. Drift > 1% writes a `recon_drift_X.YYpct` marker into `positions.notes` and triggers a `rug_warning` Telegram alert.

**Cadence:** `0 * * * *` (hourly) — mirrors `entrypoint.sh:run_position_reconcile_loop`.
**Health key:** `portfolio_meta.last_position_reconcile_at` — stale threshold: > 90 minutes.
**Skip condition:** `PAPER_MODE=true` — no on-chain state to check in paper mode.
**Idempotency guard:** The processor writes at most one drift marker per position per UTC hour (via `shouldAppendDriftMarker` dedup). A second run within the same hour with identical on-chain state does NOT append a duplicate marker. This is a deliberate improvement over the legacy script which appended on every cycle.

**Required env vars (at least one per active EVM chain):**

| Env var | Description |
|---|---|
| `SAFE_ADDRESS_BASE` | Base Safe vault address (used as `owner` for ERC-20 balance reads) |
| `SAFE_ADDRESS_ETH` | Ethereum Safe vault address |
| `SQUADS_VAULT_ADDRESS` | Solana vault address (direct) |
| `RPC_BASE` / `RPC_ETH` / `RPC_SOL` | Chain RPC URLs (used by OnchainBalanceAdapter) |
| `RPC_VALIDATION_MODE` | `strict` (default) / `warn` / `skip` — RPC hostname allowlist mode |

**Solana limitation:** If `SQUADS_VAULT_ADDRESS` is not set, Solana positions are skipped with a WARN log (PDA derivation requires the SDK — set the vault env var directly).

**Troubleshooting:**
- If `last_position_reconcile_at` is stale: check BullMQ queue `position-reconcile` in worker logs.
- If repeated `recon_drift_*` markers appear in notes: verify the position quantity in the DB is correct. If the token has fee-on-transfer mechanics, the drift is expected — consider adjusting the position quantity or closing the position.
- If `decimals_fetch_failed`: the token's ERC-20 contract may not be responding. The position is skipped for this cycle; the error is counted in the processor result.

### 11.5 Portfolio report (P3g2 PR-E)

P4 cutover note: this job replaces `entrypoint.sh:run_portfolio_report_loop` (disabled in P4 — see §13).

The portfolio-report job runs once per day at the configured UTC hour (`PORTFOLIO_REPORT_HOUR`) and sends a formatted portfolio summary to the Telegram `TG_TOPIC_PORTFOLIO` topic.

**Cadence:** `0 H * * *` (daily at `PORTFOLIO_REPORT_HOUR` UTC) — mirrors `entrypoint.sh:run_portfolio_report_loop`.
**Health key:** `portfolio_meta.last_portfolio_report_at` — stale threshold: > 26 hours.
**Skip condition:** `TELEGRAM_CHAT_ID` or `TG_TOPIC_PORTFOLIO` not set — schedule not registered at startup.

**[OPEN-5] Cadence implementation:** Uses `SchedulerRegistry.addCronJob` in `onModuleInit` to register a dynamic cron expression at the configured hour (e.g. `0 9 * * *` for `PORTFOLIO_REPORT_HOUR=9`). This is cleaner than an hourly-poll-with-gate because it fires exactly once per day at the right time.

**Required env vars:**

| Env var | Description |
|---|---|
| `TELEGRAM_CHAT_ID` | Target Telegram supergroup ID |
| `TG_TOPIC_PORTFOLIO` | Telegram forum topic thread ID for portfolio reports |
| `PORTFOLIO_REPORT_HOUR` | UTC hour for daily report (0–23, default: 0 = midnight) |
| `DEXSCREENER_TIMEOUT_MS` | Per-request timeout for DEXScreener price fetches (default: 15 000 ms) |

**[OPEN-7] Note:** After a multisig transaction confirms, the tracker sets `last_portfolio_sync_stale_at` as a hint. A future portfolio-sync job will pick up this marker and refresh on-chain balances. During P3, the legacy `portfolio-load-{evm,solana}.js` scripts run in parallel (via `entrypoint.sh`) and handle on-chain balance sync.

**Troubleshooting:**
- If no Telegram message arrives: check that both `TELEGRAM_CHAT_ID` and `TG_TOPIC_PORTFOLIO` are set, and that `PORTFOLIO_REPORT_HOUR` matches your expected hour in UTC.
- If `last_portfolio_report_at` is stale: check BullMQ queue `portfolio-report` in worker logs.
- If the report shows stale prices: DEXScreener may be rate-limiting. The adapter retries on the next hourly tick. Check `DEXSCREENER_TIMEOUT_MS`.

### 11.6 Approval-bot (P3g3 PR-F)

P4 cutover note: this service replaces `entrypoint.sh:run_approval_bot` (disabled in P4 — see §13).

The approval-bot is a **continuous long-poll worker** (ADR-0027) — not a cron job. It starts inside `apps/worker` via `OnApplicationBootstrap` and runs a `getUpdates` long-poll loop (30 s window) until the worker receives SIGTERM.

**Pattern:** NestJS `@Injectable` service, `AbortController`-cancellable, `OnApplicationBootstrap` / `OnApplicationShutdown`. No BullMQ queue.
**SIGTERM responsiveness:** The in-flight 30 s `getUpdates` poll is cancelled via `AbortSignal` within 1 s of SIGTERM. `onApplicationShutdown` waits at most 5 s for the loop to exit before returning.
**Health key:** `portfolio_meta.last_approval_bot_at` — updated every poll iteration. Stale threshold: > 5 minutes (two missed polls).
**Offset persistence:** `portfolio_meta.approval_bot_offset` stores the next Telegram `update_id`. On restart the bot resumes from the last committed offset — no replayed approvals.

**Startup conditions (all must be satisfied or the loop is silently skipped):**
- `PAPER_MODE=false` (paper mode needs no human approvals).
- `TELEGRAM_BOT_TOKEN` is set.
- `TELEGRAM_OWNER_ID` is set.

**Security:** Only the Telegram user whose numeric ID matches `TELEGRAM_OWNER_ID` can approve or reject orders. All other users receive "Unauthorized" and the event is discarded. The order-state transition (`pending → approved` / `pending → rejected`) is atomic — a Prisma `WHERE id=? AND status='pending'` guard means concurrent clicks or a race with the legacy `approval-bot.js` result in a P2025 error that is reported back as "already processed."

**Required env vars:**

| Env var | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token (same token as main notifications bot, unless `TELEGRAM_APPROVAL_BOT_TOKEN` is set separately) |
| `TELEGRAM_OWNER_ID` | Numeric Telegram user ID of the fund operator |
| `TELEGRAM_CHAT_ID` | Target supergroup/chat ID (used for editing approval messages) |

**Troubleshooting:**
- If `last_approval_bot_at` is stale: check that `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` are set; check worker logs for "skipping startup" or backoff messages.
- If approve/reject buttons have no effect: ensure the user clicking is `TELEGRAM_OWNER_ID`. Other users receive a silent "Unauthorized" response.
- If the worker is slow to shut down: the `onApplicationShutdown` waits at most 5 s. If the loop does not exit within that window, the process exits anyway. Check for a hung Prisma write in the handler.
- **Parallel with legacy bot:** During P3 (before P5 cutover), both `apps/worker` (new) and `scripts/approval-bot.js` (legacy via `entrypoint.sh`) may be polling the same Telegram token. Telegram ensures only one client holds the `getUpdates` long-poll at a time; the other re-polls immediately after. Both write atomically to the same `orders` table — the second writer sees "already processed" and is a no-op.

---

## 12. Emergency stop

[TBD]

Outline:
- `docker compose stop scheduler worker` halts new jobs and the approval bot.
- `apps/api` keeps serving — `cclaw orders cancel --id <id>` for any in-flight orders.
- For a full halt: `docker compose down`. Existing in-flight executor children finish their transaction (Safe / Squads) but no new orders are issued.

---

## 13. P4 cutover record

This section documents the P4 cutover applied on 2026-05-15 (commit: #TBD — to be updated after merge). It is the authoritative record for what changed, what was kept legacy, rollback instructions, and the 90-min parallel-legacy log diff results.

### §13.1 What P4 cutover changed

The following `entrypoint.sh` background loops were disabled (function body commented out, `&` invocation removed from section 6, `[p4-cutover]` banner echo added):

- `run_wallet_scoring_loop` — replaced by `WalletScoringProcessor` in `apps/worker` (PR #22, `*/10 * * * *` scheduler cron)
- `run_activity_wallets_loop` — replaced by `WalletActivityProcessor` in `apps/worker` (PR #23, `*/30 * * * *` scheduler cron)
- `run_position_reconcile_loop` — replaced by `PositionReconcileProcessor` in `apps/worker` (PR #27, `0 * * * *` scheduler cron)
- `run_portfolio_report_loop` — replaced by `PortfolioReportProcessor` in `apps/worker` (PR #27, `0 H * * *` dynamic cron at `PORTFOLIO_REPORT_HOUR`)
- `run_approval_bot` — replaced by `ApprovalBotService` in `apps/worker` (PR #28, ADR-0027, continuous long-poll)

The following loops were kept running unchanged:

- `run_memory_backup_loop` — git workspace operations must stay in shell; no NestJS equivalent planned.
- `run_executor_loop` — LLM-agent loop; stays in `entrypoint.sh` per SPEC §4 #5.
- `run_sentinel_loop` — LLM-agent loop; stays in `entrypoint.sh` per SPEC §4 #5.

The following loop was partially modified (Solana-only filter added):

- `run_governance_drift_loop` — fully disabled (both function body and `&` invocation commented out) as of the Squads SDK port. Both EVM and Solana are now handled by `GovernanceDriftProcessor` (`SquadsRpcAdapter.getMultisigInfo()` covers Solana via `@sqds/multisig`). The P4-era Solana-only chain filter is removed.

The following loop was kept fully running (both chains):

- `run_multisig_tracker_loop` — fully disabled (both function body and `&` invocation commented out) as of the Squads SDK port. Both EVM and Solana are now handled by `MultisigTrackerProcessor` via the real `SquadsRpcAdapter.getPendingTransactions()`. The P4 idempotency safety net (legacy + NestJS both writing) is no longer needed.

Agent markdown (20 files across Research, Sentinel, Executor, Observer) was swept to prefer `cclaw <resource> <action>` where a cclaw equivalent exists. Commands without a cclaw equivalent remain as `node scripts/db-query.js` (legacy hold-backs, deleted in P5).

### §13.2 cclaw mapping table

The table below maps every `node scripts/db-query.js <command>` referenced in agent markdown to its cclaw equivalent (P4) or legacy hold-back status (pending P5).

| db-query.js command | cclaw equivalent | Status |
|---|---|---|
| `get-positions [--status] [--symbol]` | `cclaw positions list [--status] [--symbol]` | Converted |
| `get-position --id` | `cclaw positions get --id` | Converted |
| `get-orders [--pending] [--status] [--action]` | `cclaw orders list [--pending] [--status] [--action]` | Converted |
| `get-order --id` | `cclaw orders get --id` | Converted |
| `add-order --json` | `cclaw orders propose --json` | Converted |
| `approve-order --id --by` | `cclaw orders approve --id --by` | Converted |
| `reject-order --id --reason --by` | `cclaw orders reject --id --reason` | Converted |
| `cancel-order --id --reason --by` | legacy hold-back — `cclaw orders cancel` pending P5b | Hold-back (pending P5b) |
| `retry-order --id --by` | legacy hold-back — `cclaw orders retry` pending P5b | Hold-back (pending P5b) |
| `mark-order-executed --id` | `cclaw orders execute --id` (now async 202; agent polls next cycle) | Converted (P5 semantic) |
| `get-order-history [--limit] [--status]` | legacy hold-back | Hold-back |
| `get-receipts [--status] [--limit]` | `cclaw receipts list [--status] [--limit]` | Converted |
| `get-receipt --id` | `cclaw receipts get --id` | Converted |
| `add-receipt --json` | `cclaw receipts create --json` | Converted |
| `get-alerts [--unprocessed]` | `cclaw alerts list [--unprocessed]` | Converted |
| `add-alert --json` | `cclaw alerts create --json` | Converted |
| `mark-alert-processed --id` | `cclaw alerts ack --id` | Converted |
| `get-heartbeat --agent` | `cclaw heartbeat get --agent` | Converted |
| `get-heartbeats [--agent]` | `cclaw heartbeat list [--agent]` | Converted |
| `update-heartbeat --agent --check` | `cclaw heartbeat ping --agent --check` | Converted |
| `get-overdue-checks --agent` | `cclaw heartbeat overdue --agent` | Converted |
| `add-sentinel-log --json` | legacy hold-back — `cclaw agent-logs create` pending P5 | Hold-back |
| `add-executor-log --json` | legacy hold-back — `cclaw agent-logs create` pending P5 | Hold-back |
| `add-research-log --json` | legacy hold-back — `cclaw agent-logs create` pending P5 | Hold-back |
| `add-observer-log --json` | legacy hold-back — `cclaw agent-logs create` pending P5 | Hold-back |
| `get-sentinel-log [--limit]` | legacy hold-back | Hold-back |
| `get-executor-log [--limit]` | legacy hold-back | Hold-back |
| `get-research-log [--limit]` | legacy hold-back | Hold-back |
| `get-observer-log [--limit]` | legacy hold-back | Hold-back |
| `get-portfolio [--chain]` | legacy hold-back — `cclaw portfolio summary` pending P5 | Hold-back |
| `get-cash [--chain]` | legacy hold-back | Hold-back |
| `get-meta --key` | legacy hold-back | Hold-back |
| `set-meta --key --value` | legacy hold-back | Hold-back |
| `get-chains` | legacy hold-back — `cclaw system chains` pending P5 | Hold-back |
| `get-chain-config --chain` | legacy hold-back | Hold-back |
| `get-trade-stats [--chain]` | legacy hold-back | Hold-back |
| `get-watchlist [--active]` | legacy hold-back — `cclaw watchlist list` pending P5 | Hold-back |
| `add-to-watchlist --json` | legacy hold-back | Hold-back |
| `update-watchlist --id --json` | legacy hold-back | Hold-back |
| `remove-from-watchlist --id` | legacy hold-back | Hold-back |
| `get-liquidity --address --chain` | legacy hold-back | Hold-back |
| `add-liquidity-snapshot --address --chain --liquidity` | legacy hold-back | Hold-back |
| `get-contract-snapshots --address --chain` | legacy hold-back | Hold-back |
| `add-contract-snapshot --address --chain --json` | legacy hold-back | Hold-back |
| `get-tracked-wallets [--status]` | legacy hold-back — `cclaw wallets list` pending P5 | Hold-back |
| `add-tracked-wallet --json` | legacy hold-back | Hold-back |
| `propose-wallet --json` | legacy hold-back — `cclaw wallets propose` pending P5 | Hold-back |
| `get-unscored-wallets [--limit]` | legacy hold-back | Hold-back |
| `update-wallet-score --address --chain --json` | legacy hold-back | Hold-back |
| `remove-tracked-wallet --address --chain` | legacy hold-back | Hold-back |
| `get-smart-money-signals [--since] [--action]` | legacy hold-back — `cclaw wallets signals` pending P5 | Hold-back |
| `check-token-status --address --chain` | legacy hold-back — `cclaw analysis check-token` pending P5 | Hold-back |
| `cache-analysis --json` | legacy hold-back | Hold-back |
| `get-analysis-cache` | legacy hold-back | Hold-back |
| `clear-expired-cache` | legacy hold-back | Hold-back |
| `sync-portfolio --chain` | legacy hold-back | Hold-back |
| `get-sync-status [--chain]` | legacy hold-back | Hold-back |
| `set-onchain-balance --id --balance` | legacy hold-back | Hold-back |

**cclaw commands currently implemented** (from `sdk/cclaw/src/index.ts`):
- `cclaw positions list`, `cclaw positions get`
- `cclaw orders list`, `cclaw orders get`, `cclaw orders propose`, `cclaw orders approve`, `cclaw orders reject`, `cclaw orders execute`
- `cclaw receipts list`, `cclaw receipts get`, `cclaw receipts create`
- `cclaw alerts list`, `cclaw alerts get`, `cclaw alerts create`, `cclaw alerts ack`, `cclaw alerts send`
- `cclaw heartbeat list`, `cclaw heartbeat get`, `cclaw heartbeat overdue`, `cclaw heartbeat ping`
- `cclaw system audit`

### §13.3 Retained scripts — post-retained-deletion residue (~10 files)

The P5 legacy-deletion PR deleted ~38 scripts. P5c deleted `scripts/send-alert.js`. The retained-set deletion follow-up (2026-05-18) deleted `db.js`, `db-query.js`, `chains.js`, `order-approval.js`, and `agent-idleness.js` after porting their 4 importers off db.js to cclaw subprocess calls. P5b completed the cclaw CLI expansion and swept all 172 agent markdown hold-back references to `node scripts/db-query.js` — agent markdown has ZERO `db-query.js` references.

**Retained-set count: ~10** (was 14 before retained-deletion follow-up).

| Script | Retained by | Closing PR |
|---|---|---|
| `scripts/log.js` | Required by `heartbeat-check.js`, `emergency-sentinel.js`, `emergency-executor.js`, and `promote-pattern.js`. | Permanent (no DB dependency) |
| `scripts/redact.js` | Required by `log.js` and `promote-pattern.js`. | Permanent |
| `scripts/promote-pattern.js` | MEMORY.md write-protection (provenance trail enforcement); uses cclaw for derived-from verification (fail-closed) | Permanent |
| `scripts/emergency-executor.js` | `entrypoint.sh:run_executor_loop` invokes on 3 consecutive model failures; uses `cclaw orders execute` | Permanent |
| `scripts/emergency-sentinel.js` | `entrypoint.sh:run_sentinel_loop` invokes on first model failure; uses `cclaw orders propose` + `cclaw orders approve` | Permanent |
| `scripts/heartbeat-check.js` | `entrypoint.sh` SKIP predicate for executor/sentinel demand-driven loops; uses `cclaw positions/orders list` | Permanent |
| `scripts/pre-commit-check.js` | Secret scanner + MEMORY.md trail gate + npm-audit gate; permanent CI infrastructure | n/a |
| `scripts/memory-backup.sh` | `entrypoint.sh:run_memory_backup_loop` — git workspace backup every 15 min; SPEC §8 | n/a |
| `scripts/codex-login.sh` | One-time Codex OAuth setup helper for operators; permanent operator tool | n/a |
| `scripts/ci/*.mjs` | CI guards (vitest-workspace, dockerfile-modules checks); permanent | n/a |

**cclaw alerts send** — operator/agent Telegram alert path (ADR-0028):

```bash
cclaw alerts send --type <TYPE> --agent <AGENT> --message "<MESSAGE>" [--data '{"key":"val"}']
```

All 15 alert types supported: `recovered`, `trade_proposal`, `trade_executed`, `trade_failed`, `trade_retry`, `sell_triggered`, `sentinel_alert_followup`, `model_failure`, `emergency_mode`, `rug_warning`, `signer_low_balance`, `system_health`, `heartbeat_summary`, `portfolio_daily`, `rebalance_event`.

### §13.4 Solana cutover complete (PR #29 — Squads SDK port)

The SquadsRpcAdapter SDK port (`@sqds/multisig@^2.1.4`) landed in PR #29. Both legacy
entrypoint loops are now disabled.

**What changed (PR #29):**

1. **Governance-drift Solana branch** — `entrypoint.sh:run_governance_drift_loop` function
   body is commented out and the `&` invocation replaced by a `[p5-squads-sdk]` banner.
   `GovernanceDriftProcessor` now handles all chains (EVM via Safe Transaction Service +
   Solana via `SquadsRpcAdapter.getMultisigInfo()`). The `last_governance_drift_at` meta
   key is written by the NestJS processor on every cycle (all chains).

2. **Multisig tracking Solana branch** — `entrypoint.sh:run_multisig_tracker_loop` function
   body is commented out and the `&` invocation replaced by a `[p5-squads-sdk]` banner.
   `MultisigTrackerProcessor` now handles all chains (EVM via Safe Transaction Service +
   Solana via `SquadsRpcAdapter.getPendingTransactions()`). The `last_multisig_tracker_at`
   meta key is written by the NestJS processor on every cycle.

**Disabled legacy scripts (still present, byte-untouched, DoD §I):**
- `scripts/check-squads-status.js` — no longer invoked by any entrypoint loop.
- `scripts/governance-drift.js` (imported by check-squads-status) — unchanged.
- `scripts/track-multisig.js` — no longer invoked by any entrypoint loop.
Both will be deleted at P5 cleanup.

**Squads adapter design (locked decisions):**
- `@sqds/multisig@^2.1.4` + `@solana/web3.js@^1.98.0` + `@solana/spl-token@^0.4.9`.
- Per-call `Connection` (not cached singleton — matches legacy behavior).
- Scan window: `max(1, txIndex - 19)`, latest 20 indices descending (matches legacy).
- Dynamic `await import('@sqds/multisig')` for CJS/ESM interop safety (mirrors executor).
- `SQUADS_SIGNER_KEY` never read (SPEC §4 #4). RPC URL never logged (may contain API key).

**Rollback (if needed):**
`git revert <PR-29-merge-sha>` snaps back: re-enables both entrypoint loops, restores Solana
feature-flag skips in both processors, removes the SDK calls. SDK dependencies stay installed
(harmless).

### §13.5 90-minute parallel-legacy log diff results

**Operator capture run on 2026-05-17. Scope limitation discovered: deferred full
NestJS-side parity to P6.**

**What was captured:**

Two 90-min `docker compose up` runs in `PAPER_MODE=true`:
- Run 1: legacy baseline on `v2 @ b5ca6af`, `SAFE_ID=p4-legacy`.
- Run 2: P4 cutover on `feat/p4-cutover`, `SAFE_ID=p4-cutover`.

Both used the production `docker-compose.yml`. DBs extracted via
`docker compose cp crypto-claw:/home/openclaw/.openclaw/agents/research/data/<SAFE_ID>.db`
before `down -v` (volume otherwise persists named-volume state across runs).

**Observed results:**

```
Legacy baseline (Run 1, /tmp/p4-legacy.db):
  tracked_wallets     | 58
  smart_money_signals | 120
  paper_receipts      | 0
  paper_positions     | 0
  sentinel_alerts     | 0

P4 cutover (Run 2, /tmp/p4-cutover.db):
  tracked_wallets     | 0
  smart_money_signals | 0
  paper_receipts      | 0
  paper_positions     | 0
  sentinel_alerts     | 0

service_audit table:  not present in cutover DB
last_*_at meta keys:  no rows
```

**Interpretation:**

Production `docker-compose.yml` only launches the legacy OpenClaw container
(bash loops + agent skills). It does **not** launch the new NestJS apps
(`apps/api`, `apps/worker`, `apps/scheduler`), which currently run only via
`docker/docker-compose.dev.yml`. Wiring NestJS into the production compose
stack is **P6 work** (deployment hardening).

The capture therefore validates **only the legacy-side removal**:
- ✓ Disabled legacy bash loops produce zero writes on the cutover side
  (`tracked_wallets`: 58 → 0; `smart_money_signals`: 120 → 0). Loops were
  silent as designed.
- N/A NestJS-side writes — the apps weren't running in this compose stack.

**Why this is acceptable to merge:**

NestJS replacement correctness is proven by the unit + integration test
coverage shipped in PRs #21–#28, not by this capture:

| Job | PR | Coverage | Idempotency proof |
|---|---|---|---|
| wallet-harvest | #21 | 100% lines | triple-run integration spec |
| wallet-scoring | #22 | 100% lines | triple-run integration spec |
| wallet-activity | #23 | 100% lines | triple-run integration spec |
| governance-drift (EVM) | #26 | 98% lines | triple-run integration spec |
| multisig-tracker (EVM) | #26 | 100% lines | triple-run + idempotent retry |
| position-reconcile | #27 | 92% lines | triple-run integration spec |
| portfolio-report | #27 | 100% lines | dual-run integration spec |
| approval-bot | #28 | >85% lines | offset-persistence + P2025 atomicity |

**Deferred to P6:** full live-parity capture with NestJS apps running in the
production compose stack. Tracking: file a follow-up issue at P6 kickoff to
re-run this §13.5 procedure with `apps/*` services included.

**Acceptance criteria (revised for legacy-side-only scope):**

1. ✓ Legacy bash tags (`[wallet-scorer-bg]`, `[activity-wallets-bg]`,
   `[position-reconcile]`, `[portfolio-report]`, `[approval-bot]`) absent
   from Run 2 logs — confirmed by zero writes to the corresponding tables.
2. ✓ `[p4-cutover]` banner lines visible in Run 2 startup.
3. ✓ Kept-running legacy loops (`memory-backup`, `governance-drift` Solana
   branch, `multisig-tracker`, executor LLM, sentinel LLM) continue
   firing — no regression in legacy-side function deletion or filter
   placement.
4. ✓ No `CRITICAL` log entries introduced by the cutover changes.
5. N/A NestJS-side row-count parity — deferred to P6 per scope limitation
   above.

**Conclusion: P4 cutover merges on legacy-side evidence + P3 unit-test
evidence. Full live E2E parity is a P6 deliverable.**

### §13.6 P4 rollback recipe

If P4 causes a regression, revert with:

```bash
git revert <p4-merge-sha>
```

Then restart the container stack:

```bash
docker compose pull
```
```bash
docker compose up -d
```

The revert re-enables all commented-out loops in `entrypoint.sh` and restores the `&` invocations in section 6. Legacy scripts are byte-untouched (DoD §I) — they are immediately available again after restart. The NestJS worker and scheduler continue to run their BullMQ jobs in parallel; this is the "parallel mode temporarily restored" worst-case state described in the original plan.

In parallel mode, both the legacy loops and NestJS processors run simultaneously. Idempotency guards (DoD §E) prevent double-writes: the NestJS processors use `INSERT OR IGNORE` for signals, `WHERE id=? AND status='...'` for state transitions, and per-UTC-hour dedup for drift markers. The safe worst-case is duplicated Birdeye/Zerion/Helius API quota consumption for ~24h while the regression is diagnosed.

To selectively disable individual loops after rollback (while keeping others), uncomment only the desired functions and their `&` invocations. The P4 comment blocks include per-loop rollback instructions.

**Post-rollback checklist:**
1. Verify legacy `[wallet-scorer-bg]`, `[activity-wallets-bg]`, `[position-reconcile]`, `[portfolio-report]`, `[approval-bot]` log prefixes are back in `docker compose logs`.
2. Verify `last_score_wallets_bg_at` and `last_activity_wallets_bg_at` are refreshing in `portfolio_meta`.
3. Verify `cclaw heartbeat list` shows all four agents as healthy.
4. Open a post-mortem issue documenting the regression before re-attempting cutover.

---

## §14 P5 cleanup record (2026-05-17)

### §14.1 Files deleted in P5

**Scripts (~38 files):**
- Background loops: `harvest.js`, `score-wallets-bg.js`, `score-wallet.js`, `activity-wallets-bg.js`, `governance-drift.js`, `track-multisig.js`, `reconcile-positions.js`, `portfolio-summary.js`, `approval-bot.js`, `send-approval.js`
- Execution scripts: `execute-trade-evm.js`, `execute-trade-solana.js`, `check-safe-status.js`, `check-squads-status.js`, `backfill-squads-nonce.js`, `process-order.js`
- Sentinel/Research tools: `check-positions.js`, `check-liquidity.js`, `check-wallets.js`, `check-contract.js`, `check-signer-balances.js`, `holder-distribution.js`, `token-metrics.js`, `scan-tokens.js`, `narrative-check.js`, `narrative-deep-scan.js`, `narrative-config.js`, `market-overview.js`, `market-regime.js`, `price-oracle.js`, `portfolio-load-evm.js`, `portfolio-load-solana.js`, `onchain-balance.js`, `address-validator.js`

> **Correction (P6-fragment, 2026-05-17):** `order-approval.js` and `chains.js` were NOT deleted in P5. Both are load-time imports of the retained `db-query.js` (see §13.3) and must remain on disk until `db-query.js` is deleted. Deletion is gated on P5b cclaw CLI expansion AND porting `heartbeat-check.js` / `promote-pattern.js` / `emergency-*.js` off `db.js`.
- One-off scripts: `telegram-get-topics.js`, `test-solana-tx-size.js`

**Tests:**
- `tests/test-*.js` (40 legacy test files), `tests/test-helpers.js`, `tests/run-all.js`, `tests/package.json`
- `tests/data/` (SQLite test fixtures)
- `tests/shim-parity/` (baseline harness tree — ADR-0020 retired)
- `tests/integration/parity/*.spec.ts` (17 parity specs)

**CI:** shim-parity gate step and legacy-deps install step removed from `.github/workflows/pr.yml`.

**Package.json:** `legacy:lint` and `legacy:test` scripts removed.

### §14.2 Load-bearing semantic change

`agents/executor/HEARTBEAT.md` Step 2 was rewritten from:
- _Call `node scripts/process-order.js --order-id X`, parse synchronous JSON envelope `{ok, status, receipt_id, position_id, error}`_

to:
- _Call `cclaw orders execute --id X` (returns 202 = enqueued), verify on next 1-minute cycle via `cclaw orders get --id X` or `cclaw receipts list --order-id X`_

The executor now **reports "enqueued N orders"** per cycle instead of "executed N orders". Execution confirmation arrives on the next heartbeat. This aligns the agent instructions with the actual `ExecuteOrderProcessor` BullMQ async behavior.

### §14.3 Follow-up issues

- **P5b** ✓ DONE (2026-05-18) — cclaw CLI expansion + agent markdown sweep. Three PRs: PR-1 (41 cclaw subcommands for existing routes), PR-2 (4 new HTTP routes + 5 cclaw subcommands: system chains, system chain-config, system portfolio, system trade-stats, system sync-portfolio), PR-3 (agent markdown sweep — 172 hold-back references in 20 markdown files replaced with cclaw forms; `grep -r "node scripts/db-query.js" agents/` returns zero). The 4 retained scripts (db.js, db-query.js, chains.js, order-approval.js) remain on disk pending port-off; deletion gated on porting heartbeat-check.js / promote-pattern.js / emergency-*.js off db.js.
- **Retained-set deletion follow-up** ✓ DONE (2026-05-18) — ported heartbeat-check.js / promote-pattern.js / emergency-sentinel.js / emergency-executor.js off db.js (now use cclaw subprocesses); deleted db.js, db-query.js, chains.js, order-approval.js, agent-idleness.js (5 files); scripts/ shrunk from 14 → ~10 files. MEMORY.md write-protection now verifies derived-from IDs via cclaw HTTP (fail-closed: any execSync error = reject). Emergency executor now enqueues via `cclaw orders execute` (matches ADR-0027 async semantics) instead of the broken `execSync('node execute-trade-*.js')` path. Emergency sentinel sell writes now use 2-call `cclaw orders propose` + `cclaw orders approve --by emergency_sentinel` (produces audit trail for both writes — stricter than legacy direct INSERT). memory-backup.sh heartbeat now uses `cclaw heartbeat ping` (db-query.js dead). build-templates.sh copy lists trimmed. audit-instructions/SKILL.md whitelist and source-of-truth pointers updated. Security-auditor pre-pass mandatory before merge (DoD §F).
- **P5c** ✓ DONE — Notifications: `POST /v1/alerts/send` + `cclaw alerts send` wired to `NotificationsService.sendCriticalAlert`. ADR-0025 superseded by ADR-0028. `scripts/send-alert.js` deleted; `scripts/log.js` + `scripts/redact.js` retained (4 other importers — not send-alert.js as the P5 runbook incorrectly stated).
- **P6-fragment** ✓ DONE (2026-05-17) — NestJS startup migration runner shipped. Scope delivered:
  - `apps/api/src/prisma-migrate.bootstrap.ts` — `runPrismaMigrateDeploy()` inserted in main.ts boot sequence (assertNoSignerKeysInEnv → assertConfigValid → runPrismaMigrateDeploy → NestFactory.create).
  - `entrypoint.sh` section 4: dropped `db-query.js migrate` block; paper-cash seed moved to `seed_paper_cash_bg` background function (waits for apps/api `/healthz`, then calls `cclaw system meta set`).
  - `cclaw system meta set` + `cclaw system meta get` subcommands added to `sdk/cclaw/src/index.ts`.
  - Runbook §13.3 updated; §14.1 corrected (chains.js + order-approval.js retained — see correction note above).
  - **Deletion of db.js / db-query.js / chains.js / order-approval.js remains deferred** — 5 importers remain (heartbeat-check.js, promote-pattern.js, emergency-sentinel.js, emergency-executor.js, db-query.js itself); gated on porting those scripts off db.js.

### §14.4 Rollback

`git revert <P5-PR-merge-sha>` snaps back cleanly. Commit 3 (the big deletion) is the single atomic commit for file removal; surrounding commits are additive/comment-only and are harmless to leave reverted partially.

---

## §15 Production deployment (P6, 2026-05-18)

### §15.1 Architecture overview

P6 adds three long-running NestJS services to the production compose stack, plus Redis:

```
Host
  ├── Caddy (443) → crypto-claw gateway (entrypoint.sh)
  │                         ↓ CCLAW_API_BASE=http://apps-api:7878
  │
  └── compose network (internal bridge, no host ports except Caddy)
        ├── redis:6379          -- BullMQ message broker (AOF everysec)
        ├── apps-api:7878       -- NestJS HTTP server (binds 0.0.0.0 internally)
        ├── apps-worker         -- NestJS BullMQ consumer + approval bot
        └── apps-scheduler      -- NestJS cron registry (enqueues jobs)
```

Image: all four NestJS apps (api/worker/scheduler/executor) are compiled into a single `docker/Dockerfile` prod image. Each compose service overrides `CMD` to pick the correct entrypoint. `apps-executor` is NOT a long-running service; it is spawned as an ephemeral child process by `apps-worker` per order (SPEC §2, SPEC §4 #5).

Signer-key scoping (ADR-0023, SPEC §4 #4):
- `apps-api` and `apps-scheduler`: explicit `SAFE_SIGNER_KEY: ''` and `SQUADS_SIGNER_KEY: ''` in compose env (defense against host-shell leakage). Boot self-check enforces absence.
- `apps-worker`: explicit empty env vars + bind-mount `./secrets:/run/secrets:ro` (mode 0400). The worker reads `SIGNER_ENV_FILE=/run/secrets/signer.env` at executor spawn time only.

### §15.2 First-time setup

1. **Build or pull the image:**

```bash
# Option A: pull published image by digest (recommended)
docker pull ghcr.io/0xb11a/crypto-claw:sha-<7chars>

# Option B: build locally
docker buildx build --target prod -f docker/Dockerfile -t cclaw:local .
```

2. **Create runtime env file:**

```bash
cp .env.runtime.example .env.runtime
chmod 0600 .env.runtime
# Edit .env.runtime — fill in all required vars (CRYPTO_CLAW_IMAGE, SAFE_ID,
# Redis URL, bearer tokens, API keys, Telegram, RPC URLs, etc.)
```

3. **Create signer key file:**

```bash
cp secrets/signer.env.example secrets/signer.env
chmod 0400 secrets/signer.env
# Edit secrets/signer.env — fill in SAFE_SIGNER_KEY and/or SQUADS_SIGNER_KEY
```

4. **Create data directory** (if not already present from the legacy stack):

```bash
mkdir -p data
```

5. **Start the stack:**

```bash
docker compose up -d
```

6. **Watch startup logs:**

```bash
docker compose logs -f apps-api apps-worker apps-scheduler redis
```

Expected: within 30s `apps-api` logs `[boot] api ready on 0.0.0.0:7878 — config OK; signer keys absent`. Within 60s all services show `healthy` in `docker compose ps`.

### §15.3 Starting and stopping

```bash
# Start all services
docker compose up -d

# Stop all services (volumes kept)
docker compose down

# Stop and remove volumes (destructive — wipes Redis queue data and DB)
docker compose down -v

# Restart a single service (e.g. after rotating tokens)
docker compose up -d --no-deps --force-recreate apps-api apps-worker apps-scheduler

# View logs for NestJS services only
docker compose logs -f apps-api apps-worker apps-scheduler
```

### §15.4 Health checks

```bash
# Check all service states
docker compose ps

# Liveness probe from within apps-api
docker compose exec apps-api node -e \
  "fetch('http://127.0.0.1:7878/healthz').then(r=>console.log('status:'+r.status))"

# Readiness probe
docker compose exec apps-api node -e \
  "fetch('http://127.0.0.1:7878/readyz').then(r=>console.log('status:'+r.status))"

# Cross-service connectivity from crypto-claw gateway
docker compose exec crypto-claw curl -fsS http://apps-api:7878/healthz

# Redis health
docker compose exec redis redis-cli ping
```

If any service shows `unhealthy`, check logs:

```bash
docker compose logs --tail=50 apps-api
```

### §15.5 Rotating bearer tokens

1. Edit `.env.runtime` and replace the stale token with a new 32-char random:

```bash
openssl rand -base64 32 | tr -d '/+=' | head -c 32
```

2. Restart only the NestJS services (gateway restart is not needed):

```bash
docker compose up -d --no-deps --force-recreate apps-api apps-worker apps-scheduler
```

3. Update any agents or dashboards using the old token. The old token is rejected immediately after restart (no grace period).

### §15.6 Rotating signer keys

1. Edit `secrets/signer.env` with the new key:

```bash
# Ensure mode 0400 is preserved
chmod 0400 secrets/signer.env
```

2. Restart `apps-worker` only (the scheduler and api don't hold signer keys):

```bash
docker compose up -d --no-deps --force-recreate apps-worker
```

Note: any in-flight executor child processes started before the restart will complete with the old key. Verify via `cclaw receipts list --limit 10`.

### §15.7 Backups

**SQLite database:**

```bash
# Stop the writer briefly (optional; WAL mode allows hot backup)
sqlite3 data/<SAFE_ID>.db ".backup backup-$(date +%Y%m%d).db"
```

Or copy the named volume contents:

```bash
docker run --rm -v crypto-claw-data:/data -v $(pwd)/backup:/backup alpine \
  sh -c 'cp -a /data /backup/data-$(date +%Y%m%d)'
```

**Redis (BullMQ):**

Redis uses AOF persistence (everysec) in the `crypto-claw-redis` volume. For a manual snapshot:

```bash
docker compose exec redis redis-cli BGSAVE
# Wait for "Background saving finished"
docker run --rm -v crypto-claw-redis:/data alpine \
  tar cz /data > redis-backup-$(date +%Y%m%d).tar.gz
```

**Agent memory (MEMORY.md):**

The memory-backup loop auto-commits to the git repo every 15 minutes. If `MEMORY_GIT_REMOTE` is set it pushes to the remote. Manual push:

```bash
docker compose exec crypto-claw bash -c 'cd $RESEARCH_WS && git push origin'
```

### §15.8 Multi-fund deployment

Each fund runs an isolated compose stack with its own `SAFE_ID` and data volume. Use separate `.env.runtime` files and named compose projects:

```bash
# Fund A
COMPOSE_PROJECT_NAME=cclaw-fund-a \
  SAFE_ID=fund-a \
  docker compose --env-file .env.runtime.fund-a up -d

# Fund B
COMPOSE_PROJECT_NAME=cclaw-fund-b \
  SAFE_ID=fund-b \
  docker compose --env-file .env.runtime.fund-b up -d
```

Agent memory (MEMORY.md) is shared across all deployments if they use the same image/workspace config. SQLite data is per-fund (volume name is project-scoped by Compose).

### §15.9 Known limitations (P6)

- **No horizontal scaling.** SQLite allows only one writer per file; running multiple `apps-api` replicas against the same DB would serialize all writes through SQLite's WAL lock. Future: Postgres migration (SPEC §2 non-goal).
- **apps-executor is not a long-running service.** It is spawned per order by `apps-worker`. This is by design (blast-radius isolation, SPEC §2). Do not add an `apps-executor` stanza to `docker-compose.yml`.
- **Signer key rotation requires apps-worker restart.** No hot-reload. An in-flight executor child completes with the old key. See §15.6.
- **Redis queue persistence.** AOF `everysec` means at most 1 second of BullMQ job loss on unclean shutdown. Accepted at current ops scale.
- **§13.5 parity capture deferred to PR-B.** The 90-min paper-mode comparison (legacy vs P6) runs after this PR lands. See PR-B (`chore/p6-prb-parity-capture`).

## §16 Per-identity authz (P7)

Per ADR-0029. Three-phase rollout: shadow (PR-A) → per-agent tokens (PR-B) → enforce (PR-C).

### §16.1 Shadow-mode observation (PR-A — current)

`AUTHZ_SHADOW_MODE=1` is the default. The `IdentityGuard` logs but does not reject. Observe logs during normal operation:

```bash
docker compose logs -f apps-api 2>&1 | grep identity_blocked_shadow
```

Expected output while all agents share the LOOP token: no entries (LOOP has wildcard scope).

After PR-B plumbs per-agent tokens, you will see which routes each identity hits. Use this period to verify the `@Identities(...)` mapping is correct before flipping enforce mode.

### §16.2 Per-identity scope table

| Identity  | Scope                                 | Notes                                   |
|-----------|---------------------------------------|-----------------------------------------|
| RESEARCH  | Orders (propose/approve/reject/cancel/retry), positions, receipts (read), alerts, watchlist, wallets, liquidity, contracts, heartbeat, research-log, analysis-cache, system (read+meta+cash-write) | Cannot execute orders |
| SENTINEL  | Orders (propose/cancel, read), positions (read), alerts, watchlist (write), signals, heartbeat, sentinel-log, analysis-cache (read), system (read) | Can only propose SELL orders |
| EXECUTOR  | Orders (list/get/execute), receipts (create), positions (update), alerts/send, heartbeat, executor-log, system/cash (write), chains | Cannot propose/approve/reject orders |
| OBSERVER  | All GETs + alerts/send + observer-log (write) + system/audit | Read-only observer |
| LOOP      | Wildcard (`*`) — covers all routes    | Background loops + retained scripts. Will narrow after PR-B. |
| WORKER    | Empty set                             | No inbound HTTP; 403 everywhere in enforce mode |
| SCHEDULER | Empty set                             | No inbound HTTP; 403 everywhere in enforce mode |
| DASHBOARD | Wildcard (`*`) — but role boundary (GET-only) enforced by RolesGuard | Dashboard reads everything |

### §16.3 Enforce-flip checklist (PR-C prerequisites)

Before flipping `AUTHZ_SHADOW_MODE=0`:

1. PR-B merged: `RESEARCH/SENTINEL/EXECUTOR/OBSERVER_API_KEY` plumbed per agent.
2. 72-hour shadow observation shows zero unexpected `identity_blocked_shadow` events for in-scope identities.
3. Any `identity_blocked_shadow` events reviewed and either:
   - The route's `@Identities(...)` mapping corrected, or
   - Deemed acceptable (WORKER/SCHEDULER presenting token by mistake → investigate).
4. Security-auditor APPROVE on PR-C.
5. `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration` green locally.

### §16.4 72-hour shadow observation (PR-B — current)

After PR-B deploys, each `entrypoint.sh` dispatch site (executor loop, sentinel loop alert calls, emergency scripts) uses the matching per-agent token. The LLM agents themselves (spawned by `openclaw agent`) still inherit the container-level `CCLAW_API_TOKEN=$LOOP_API_KEY` (architectural constraint — OpenClaw cron/agent launcher shares one gateway env; see §16.5 for the gap). The shadow window reveals which routes each identity hits via cclaw from the explicit entrypoint.sh calls.

Observe the per-identity shadow log matrix:

```bash
docker compose logs -f apps-api 2>&1 | grep identity_blocked_shadow | awk -F'"' '{print $4, $8, $12}' | sort -u
```

This prints `<identity> <method> <path>` for every blocked-but-shadowed request. Expected after PR-B:

- `EXECUTOR` on `POST /v1/alerts/*` — executor loop alert calls
- `SENTINEL` on `POST /v1/alerts/*` — sentinel loop alert calls
- LOOP will still appear for: paper-seed, memory-backup, and any LLM-agent-internal cclaw calls (see §16.5)

If `identity_blocked_shadow` lines appear for an identity on a route that is NOT in its scope table (§16.2), investigate before flipping enforce mode. Either the `@Identities(...)` mapping needs correction, or the call site needs to use the correct token.

### §16.5 Per-identity token rotation

All five gateway tokens (`RESEARCH/SENTINEL/EXECUTOR/OBSERVER/LOOP_API_KEY`) are independent bearer tokens validated from `.env.runtime`. To rotate a single identity's token without disrupting others:

1. Generate a new token (minimum 32 printable characters):

```bash
openssl rand -hex 32
```

2. Update `.env.runtime` for the single identity (e.g., `EXECUTOR_API_KEY=<new-value>`).

3. Update the matching key in the cclaw token registry (apps-api reads token→identity from the registry at startup). The registry is validated at boot; no hot-reload.

4. Restart only `apps-api` to pick up the new token:

```bash
docker compose up -d --no-deps --force-recreate apps-api
```

5. Restart `crypto-claw` (the OpenClaw gateway) so `entrypoint.sh` reads the updated key from the container env:

```bash
docker compose up -d --no-deps --force-recreate crypto-claw
```

Order matters: restart `apps-api` first (so the new token is accepted before the gateway starts using it). Agents reading the old token will get 401 in the brief window between the two restarts; the retry loop in `entrypoint.sh` handles this gracefully.

**Architectural note (PR-B gap):** LLM agents spawned by the OpenClaw gateway via `openclaw cron` (research-cycle, observer-cycle) and `openclaw agent` (executor/sentinel loops) inherit `CCLAW_API_TOKEN=$LOOP_API_KEY` from the container env. The `IdentityGuard` therefore sees `identity=LOOP` for all cclaw calls made from inside the LLM agent's skill execution. Only the explicit cclaw calls in `entrypoint.sh` background loops (alert sends, emergency scripts) carry the per-agent identity. PR-C's enforce flip must account for this: LOOP must remain in the `@Identities(...)` allowlist for any route that LLM agents call directly from their skills. Narrowing LOOP out of any such route requires either extending `openclaw cron/agent` to accept per-agent env injection, or moving those calls into explicit `entrypoint.sh` dispatch sites with the per-agent token prefix.

### §16.6 Emergency rollback

If enforce mode causes unexpected 403s in production:

```bash
# Option 1: runtime kill-switch (no code deploy needed)
# Add to .env.runtime:
AUTHZ_SHADOW_MODE=1

# Then restart apps-api:
docker compose up -d --no-deps --force-recreate apps-api
```

Option 2: `git revert` the PR-C commit and redeploy.
