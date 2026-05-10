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

### Prisma migration on first deploy

`apps/api` runs `prisma migrate deploy` automatically on startup. No manual step
is needed on the first deploy. The migration:
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

Boot-fail message format:
```
[boot] route on ControllerClass#methodName (path=/v1/...) missing @Roles(...)
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
