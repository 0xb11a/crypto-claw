# CLAUDE.md — CryptoClaw Developer Guide

This file helps Claude Code (and any Claude-based tool) understand the CryptoClaw project so it can assist with development, debugging, and extending the system.

## What This Project Is

CryptoClaw is a four-agent crypto research and portfolio management system built for [OpenClaw](https://openclaw.ai/). It discovers high-potential tokens, analyzes them, proposes BUY trades (requiring human approval), and auto-executes SELL trades (stop-loss, take-profit, rug warnings) without approval — all through a Safe multisig wallet.

## Architecture

Four agents communicate through a shared SQLite database:

- **Research Agent** (`agents/research/`) — Runs on GPT-5.5 via Codex OAuth, 30-minute heartbeat. Handles discovery, market checks, trade proposals. Handles all skills directly (analysis, risk, portfolio). Has 5 skills: discovery, analyst, risk, portfolio, orders.
- **Sentinel Agent** (`agents/sentinel/`) — Runs on GPT-5.5 via Codex OAuth, 15-minute heartbeat. Monitors positions, detects stop-loss/take-profit/rug conditions, writes sell orders to the unified orders table. Has 1 skill: sentinel.
- **Executor Agent** (`agents/executor/`) — Runs on GPT-5.5 via Codex OAuth, 1-minute heartbeat. Reads orders (buy and sell), validates, builds Safe wallet transactions, signs, and submits. Has 1 skill: executor.
- **Observer Agent** (`agents/observer/`) — Runs on GPT-5.5 via Codex OAuth, 120-minute heartbeat. Monitors system logs and DB for execution failures, creates GitHub issues in a private repo for Claude Code to fix, sends Telegram alerts for operational issues. Has 2 skills: triage, create-gh-issue. Read-only access to DB. Part of the self-improvement loop.
- **Ollama Cloud** — Some agents might use Ollama Cloud's API (`https://ollama.com/api/chat`). No sidecar needed — OpenClaw's built-in Ollama provider sends `OLLAMA_API_KEY` as a Bearer token directly.
- **Model Routing** — All agents default to OpenAI Codex OAuth provider (ChatGPT subscription, flat fee): all four agents on GPT-5.5. Configured via `RESEARCH_MODEL`/`SENTINEL_MODEL`/`EXECUTOR_MODEL`/`OBSERVER_MODEL` env vars with `openai-codex/` prefix. Falls back to OpenAI API (`openai/` prefix + `OPENAI_API_KEY`) if Codex OAuth not configured. Research handles all skills directly (no sub-agent spawning).

## Memory System — Two Layers

CryptoClaw separates memory into two distinct layers:

### Layer 1: Agent Memory (Markdown — shared knowledge)
Patterns, lessons, scoring calibration — knowledge that applies across all fund deployments. Lives in markdown files, backed by a **private git repo** (separate from the code repo).

- `workspace/MEMORY.md` — Curated long-term patterns (updated when pattern seen 3+ times)
- `workspace/memory/YYYY-MM-DD.md` — Daily logs with timestamped entries
- Backed up every 15 minutes via `memory-backup.sh` (background shell loop in `entrypoint.sh`)
- Sentinel/Executor/Observer `memory/` dirs are symlinked to Research's workspace — the single backup job covers all four agents' writes

### Layer 2: Wallet Data (SQLite — per-fund)
Positions, trades, orders, alerts, receipts — everything tied to a specific Safe wallet. One database per fund, identified by `SAFE_ID`.

- Database path: `data/<SAFE_ID>.db`
- Primary access via `cclaw <resource> <action>` (canonical post-P5b). Agents never invoke db-query.js — it was deleted in the retained-set deletion follow-up.
- Schema managed by `prisma/migrations/` — Prisma migrations applied automatically by `apps/api` on startup via `runPrismaMigrateDeploy()` in `apps/api/src/main.ts` (P6-fragment). `scripts/db.js` was deleted in the retained-set deletion follow-up.
- 21 tables: positions, trades, orders, receipts, sentinel_alerts, watchlist, liquidity_snapshots, tracked_wallets, heartbeat_state, sentinel_log, executor_log, portfolio_meta, paper_positions, paper_receipts, analysis_cache, portfolio_sync, contract_snapshots, research_log, observer_log, smart_money_signals, _migrations

### Why Two Layers?
The project can be deployed multiple times managing different Safe wallets/funds. Agent memory (patterns, lessons) is universal knowledge shared across all deployments. Wallet data (positions, cash, orders) is specific to one fund and must be isolated.

## Data Flow

```
Research → orders table            → Executor → Safe wallet → positions table
Sentinel → orders table            → Executor → Safe wallet → positions table
Executor → receipts table          → Research (learning), Sentinel (awareness)
```

In **paper mode** (`PAPER_MODE=true`), the flow is identical but uses simulated tables:
```
Research → orders (auto-approved)          → Executor → paper_receipts + paper_positions
Sentinel → orders                          → Executor → paper_receipts + paper_positions
```

All agent-to-agent communication goes through the database, accessed via `cclaw` CLI.

## Wallet Pipeline (smart-money signal flow)

Smart-money tracking is a four-role pipeline. Each role has a bounded contract; bugs that violate a contract surface as the failure mode listed.

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────────┐     ┌──────────────────────────────┐
│ 1. PROPOSAL     │ ──▶ │ 2. CLASSIFICATION    │ ──▶ │ 3. ACTIVITY POLLING    │ ──▶ │ 4. SIGNAL CONSUMPTION         │
│ status=proposed │     │ status=scored/failed │     │ smart_money_signals    │     │ Research → BUY signals        │
│ (free, async)   │     │ (heavy, throttled)   │     │ (per-swap rows, 24h)   │     │ Sentinel → SELL on positions  │
└─────────────────┘     └──────────────────────┘     └────────────────────────┘     └──────────────────────────────┘
   propose-wallet           WalletScoringProcessor       WalletActivityProcessor       Research/Sentinel heartbeats
   (db-query.js)            (NestJS worker, 10 min)      (NestJS worker, 30 min)       via db-query.js
                            batch=10, 30s/wallet         batch=10 by oldest             get-smart-money-signals
                            calls 3 APIs in parallel    last_checked_at, fail-fast
```

**Role 1 — Proposal** (cheap, on-demand)
- Anyone in the system inserts wallets with `status='proposed'` via `propose-wallet` (db-query.js command)
- Sources: Birdeye leaderboards (WalletHarvestProcessor NestJS worker), agent manual proposals
- Unbounded growth allowed. Dedup via `INSERT OR IGNORE` on `(address, chain)` PK.

**Role 2 — Classification** (heavy, bounded, throttled)
- `WalletScoringProcessor` NestJS worker, every 10 min
- Picks 10 `proposed` wallets per cycle; each wallet: 3 parallel API calls (Birdeye trader, Birdeye token-traders, Zerion PnL)
- Result: `status='scored'` with type `smart_money` (75+) / `whale` (55-74), or `status='failed'` with `retry_count++` (max 3 retries)
- Self-seeds Birdeye top-10 gainers per chain every 60 min (gated by `portfolio_meta.last_birdeye_harvest_at`)
- **Bounded:** ≤ 5.5 min per cycle, ≤ 600 wallets/day throughput
- Health: `portfolio_meta.last_score_wallets_bg_at` (written every cycle). Observer alerts via `system_health` if > 30 min stale.

**Role 3 — Activity polling** (medium, bounded, rotated)
- `WalletActivityProcessor` NestJS worker, every 30 min
- Picks **10 wallets per cycle** WHERE `type='smart_money' AND status='scored'`, ORDER BY `last_checked_at ASC NULLS FIRST` (rotation)
- Per wallet: fetches recent transfers (EVM `tokentx`) or parsed transactions (Solana Helius). **Per-fetch hard cap 10 s** via `AbortSignal.timeout`. **Per-chain fail-fast at 5 consecutive timeouts** → skip remainder of that chain this cycle.
- Groups transfers by `tx_hash`, identifies swap legs (one stable/native + one subject side), emits one signal per swap
- `INSERT OR IGNORE` into `smart_money_signals` (UNIQUE on `tx_hash, wallet_address, action, token_address`)
- Updates `tracked_wallets.last_checked_at` for every wallet processed (success OR failure — rotation always advances; a permanently dead wallet doesn't block the queue)
- Prunes signals older than 24 h at start of each cycle
- **Bounded:** ≤ ~5 min per cycle worst case (10 × 10 s timeout + 9 × 250 ms delays per chain, parallel chains)
- Health: `portfolio_meta.last_activity_wallets_bg_at`. Observer alerts via `system_health` if > 90 min stale.
- **Worst-case detection lag for any single wallet:** `ceil(M_smart_money / 10) × 30 min`

**Role 4 — Signal consumption** (cheap, agent-owned)
- **Research** heartbeat (`smart_money_signals` check, every 30 min):
  ```
  cclaw wallets signals --since 35m --action buy --group-by token --min-wallets 2
  ```
  Returns tokens where ≥2 distinct `smart_money` wallets bought in last 35 min. Pipes into discovery → analysis → risk → trade proposal.
- **Sentinel** heartbeat (`smart_money_exits` check, every 15 min):
  ```
  cclaw wallets signals --since 30m --action sell --tokens-in-positions --group-by token
  ```
  Returns held tokens that `smart_money` wallets are dumping. **Informational only** (no auto-sell) — alerts the operator.
- 35 min sliding window absorbs 5 min of heartbeat-jitter overlap; same signal may be returned by 2 consecutive heartbeat cycles. Consumers tolerate this (Research dedups via `check-token-status` cache).

**Failure boundaries:**
| Component | Failure | Detected by | Surface |
|---|---|---|---|
| Wallet scoring API down | `WalletScoringProcessor` marks wallets `failed`, retries up to 3× | `last_score_wallets_bg_at` staleness | Observer `system_health` alert |
| Activity polling API down | `WalletActivityProcessor` per-chain fail-fast, signal table grows stale | `last_activity_wallets_bg_at` staleness | Observer `system_health` alert |
| Heartbeat consumer query empty | Research/Sentinel reports "no signals" | implicit (no signals ≠ no activity) | Observer correlates with bg health row |

**Known limitations (accepted):**
- Wallets routing through multisigs/intent solvers may be miscounted (swap appears under router/safe address)
- Native ETH ↔ TOKEN swaps without WETH wrap aren't detected on EVM (only ERC-20 ↔ ERC-20)
- Multi-hop swaps with multiple OUTs and one IN are skipped

## Project Structure

```
agents/research/          # Research Agent config (AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md, skills/)
agents/sentinel/          # Sentinel Agent config (same structure, fewer skills)
agents/executor/          # Executor Agent config (same structure, 1 skill)
workspace/                # Shared workspace (copied to all agents by build-templates.sh)
  MEMORY.md               # Curated long-term patterns and lessons (agent memory)
  memory/                 # Daily log directory (agent memory)
  USER.md                 # Operator profile (editable)
  IDENTITY.md             # Agent identity
  TOOLS.md                # Full tool reference (not deployed — per-agent versions in agents/{name}/TOOLS.md)
  BOOT.md                 # First-run setup
scripts/                  # Node.js scripts (~10 retained files post-retained-deletion)
  package.json            # Dependencies (dotenv) — no longer needs better-sqlite3
  heartbeat-check.js      # Pre-check for sentinel/executor background loops (uses cclaw)
  emergency-sentinel.js   # Emergency sentinel activation on repeated model failures (uses cclaw)
  emergency-executor.js   # Emergency executor activation on repeated model failures (uses cclaw)
  redact.js               # Sensitive data redaction (shared module — imported by log.js, promote-pattern.js)
  log.js                  # Structured logging helper (writes to system.log + stderr)
  promote-pattern.js      # MEMORY.md write-protection (provenance trail enforcement, uses cclaw)
  pre-commit-check.js     # Secret scanner + MEMORY.md trail gate + npm-audit gate
  memory-backup.sh        # Git auto-commit for agent memory
  codex-login.sh          # One-time Codex OAuth login (ChatGPT subscription)
  ci/                     # CI guard scripts (check-vitest-workspace.mjs, check-dockerfile-modules.mjs)
tests/                    # Integration test suites (parity specs deleted in P5; unit + integration remain)
Dockerfile                # Based on ghcr.io/openclaw/openclaw:latest
docker-compose.yml        # One-command deployment
build-templates.sh        # Docker build-time template assembly
.env.example              # Environment variable template
```

## Key Files to Know

| File | What It Does |
|------|-------------|
| `agents/research/AGENTS.md` | Core operating contract — pipeline, safety rules, memory protocol, approval logic |
| `agents/sentinel/AGENTS.md` | Monitoring rules, sell order logic, alert format |
| `agents/executor/AGENTS.md` | Transaction rules, validation logic, receipt format, Safe integration |
| `libs/chain/src/portfolio-rules.ts` | Portfolio rule constants — canonical post-P5 |
| `libs/modules/heartbeat/src/cadences.ts` | Heartbeat cadences per agent/check (canonical; mirrors former scripts/db-query.js HEARTBEAT_CADENCES) |
| `agents/{name}/TOOLS.md` | Per-agent CLI usage guide — each agent gets only the commands/scripts it uses |
| `scripts/redact.js` | Sensitive data redaction — used by log.js (2-layer defense) |
| `scripts/log.js` | Structured logging — writes redacted entries to /tmp/openclaw/system.log + stderr |
| `workspace/TOOLS.md` | Full tool reference (not deployed) — check this for the complete picture |
| `entrypoint.sh` | Docker runtime init — per-agent config, background loops, workspace seeding |
| `build-templates.sh` | Build-time deployment — which scripts/skills/markdown each agent gets (~10 retained scripts) |

## Commands

```bash
# Type-check the monorepo
pnpm typecheck

# Lint TypeScript + retained legacy scripts
pnpm lint

# Run unit tests
pnpm test:unit

# Run integration tests (requires prior pnpm build)
pnpm build && pnpm test:integration

# Database queries (via cclaw CLI — requires CCLAW_API_TOKEN + running API)
cclaw system portfolio
cclaw positions list --status open

# Paper mode queries
cclaw positions list --status open --mode paper
cclaw system portfolio --mode paper

# Docker
docker compose up -d            # Start
docker compose logs -f          # Watch logs
docker compose down             # Stop

# Docker with paper mode
PAPER_MODE=true docker compose up -d
PAPER_MODE=true PAPER_STARTING_BALANCE=5000 docker compose up -d
```

## Tech Stack

- **Runtime:** Node.js 22+ (ESM modules, `"type": "module"`)
- **Database:** SQLite via Prisma (WAL mode, migrations managed by `prisma/migrations/`)
- **Dependencies (legacy scripts):** dotenv
- **APIs used by scripts:** DEXScreener (free), GoPlus Security (free tier), CoinGecko (free), Etherscan (free tier), Birdeye (optional), Solscan (optional)
- **Execution:** Safe wallet SDK (EVM) and Squads Protocol V4 (Solana) for transaction building/signing, DEX aggregators (1inch for EVM, Jupiter for Solana) for swaps
- **No framework.** Scripts are standalone CLI tools that output JSON to stdout.

## Conventions

- **Agent instructions** live in Markdown files (AGENTS.md, SOUL.md, HEARTBEAT.md, skills/*/SKILL.md). These are natural language, not code.
- **Wallet data** for agents is accessed exclusively via the `cclaw` CLI (canonical post-P5b). All `node scripts/db-query.js` hold-backs in agent markdown were replaced in P5b. `db-query.js` and `db.js` were deleted in the retained-set deletion follow-up — the 4 retained scripts that imported them were ported to cclaw subprocess calls.
- **Agent memory** (MEMORY.md, daily logs) is in markdown, versioned in a separate private git repo.
- **Retained legacy scripts** take CLI flags, output JSON to stdout, errors to stderr. Always exit 0 on success, 1 on failure.
- **Tests** use vitest (unit + integration). Legacy `tests/test-*.js` suites were deleted in P5.
- **Safety rules are hard-coded** in `agents/research/AGENTS.md` under "Portfolio Rules" and in `agents/executor/AGENTS.md` under "Pre-Execution Validation." Never weaken these without explicit human approval.
- **Private keys** live ONLY in environment variables. Never in any file, log, receipt, or agent instruction.
- **SAFE_ID** env var determines which database file is used. One DB per fund/wallet.
- **Solana wallet config:** `SQUADS_VAULT_ADDRESS` (direct vault) takes priority over `SQUADS_MULTISIG_ADDRESS` (vault derived from multisig PDA). Set at least one for Solana.
- **OLLAMA_API_KEY** env var authenticates with Ollama Cloud model access.
- **Observer agent** requires `GH_TOKEN` and `OBSERVER_ISSUES_REPO` (private repo, e.g., `owner/crypto-claw-issues`) to create GitHub issues. Without these, the observer cron job is not created. `GH_TOKEN` is written to `~/.config/gh/hosts.yml` at container startup (writable tmpfs mount). Agents use `gh` CLI directly — no token env var needed at runtime (OpenClaw's gateway strips env vars whose values match GitHub token patterns).
- **OpenAI auth** supports two methods (priority order): (1) OpenAI Codex OAuth via ChatGPT subscription (flat fee, `openai-codex/` prefix) — setup: `docker compose exec crypto-claw openclaw models auth login --provider openai-codex`, (2) `OPENAI_API_KEY` static API key (per-token billing, `openai/` prefix).

## Safety Rules (Do Not Weaken)

These limits are intentionally strict and must not be relaxed. Canonical source of truth: `libs/chain/src/portfolio-rules.ts` (TypeScript, compiler-enforced).

- Max moonshot position: 5% of chain portfolio (Solana: 7% — see `libs/chain/src/portfolio-rules.ts`)
- Max conviction position: 10%
- Max base position: 30%
- Max total moonshot allocation: 30%
- Min cash reserve: 10%
- Max same-narrative positions: 3
- Auto-reject: honeypot, top holder >30%, liquidity <$5k, known scam deployers, pausable contracts
- Slippage limits: 5% moonshot, 2% conviction/base (enforced in `ExecuteOrderProcessor` NestJS worker)
- Stale order protection: reject if price drifted >10% from proposal

## Paper Mode

Paper mode (`PAPER_MODE=true`) runs the full system autonomously without touching real funds. Useful for backtesting strategy, validating agent behavior, and building confidence before deploying capital.

### How It Works
- **Research Agent:** BUY proposals that pass all safety checks are auto-approved (`approved_by: 'paper_mode'`). No human in the loop.
- **Sentinel Agent:** Monitors `paper_positions` instead of `positions`. All monitoring logic (price checks, liquidity, wallets) runs identically.
- **Executor Agent:** Validates orders normally but skips Safe wallet transactions. Records results in `paper_receipts` and `paper_positions` tables. Updates `paper_cash` instead of `cash`.
- **Safety rules are fully enforced** — paper mode tests the strategy, not a weakened version of it.

### Environment Variables
- `PAPER_MODE=true|false` (default: `false`)
- `PAPER_STARTING_BALANCE=10000` (default: `10000`, simulated USD)

## Auto-Approve BUY

When `AUTO_APPROVE_BUY=true` (default: `false`), BUY orders in real mode skip human approval and go directly to `status='approved'` with `approved_by='auto'`. Telegram alerts still fire so the operator sees what was auto-approved. Has no effect when `PAPER_MODE=true` (buys are already auto-approved by `paper_mode`).

### Paper-Specific Tables
- `paper_receipts` — what would have been executed (buy/sell records with P&L)
- `paper_positions` — simulated portfolio positions

### Paper-Specific Commands (via cclaw)
- `cclaw system portfolio --mode paper`, `cclaw positions list --mode paper`, `cclaw receipts list --mode paper`
- `cclaw system cash get`, `cclaw system cash set --chain X --amount Y`

## Telegram Integration

CryptoClaw sends alerts to a Telegram supergroup with per-topic routing. Each agent type and system function sends to its own topic thread.

### Topic Environment Variables
- `TG_TOPIC_RESEARCH` — Thread ID for research discoveries and trade proposals
- `TG_TOPIC_SENTINEL` — Thread ID for sentinel alerts (stop-loss, rug, LP)
- `TG_TOPIC_EXECUTOR` — Thread ID for execution receipts
- `TG_TOPIC_ALERTS` — Thread ID for critical alerts (model failure, emergency mode, rug warning)
- `TG_TOPIC_SYSTEM` — Thread ID for system health messages (recovered, heartbeat summary)
- `TG_TOPIC_OBSERVER` — Thread ID for observer agent messages (system health checks)
- `TG_TOPIC_PORTFOLIO` — Thread ID for daily portfolio reports
- `TG_TOPIC_APPROVALS` — Thread ID for interactive approve/reject buttons (falls back to `TG_TOPIC_RESEARCH`)

### Security
- `TELEGRAM_OWNER_ID` — Restricts owner-only commands (approve/reject) to a single Telegram user ID.

### Setup
1. Create a Telegram supergroup with topics enabled
2. Discover thread IDs by sending a message to each topic, then inspect the Telegram Bot API `/getUpdates` response (`message.message_thread_id` field)
3. Set the `TG_TOPIC_*` env vars in `.env`
4. Set `TELEGRAM_OWNER_ID` to your Telegram user ID

### Daily Portfolio Reports
Configure `PORTFOLIO_REPORT_HOUR` (0-23, default: 0) to receive automated daily portfolio summaries in the portfolio topic.

## When Modifying

- **Adding a new script:** Add it to `scripts/` (if it's in the retained set), document it in `workspace/TOOLS.md` (full reference) AND the relevant agent's `agents/{name}/TOOLS.md` (per-agent reference), add it to the appropriate agent's copy list in `build-templates.sh`, and add it to the agent's shell allowlist in `entrypoint.sh` (see per-agent `agents.list[N]` overrides). New data-fetching scripts are no longer the preferred pattern — prefer NestJS processors in `apps/worker/src/processors/`.
- **Adding a new DB table:** Add a Prisma migration in `prisma/migrations/` and a corresponding NestJS repository with cclaw subcommands in `sdk/cclaw/src/index.ts`. Document new cclaw commands in `workspace/TOOLS.md` (full reference) AND the relevant agent's `agents/{name}/TOOLS.md`.
- **Changing safety rules:** Update `agents/research/AGENTS.md` AND `agents/executor/AGENTS.md` (if execution-related) AND `libs/chain/src/portfolio-rules.ts` — the TypeScript source is the canonical enforcement point.
- **Adding a new agent:** Follow the pattern in `agents/observer/` (the most recently added agent) — create a directory with AGENTS.md, SOUL.md, HEARTBEAT.md, and skills/. Add per-agent config overrides on `agents.list[N]` in `entrypoint.sh` (tools, permissions, memory, compaction — follow least privilege). Add directory creation, file copy, and symlink logic to `build-templates.sh`. Add the agent name to `HEARTBEAT_CADENCES` and `AGENT_HEARTBEAT_INTERVALS` in `libs/modules/heartbeat/src/cadences.ts`. Update `docker-compose.yml` if it needs different resources.
- **Changing agent tool/permission config:** OpenClaw global config applies to all agents — per-agent tool restriction is enforced by **script deployment** (which .js files each agent gets in its workspace) and **skills directories** (each agent only sees its own skills). Edit `entrypoint.sh` for global settings, `build-templates.sh` for per-agent script deployment.
- **Modifying the pipeline:** Update the corresponding NestJS processor in `apps/worker/src/processors/` and its vitest integration spec.
- **Changing Safe wallet config:** Update `.env.example`, `docker-compose.yml`, and `agents/executor/AGENTS.md`. Never put keys in files.
- **Multi-fund deployment:** Set different `SAFE_ID` values. Each gets its own SQLite database. Agent memory (markdown) is shared across all deployments.
- **Changing agent instructions:** After editing any AGENTS.md, HEARTBEAT.md, SOUL.md, or SKILL.md file, run `/audit-instructions` to check for inconsistencies with source-of-truth files and other agent instructions.

## Code Review (v2 rewrite layer)

PRs against the `v2` branch flow through the `coder` → `tester` → `reviewer` pipeline defined in `.claude/agents/`. The reviewer enforces `SPEC.md` and `docs/dod.md`, and escalates to depth specialists on non-trivial diffs:

- `security-auditor` — **mandatory** when the diff matches DoD §F (auth/guards, secrets, `@Audited()` decorators, signer-key paths, logger redactor, throttler, CORS, new runtime dependency).
- `database-specialist` — advisory; called for non-trivial DoD §D diffs (new Prisma migration, repository, hot-path query, SQLite-vs-Postgres portability).
- `typescript-specialist` — advisory; called for type-heavy diffs (new generics, public-API type surface change, unjustified `as unknown as`).

**Environment prerequisite.** All three specialists are loaded from project-local `.claude/agents/`. They are **not** part of any Claude built-in catalog. A reviewer running in an environment that hasn't mounted the project's `.claude/` directory (cloud-side `/ultrareview` without project context, fresh clone before checkout, detached worktree) will have the `Agent` tool fail with "subagent not available" on those names. Per `reviewer.md` step 10, the reviewer must then:

1. State the failure explicitly in the verdict (no silent skip).
2. Perform an inline depth-pass against the specialist's published checklist.
3. Flag the gap as a recurring `Suggestions` entry so the operator can route the next PR through a session with the agents available.

To make a depth pass possible by default, run reviews from a local Claude Code session against a `v2`-rooted branch — `.claude/agents/` is committed on `v2` and will be loaded automatically.

## Common Pitfalls

- **No command chaining in agent instructions.** OpenClaw's exec preflight rejects compound commands (`&&`, `||`, `;`, `2>/dev/null`). Every bash code block in agent markdown files (AGENTS.md, HEARTBEAT.md, SKILL.md, TOOLS.md) must contain exactly one command. If you need to show multiple commands, use separate code fences. Each agent's TOOLS.md has the rule "Run one command per exec call" — never remove it.
- Retained scripts use ESM (`import`), not CommonJS (`require`). The `scripts/package.json` has `"type": "module"`.
- Sentinel only gets monitoring scripts (retained set: emergency-sentinel.js + log.js + redact.js + promote-pattern.js + heartbeat-check.js). Executor only gets emergency-executor.js + same set. Execution is via `cclaw orders execute`. Don't assume an agent has access to deleted scripts.
- Agent memory (markdown) is symlinked between all three agents. Daily logs written by any agent are visible to all.
- The database is also shared via symlinked `data/` directory — all agents read/write the same SQLite file.
- `entrypoint.sh` skips existing MEMORY.md to preserve learned patterns. If you need to reset, delete it first.
- Docker runs as non-root (UID 1000). File permissions matter.
- The Executor's `SAFE_SIGNER_KEY` must NEVER appear in any log, receipt, or file. Only read from env var.
- The `ExecuteOrderProcessor` validates orders independently (defense in depth) — don't assume Research's validation is sufficient.
- SQLite uses WAL mode for concurrent reads. Agents can query simultaneously without locking issues.
