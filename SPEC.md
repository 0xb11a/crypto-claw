# SPEC — CryptoClaw Web Service

**Status:** Pre-implementation. Approved P-prep deliverable.
**Owner:** Sergii Bomko
**Last updated:** 2026-05-08

This document is the canonical architecture and contract for the CryptoClaw rewrite. Every PR is reviewed against it. Changes that affect invariants, contracts, or public surface require a SPEC update in the same PR plus, if locking a new decision, an ADR under `docs/decisions/`.

---

## 1. Goals

- Ship every piece of CryptoClaw functionality as a proper web service with industry best practices: security, structured logging, typed configuration, health endpoints, ORM with managed migrations, automated tests, linting, scheduled jobs, audit log.
- Replace the current 44 standalone Node CLI scripts and the hand-written SQLite layer in `scripts/db.js` with **entity-driven** modules — one module per domain entity (Position, Order, Receipt, Wallet, Signal, …) — accessed exclusively through a typed HTTP API.
- Enforce a hard authn/authz boundary between two client roles: **agent** (read+write) and **dashboard** (read-only). The agent role has no consumer at runtime today other than the OpenClaw agents themselves; the dashboard role is defined now so any future frontend (web, mobile, MCP, Live Artifacts) plugs in without service changes.
- Distribute a generated typed CLI (`cclaw`) so agent skill markdown speaks one consistent surface (`cclaw <resource> <action>`) instead of 44 ad-hoc scripts.
- Land the change behind phasing that keeps the legacy system running until the new one is proven, with a clean cutover and legacy deletion at the end.

## 2. Non-Goals

- **No Prometheus / Grafana / metrics endpoint.** Structured logs + audit log + health endpoints are sufficient at this scale. If quantitative monitoring is needed later, a thin `/metrics` is additive.
- **No public exposure** in the rewrite scope. The API binds `127.0.0.1` inside Docker. CORS, TLS termination, and reverse-proxy work belong to a future "expose" phase.
- **No Live Artifacts / MCP server / Cowork integration** in scope. The API is shaped so an MCP adapter is trivial later, but it isn't part of this rewrite.
- **No multi-region / HA topology.** Single-host `docker compose` stays the deployment unit.
- **No Postgres migration** in scope. SQLite remains. Prisma's portability means a future Postgres migration is a config + migration change, not a rewrite.
- **No rewrite of the LLM-agent loops.** `run_executor_loop` and `run_sentinel_loop` invoke the OpenClaw `openclaw` CLI; they stay in `entrypoint.sh`.
- **No rewrite of `apps/executor` (signer-key-bearing process) into a long-running service.** It remains an ephemeral subprocess spawned per order. Blast-radius isolation is the reason.

## 3. Architecture

```
                       ┌─────────────────────────────────────┐
                       │          OpenAPI 3.1 spec           │
                       │  (auto-generated from controllers)  │
                       └────────────┬────────────────────────┘
                                    │
                ┌───────────────────┼──────────────────────┐
                ▼                   ▼                      ▼
       ┌─────────────────┐ ┌──────────────────┐  ┌────────────────────┐
       │ apps/api        │ │ Generated TS SDK │  │ Future consumers   │
       │ (NestJS+Fastify)│ │   + cclaw CLI    │  │ (web app, mobile,  │
       │ HTTP, OpenAPI,  │ │ used by agents   │  │  MCP, Cowork, …)   │
       │ guards, audit   │ └──────────────────┘  └────────────────────┘
       └────────┬────────┘
                │
                ▼
       ┌────────────────────────────────────────────────────┐
       │ libs/  (NestJS shared libraries — domain modules)  │
       │  positions · orders · receipts · alerts · wallets  │
       │  liquidity · contracts · heartbeat · agent-logs    │
       │  trades · analysis-cache · paper · system          │
       │  market · chain · portfolio · execution            │
       │  notifications · auth · audit · config · logger    │
       │  prisma · health                                   │
       └────────┬───────────────────────────────────────────┘
                │
        ┌───────┴────────┬─────────────────────┐
        ▼                ▼                     ▼
┌──────────────┐ ┌─────────────────┐  ┌──────────────────┐
│ apps/worker  │ │ apps/scheduler  │  │   Prisma Client  │
│ BullMQ jobs  │ │ Cron registry,  │  │   (SQLite now,   │
│              │ │ enqueues to     │  │    Postgres-     │
│              │ │ Redis queues    │  │    portable)     │
└──────┬───────┘ └────────┬────────┘  └────────┬─────────┘
       │                  │                    │
       │                  ▼                    ▼
       │         ┌──────────────────┐  ┌──────────────────┐
       │         │ Redis (BullMQ)   │  │ data/<SAFE_ID>.db│
       │         └──────────────────┘  └──────────────────┘
       ▼
┌──────────────────────────────────────────────────────────┐
│ apps/executor (subprocess, ephemeral, per order)         │
│  loads SAFE_SIGNER_KEY / SQUADS_SIGNER_KEY at spawn      │
│  builds + signs + submits Safe / Squads transactions     │
│  signer keys never enter api/worker/scheduler env        │
└──────────────────────────────────────────────────────────┘
```

**Stack (locked; see `docs/decisions/`):** TypeScript · NestJS (Fastify adapter) · Prisma · pnpm · Node 22 LTS · BullMQ + Redis · `class-validator` DTOs · Pino · Vitest · `@nestjs/terminus` · `@nestjs/throttler` · helmet · cosign-signed multi-arch images · `release-please` · GHCR registry.

## 4. Invariants

These are non-negotiable. PRs that violate any of them are rejected at review. CI enforces (1)–(4) at boot or in pipeline.

1. **No DB access outside `libs/prisma` + repositories.** Every entity has a Repository class; services call repositories; controllers call services. `apps/*` never instantiate `PrismaClient`. ESLint rule: `no-restricted-imports` blocks `@prisma/client` outside `libs/prisma`.
2. **OpenAPI is the contract.** Controllers + DTOs (with `class-validator` decorators) generate the spec; the SDK + `cclaw` CLI are generated from the spec; CI fails if the regenerated SDK differs from the committed copy. Drift is a build error.
3. **Default-deny on every route.** Every controller method has explicit `@Roles(...)` and a typed body/query DTO. NestJS lifecycle hook `onApplicationBootstrap` walks every registered route and throws if any handler lacks both. CORS off in this scope.
4. **Signer keys live only in `apps/executor` subprocess env.** `apps/api`, `apps/worker`, `apps/scheduler` boot with a self-check that reads `process.env` and exits non-zero if `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` is set. The executor reads them from a sealed file (mode 0400) at spawn time only.
5. **The LLM-agent loops stay in `entrypoint.sh`.** `run_executor_loop` and `run_sentinel_loop` invoke the OpenClaw `openclaw` CLI which spawns an LLM agent. Those cannot move into the worker. The eight other (deterministic) loops do.
6. **Config validated at boot.** `libs/config` parses `process.env` through a Zod schema. The service exits with `[config] invalid env: <field> — <reason>` if any required var is missing or malformed.

## 5. API Style — REST with controlled RPC verbs

- Resource-oriented for CRUD: `GET /v1/positions`, `GET /v1/positions/:id`, `POST /v1/positions`, `PATCH /v1/positions/:id`, `DELETE /v1/positions/:id`.
- Action verbs (POST sub-paths) for state transitions that aren't pure CRUD: `POST /v1/orders/:id/approve`, `POST /v1/orders/:id/reject`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/retry`, `POST /v1/orders/:id/execute`, `POST /v1/positions/:id/close`.
- Read-only computed views as resources: `GET /v1/portfolio/summary`, `GET /v1/market/overview`, `GET /v1/wallets/signals/recent`.
- Listing endpoints support `?limit`, `?cursor`, `?status`, `?since`, with response envelope `{data, pagination}`.
- All paths under `/v1/`. Versioning is by URL prefix; breaking changes bump the prefix.
- All bodies/responses are JSON. No multipart, no protobuf in this scope.
- Errors: `{error: {code, message, details?}}` shape, with codes drawn from a documented enum (e.g., `validation_failed`, `not_found`, `unauthorized`, `forbidden`, `rate_limited`, `conflict`, `internal`).

## 6. Repo layout (monorepo, one image)

```
.
├── apps/
│   ├── api/                       # NestJS HTTP server (Fastify adapter)
│   ├── worker/                    # NestJS standalone (BullMQ consumer)
│   ├── scheduler/                 # NestJS standalone (cron registry)
│   └── executor/                  # Tiny standalone subprocess (signer-key holder)
├── libs/
│   ├── prisma/                    # PrismaService, module, transactions helper
│   ├── domain/                    # cross-module DTOs, enums, common types
│   ├── auth/                      # BearerGuard, RolesGuard, IdentityGuard, decorators
│   ├── audit/                     # AuditInterceptor, repository, query API
│   ├── logger/                    # nestjs-pino, request-id, redaction
│   ├── config/                    # @nestjs/config + Zod schema
│   ├── health/                    # @nestjs/terminus liveness/readiness
│   ├── notifications/             # Telegram alerts + approval bot
│   ├── market/                    # DEXScreener, Birdeye, GoPlus, narrative adapters
│   ├── chain/                     # Safe, Squads, Helius, RPC, multisig tracker
│   ├── portfolio/                 # On-chain sync, summary, P&L
│   ├── execution/                 # Spawn executor child, parse receipt, retries
│   └── modules/                   # Domain modules (one per entity)
│       ├── positions/
│       ├── orders/
│       ├── receipts/
│       ├── alerts/
│       ├── watchlist/
│       ├── wallets/               # tracked-wallets + smart-money signals
│       ├── liquidity/
│       ├── contracts/             # safety scans
│       ├── heartbeat/
│       ├── agent-logs/            # research/sentinel/executor/observer logs
│       ├── trades/
│       ├── analysis-cache/
│       ├── paper/
│       └── system/                # meta, sync-status, audit, admin
├── sdk/
│   ├── generated/                 # openapi-codegen output (committed)
│   └── cclaw/                     # CLI wrapping the SDK
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── shim-parity/               # legacy compatibility (deleted in P5)
├── docker/
│   ├── Dockerfile                 # multi-stage
│   ├── docker-compose.yml
│   └── docker-compose.dev.yml
├── entrypoint.sh                  # simplified: only LLM-agent loops + memory backup
├── docs/
│   ├── decisions/                 # ADRs
│   ├── runbook.md
│   ├── dod.md
│   └── api.md (generated)
├── nest-cli.json
├── tsconfig.json
├── package.json
├── pnpm-workspace.yaml
└── eslint.config.js
```

## 7. Domain Modules — one entity, one module

Each `libs/modules/<entity>/` is self-contained:
- `entity.controller.ts` — HTTP routes; `@UseGuards(BearerAuthGuard, RolesGuard)`; OpenAPI decorators; DTO-validated.
- `entity.service.ts` — domain logic, transactions, calls into other services through DI.
- `entity.repository.ts` — Prisma access; the only place SQL-shape code lives.
- `dto/` — `Create…Dto`, `Update…Dto`, `…ResponseDto`, all `class-validator`-annotated.
- `entity.module.ts` — wires controller, service, repository, dependencies.
- `entity.service.spec.ts`, `entity.controller.spec.ts` — unit + integration.

### Mapping the 21 existing tables to modules

| Module | Tables | Notes |
|---|---|---|
| positions | `positions`, `paper_positions` | Unified service with `mode: real \| paper`; controller exposes `?mode=` query |
| orders | `orders` | Unified buy+sell; state machine: proposed → approved/rejected → executing → executed/failed |
| receipts | `receipts`, `paper_receipts` | Mirror of positions/paper split |
| alerts | `sentinel_alerts` | Producer: sentinel; consumer: notifications |
| watchlist | `watchlist` | |
| wallets | `tracked_wallets`, `smart_money_signals` | Wallet lifecycle + per-swap signals |
| liquidity | `liquidity_snapshots` | |
| contracts | `contract_snapshots` | Safety-scan history |
| heartbeat | `heartbeat_state` | |
| agent-logs | `sentinel_log`, `executor_log`, `research_log`, `observer_log` | Single repository with `agent` discriminator |
| trades | `trades`, `trade_stats` | Historical ledger |
| analysis-cache | `analysis_cache` | TTL caching layer |
| paper | (see positions/receipts) | Module exists for paper-only ops like reset/start-fresh |
| system | `portfolio_meta`, `portfolio_sync`, `_migrations`, `service_audit` | Admin + observability |

## 8. Background Jobs

Eight of ten current shell loops move into the worker. Two LLM-agent loops stay in `entrypoint.sh`.

| Job | Source | Cadence | Where |
|---|---|---|---|
| wallet-scoring | `score-wallets-bg.js` | every 10 min | scheduler enqueues; worker processes 10 wallets |
| activity-polling | `activity-wallets-bg.js` | every 30 min | scheduler enqueues; worker per chain |
| governance-drift | `entrypoint.sh:run_governance_drift_loop` | every 24 h | scheduler enqueues; worker runs |
| position-reconcile | `reconcile-positions.js` | every 60 min | scheduler enqueues; worker runs |
| multisig-tracking | `track-multisig.js` | every 5 min | scheduler enqueues; worker runs |
| memory-backup | `memory-backup.sh` | every 15 min | **stays in entrypoint.sh** (git ops on workspace mount) |
| portfolio-report | `portfolio-summary.js` + `send-alert.js` | every 30 min | scheduler enqueues; worker runs |
| approval-bot | `approval-bot.js` | continuous | worker runs as a permanent task (BullMQ Worker, no schedule) |
| executor-loop (LLM) | `entrypoint.sh:run_executor_loop` | every 60 s | **stays in entrypoint.sh** — invokes `openclaw` |
| sentinel-loop (LLM) | `entrypoint.sh:run_sentinel_loop` | every 15 min | **stays in entrypoint.sh** — invokes `openclaw` |

Job definitions live in `libs/modules/<entity>/jobs/*.processor.ts` (BullMQ processors) and `apps/scheduler/src/schedules/*.ts` (cron entries). Job processors are written to be idempotent; tests assert idempotency by running each job twice and diffing DB shape.

## 9. Security

### 9.1 AuthN — Bearer tokens, per-identity
- Identities (one token each, all role `agent`): `RESEARCH`, `SENTINEL`, `EXECUTOR`, `OBSERVER`, `LOOP`, `WORKER`, `SCHEDULER`. Plus `DASHBOARD` (role `dashboard`, RO).
- 32-byte URL-safe random tokens; constant-time comparison; mounted from `.env.runtime` (mode 0600).
- Tokens never logged: pino redact paths cover `req.headers.authorization`, `*.token`, `*.api_key`. Audit log redacts.
- Token rotation: edit env file → `docker compose up -d --no-deps --force-recreate api worker scheduler`.

### 9.2 AuthZ — guards, decorators, default-deny
- `BearerAuthGuard` → sets `req.user = {identity, role}` or 401.
- `RolesGuard` → reads `@Roles('agent' | 'dashboard')` metadata. Missing decorator → guard rejects.
- `IdentityGuard` (P7) → reads `@Identities('EXECUTOR')` for write routes locked to a specific token. No-op shim until P7.
- Boot check: walks all controllers; throws if any handler lacks `@Roles(...)` or a body/query DTO.

### 9.3 Input validation — class-validator
- Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`. Unknown fields → 400.
- Every DTO is a class with `class-validator` decorators (`@IsString`, `@IsInt`, `@IsEnum`, `@Min`, `@Max`, `@Matches`, custom validators for chain/address shapes).

### 9.4 Rate limiting — `@nestjs/throttler`
- Defaults: agent identities 600 req/min, dashboard 60 req/min, per-identity quota via custom `ThrottlerStorage` keyed on `req.user.identity`.
- Exempt: `/healthz`, `/readyz`.

### 9.5 Audit log — every write
- Prisma model `ServiceAudit { id, ts, identity, role, method, path, body_redacted, status, latency_ms, error_kind }`.
- `AuditInterceptor` runs on every controller method tagged `@Audited()` (lint rule: every non-GET handler must be `@Audited()`).
- Body redaction via `libs/logger`'s redactor (extends current `scripts/redact.js` patterns).
- `GET /v1/system/audit` (paginated, agent role) for postmortems. `cclaw system audit …` is the operator interface.

### 9.6 Transport — localhost-only this phase
- `apps/api` binds `127.0.0.1:7878`. No CORS, no TLS, no public surface.
- `helmet` middleware emits standard security headers anyway, so a future reverse proxy doesn't have to.

### 9.7 Secret hygiene
- Boot self-check on api/worker/scheduler: exits if `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` is set.
- Signer keys live in `secrets/signer.env` (mode 0400); only `apps/executor` reads them, via the spawn helper in `libs/execution`.
- `libs/logger` redactor covers signer-key patterns, API tokens, JWT-shaped strings, and RPC URLs with embedded creds.

## 10. Configuration

`libs/config` exports a typed `AppConfig` validated by Zod at boot.

**Required (validated at boot):**
- `SAFE_ID` — fund identifier; selects the SQLite filename
- `DB_PATH` — defaults to `./data/<SAFE_ID>.db`
- `REDIS_URL`
- `RESEARCH_API_KEY`, `SENTINEL_API_KEY`, `EXECUTOR_API_KEY`, `OBSERVER_API_KEY`, `LOOP_API_KEY`, `WORKER_API_KEY`, `SCHEDULER_API_KEY`, `DASHBOARD_API_KEY`
- `ACTIVE_CHAINS` (comma-separated chain list)
- `OPENAI_API_KEY` (or Codex OAuth configured)
- `BIRDEYE_API_KEY`, `HELIUS_API_KEY`, `ZERION_API_KEY`, `ONEINCH_API_KEY`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_OWNER_ID`, `TG_TOPIC_*`

**Optional:**
- `PAPER_MODE` (default false)
- `PAPER_STARTING_BALANCE` (default 10000)
- `AUTO_APPROVE_BUY` (default false)
- `APPROVAL_MARGIN_PCT`, `RPC_VALIDATION_MODE`, `SKIP_*` flags, `CHECK_WALLETS_*` tuning

**Forbidden in `apps/api|worker|scheduler` env (boot self-check):**
- `SAFE_SIGNER_KEY`, `SQUADS_SIGNER_KEY` — must come from `secrets/signer.env` mounted only into the executor's spawn env.

## 11. Observability

- **Logs:** structured JSON via `nestjs-pino`; request-id propagation; redaction; one log line per request with method/path/status/latency/identity. Tailed via `docker compose logs -f`.
- **Health:** `/healthz` liveness, `/readyz` readiness via `@nestjs/terminus` (Prisma DB ping, Redis ping, executor binary present, migration status).
- **Audit log:** queried via `cclaw system audit …`. The metrics surface for write traffic.
- **OpenAPI:** Swagger UI at `/v1/docs` (agent role); raw JSON at `/v1/openapi.json`.

No Prometheus, no Grafana, no `/metrics` endpoint in this scope. See `docs/decisions/0008-no-prometheus.md`.

## 12. Migrations (Prisma)

- Bootstrap: `prisma db pull` against the existing populated SQLite DB. Hand-tune `schema.prisma` (relations, enums, JSON column policy).
- First migration: `prisma migrate dev --name initial`.
- All future schema changes via `prisma migrate dev`.
- `prisma/seed.ts` handles any initial-migration data backfill.
- Forward-only migrations. Rollback = redeploy prior image tag, plus `prisma migrate resolve --rolled-back` when needed.
- CI gate: `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code` fails if the schema diverges from committed migrations without a new migration file.
- Pre-deploy CI gate: `prisma migrate diff` against a snapshot of production schema; destructive changes require explicit consent.
- Per-fund DB: `SAFE_ID` selects the file; multi-fund = multiple compose stacks.

## 13. cclaw CLI

- Generated from `openapi.json` via `openapi-typescript-codegen`.
- Thin Commander.js wrapper exposes resource subcommands:
  - `cclaw positions list --status open`
  - `cclaw orders approve --id 42 --by research`
  - `cclaw wallets signals --since 35m --action buy --min-wallets 2`
- Reads token from `CCLAW_API_TOKEN` env; writes JSON to stdout, errors to stderr; exit 0 on success, 1 on error.
- Distributed inside the same image as `apps/api`. Agent containers mount the binary into `PATH`.
- Agent markdown is rewritten in P4: 197 references converted from `node scripts/<…>.js` to `cclaw <…>` via a deterministic mapping table; `/audit-instructions` is the second gate.

## 14. Testing

- **Unit** (`tests/unit/`, Vitest) — every service and repository, repos mocked. Target ≥ 80% line coverage on `libs/modules/*`.
- **Integration** (`tests/integration/`) — Nest testing module + real Prisma against an isolated test DB; per-controller request lifecycle.
- **E2E** (`tests/e2e/`) — full stack via `testcontainers`: api + worker + scheduler + redis + temp SQLite.
- **Shim-parity** (`tests/shim-parity/`, deleted in P5) — `cclaw` against pre-migration baselines.
- **Security** (`tests/integration/security/`) — boot-fail on missing `@Roles`, 401 without token, 403 cross-role, 400 schema reject, 429 rate-limit, audit row written, no token in any captured log line.
- CI runs unit + integration on every PR; full e2e nightly + on `main`.

## 15. Linting & code quality

- ESLint + `@typescript-eslint` + Nest plugin. Custom rules:
  - `boundaries` blocks cross-module deep imports
  - `no-restricted-imports` blocks `@prisma/client` outside `libs/prisma`
  - lint rule: every non-GET controller handler must carry `@Audited()`
- Prettier (existing config; extended to `*.ts`).
- Husky + lint-staged on pre-commit: lint changed files, run unit tests on changed paths, block secrets via `pre-commit-check.ts` (ported from `scripts/pre-commit-check.js`).

## 16. CI

GitHub Actions; three workflows.

### `.github/workflows/pr.yml` — every PR
1. Setup (Node 22, pnpm, restore caches).
2. Lint + format check.
3. Type check across the monorepo.
4. Unit tests (Vitest); coverage to Codecov; PR fails if changed-file coverage < 80%.
5. Integration tests (Redis service container, temp SQLite).
6. **Schema drift gate** — `prisma migrate diff … --exit-code`.
7. **OpenAPI drift gate** — boot api in `--check-config --emit-openapi`; diff against committed `sdk/generated/openapi.json`.
8. **SDK drift gate** — regenerate `sdk/generated/`; `git diff --exit-code`.
9. Secret scan — `pre-commit-check.ts` over the diff + trufflehog over the repo.
10. Container build (smoke) — `docker buildx build --target prod --platform linux/amd64`; not pushed.
11. E2E (PR sample) — single smoke flow.

### `.github/workflows/main.yml` — merge to `main`
- All PR checks PLUS multi-arch build (`linux/amd64,linux/arm64`), trivy vulnerability scan (fail on CRITICAL with fix per ADR-0016), syft SBOM, cosign keyless signing, push to `ghcr.io/<owner>/crypto-claw:sha-<sha>` and `:main`, OpenAPI artifact published.
- **`post-publish-smoke`** job runs after `build-and-publish` + `sign`; pulls the just-published image by digest (deterministic, no tag race) and runs the Docker boot-defense integration tests. Gated on `v2` / `main` refs.
- Triggers on push to `v2` and `main` during the rewrite; reduces to `main` only at P4 cutover (ADR-0011).

### `.github/workflows/nightly.yml`
- Runs on schedule `'17 2 * * *'` (02:17 UTC) and on `workflow_dispatch`. Four jobs:
  1. **`audit`** — `pnpm audit --audit-level=high --prod` (advisory; `continue-on-error: true`).
  2. **`trivy-info`** — Information-only trivy scan of the latest `:v2` image (`severity: HIGH,CRITICAL`, `ignore-unfixed: false`, `exit-code: '0'`, no suppressions); SARIF output uploaded to GitHub Code Scanning via `github/codeql-action/upload-sarif@v3`. See ADR-0017 for the CVE suppression policy.
  3. **`container-smoke-nightly`** — pulls `:v2`, builds fresh dist, runs the Docker boot-defense integration tests via `pnpm test:integration`. Catches base-image drift overnight.
  4. **`e2e-full`** — placeholder for testcontainers full E2E (deferred to P1).
- Renovate handles dep updates between nightly runs.

**Branch protection on `main`:** all PR checks required, signed commits required, 1 approving review.
**PR pipeline target:** < 6 min on warm cache.

## 17. Deployment

Deployment unit: `docker compose` on a single host. Image, release flow, and runbook upgraded.

### Image and release flow
- Registry: `ghcr.io/<owner>/crypto-claw` (derived from `${{ github.repository }}` in workflow; see ADR-0014).
- Tags: `:sha-<commit>` (immutable per main build), `:main` (rolling), `:vMAJOR.MINOR.PATCH` (release tag), `:latest` (release only).
- `release-please` automates `CHANGELOG.md` and tag creation from conventional commits.
- Operator upgrade: bump tag in `docker-compose.yml`, `docker compose pull && docker compose up -d`.

### Compose topology (excerpt)

```yaml
services:
  api:
    image: ghcr.io/<owner>/crypto-claw:vX.Y.Z
    command: node dist/apps/api/main.js
    env_file: .env.runtime
    environment:
      - SAFE_SIGNER_KEY=
      - SQUADS_SIGNER_KEY=
    volumes: [ "./data:/app/data" ]
    ports: [ "127.0.0.1:7878:7878" ]
    healthcheck:
      test: ["CMD", "node", "dist/apps/api/healthcheck.js"]
      interval: 10s
      retries: 6
    depends_on:
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/<owner>/crypto-claw:vX.Y.Z
    command: node dist/apps/worker/main.js
    env_file: .env.runtime
    environment:
      - SAFE_SIGNER_KEY=
      - SQUADS_SIGNER_KEY=
    volumes:
      - ./data:/app/data
      - ./secrets:/run/secrets:ro
    depends_on:
      api: { condition: service_healthy }
      redis: { condition: service_healthy }

  scheduler:
    image: ghcr.io/<owner>/crypto-claw:vX.Y.Z
    command: node dist/apps/scheduler/main.js
    env_file: .env.runtime
    depends_on:
      api: { condition: service_healthy }
      redis: { condition: service_healthy }

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
    volumes: [ "./data/redis:/data" ]

  agents:
    image: ghcr.io/openclaw/openclaw:latest
    volumes:
      - ./agents:/workspace
      - ./data:/app/data:ro
    environment:
      - CCLAW_API_BASE=http://api:7878
      - CCLAW_API_TOKEN=
    depends_on:
      api: { condition: service_healthy }
```

### Migrations on deploy
- `apps/api` runs `prisma migrate deploy` once on startup, guarded by an advisory lock (`INSERT OR IGNORE` into a `_deploy_lock` row). Worker and scheduler wait for the migration row before proceeding.
- Forward-only; rollback = prior image tag + `prisma migrate resolve --rolled-back` when needed.

### Secrets management
- `.env.runtime` (mode 0600, owned by deploy user, gitignored, blocked by `pre-commit-check.ts`) — API tokens + non-sensitive config.
- `secrets/signer.env` (mode 0400, mounted only into `worker`, read only by `apps/executor` at spawn) — signer keys.

### Backups and DR
- SQLite online backup (`sqlite3 .backup`) runs daily as a scheduler job into `data/backups/`.
- Optional Litestream sidecar for continuous WAL streaming to S3 — opt-in.
- Restore: stop the stack, replace the DB file, restart. Documented in `docs/runbook.md`.

### Multi-fund isolation
- One compose stack per `SAFE_ID`, each with its own `.env.runtime` and `data/<SAFE_ID>.db`.

### Multi-arch
- Images built for `linux/amd64` and `linux/arm64`. Host requirements: Docker Engine ≥ 24, compose v2, ≥ 2 vCPU, ≥ 4 GB RAM, ≥ 20 GB disk.

## 18. Phasing summary

Authoritative phase definitions live in the implementation plan. Headline:

- **P-prep** — SPEC + ADRs + env examples + baseline + runbook stub + DoD. (This document is part of P-prep.)
- **P0** — Monorepo scaffolding + CI pipeline.
- **P1** — Prisma schema + first 5 modules (positions/orders/receipts/alerts/heartbeat) + auth foundation.
  - **P1a** — Positions + Orders + auth + audit + shim-parity baseline.
  - **P1b** — Receipts + Alerts + Heartbeat + rate limiting + Swagger UI auth.
  - **P1c-i** — Executor wiring + stub binary + BullMQ `execute-order` queue + signer-isolation enforcement.
    **Rephase note:** Executor isolation was originally scheduled for P3 (SPEC §3's
    "No rewrite of `apps/executor`" note). It was accelerated to P1c-i because
    (a) the orders state machine (`approved → executing → executed`) couldn't be
    demonstrated without some executor invocation, and (b) the signer-isolation
    test infrastructure (ADR-0023) is a prerequisite for all P1c-ii/iii real-SDK
    work. P1c-i ships with a deterministic stub (EXECUTOR_STUB_MODE=1); P1c-ii
    wires the real Safe SDK; P1c-iii wires the real Squads SDK.
  - **P1c-ii** — Real Safe SDK (EVM) in executor + per-Safe BullMQ queue topology (ADR-0024 addendum) + multi-process signer-isolation E2E. Delivered in PR-A (infra: per-Safe queues, `_spawn-api.ts` helper, ADR-0026 typed-config) + PR-B (real EVM SDK, `execute-trade-evm.ts`, `checkSignerBalance`/`checkStalePrice` preflight, `signer-isolation-multiprocess.spec.ts`).
  - **P1c-iii** — Real Squads SDK (Solana) in executor (deferred).
- **P2** — Remaining DB-backed modules + cclaw covers all 79 db-query commands.
- **P3** — External-adapter modules + worker jobs. *(Executor isolation moved to P1c-i.)*
- **P4** — Cutover: agent markdown swept; entrypoint.sh simplified.
- **P5** — Legacy deletion (`scripts/*` removed).
- **P6** — Deployment hardening (release flow, signing verification, backup drill).
- **P7** — Per-identity authz tightening.

## 19. Verification

End-to-end checks:

1. Pre-migration baseline (`tests/shim-parity/baseline/`) committed at start of P1.
2. Smoke per phase: `cclaw <…>` JSON byte-identical to `node scripts/db-query.js <…>` against the same DB.
3. Boot defenses: missing `@Roles` → service refuses to start; missing required env → exits with config error.
4. Background-loop log diff (P3, P4): 90-min docker compose run pre/post; cadences and counts match.
5. Agent end-to-end in paper mode (P4): full pipeline run pre/post; audit-log + receipt rows match.
6. Signer-key isolation (P3+): `cat /proc/<api/worker/scheduler>/environ | grep SIGNER` empty; on executor child, present.
7. Token rotation drill (P5+): old token → 401 within 1 s of restart; audit captures attempts.
8. OpenAPI/SDK drift (every PR): committed spec matches running server; committed SDK matches regen.
9. Migration safety (every PR touching `schema.prisma`): `prisma migrate diff` flags destructive changes.
10. `/audit-instructions` clean after P4 and P5.
