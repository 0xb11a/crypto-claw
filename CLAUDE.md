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
- Access via CLI: `node scripts/db-query.js <command> [--flags]`
- Schema managed by auto-migrations in `scripts/db.js`
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

All agent-to-agent communication goes through the database via `db-query.js`.

## Wallet Pipeline (smart-money signal flow)

Smart-money tracking is a four-role pipeline. Each role has a bounded contract; bugs that violate a contract surface as the failure mode listed.

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────────────┐     ┌──────────────────────────────┐
│ 1. PROPOSAL     │ ──▶ │ 2. CLASSIFICATION    │ ──▶ │ 3. ACTIVITY POLLING    │ ──▶ │ 4. SIGNAL CONSUMPTION         │
│ status=proposed │     │ status=scored/failed │     │ smart_money_signals    │     │ Research → BUY signals        │
│ (free, async)   │     │ (heavy, throttled)   │     │ (per-swap rows, 24h)   │     │ Sentinel → SELL on positions  │
└─────────────────┘     └──────────────────────┘     └────────────────────────┘     └──────────────────────────────┘
   harvest.js              score-wallets-bg.js          activity-wallets-bg.js        Research/Sentinel heartbeats
   propose-wallet           (every 10 min)               (every 30 min)                via db-query.js
   holder-distribution     batch=10, 30s/wallet         batch=10 by oldest             get-smart-money-signals
   token top traders         calls 3 APIs in parallel    last_checked_at, fail-fast
```

**Role 1 — Proposal** (cheap, on-demand)
- Anyone in the system inserts wallets with `status='proposed'` via `harvest.js`, `propose-wallet`, `holder-distribution --propose`
- Sources: Birdeye leaderboards, token top traders, position deployer/holder extraction, agent manual
- Unbounded growth allowed. Dedup via `INSERT OR IGNORE` on `(address, chain)` PK.

**Role 2 — Classification** (heavy, bounded, throttled)
- `score-wallets-bg.js` background loop, every 10 min (`entrypoint.sh:run_wallet_scoring_loop`)
- Picks 10 `proposed` wallets per cycle; spawns `score-wallet.js` with **30 s execFileSync timeout**
- Each wallet: 3 parallel API calls (Birdeye trader, Birdeye token-traders, Zerion PnL)
- Result: `status='scored'` with type `smart_money` (75+) / `whale` (55-74), or `status='failed'` with `retry_count++` (max 3 retries)
- Self-seeds Birdeye top-10 gainers per chain every 60 min (gated by `portfolio_meta.last_birdeye_harvest_at`)
- **Bounded:** ≤ 5.5 min per cycle, ≤ 600 wallets/day throughput
- Health: `portfolio_meta.last_score_wallets_bg_at` (written every cycle). Observer alerts via `system_health` if > 30 min stale. Failure mode: stuck wallets fall to `failed` state, loop continues.

**Role 3 — Activity polling** (medium, bounded, rotated)
- `activity-wallets-bg.js` background loop, every 30 min (`entrypoint.sh:run_activity_wallets_loop`)
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
  db-query.js get-smart-money-signals --since 35m --action buy --group-by token --min-wallets 2
  ```
  Returns tokens where ≥2 distinct `smart_money` wallets bought in last 35 min. Pipes into discovery → analysis → risk → trade proposal.
- **Sentinel** heartbeat (`smart_money_exits` check, every 15 min):
  ```
  db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
  ```
  Returns held tokens that `smart_money` wallets are dumping. **Informational only** (no auto-sell) — alerts the operator. Sentinel's separate `wallet_check` (via `check-wallets.js --positions`) handles unambiguous dev-wallet selling and does write sell orders.
- 35 min sliding window absorbs 5 min of heartbeat-jitter overlap; same signal may be returned by 2 consecutive heartbeat cycles. Consumers tolerate this (Research dedups via `check-token-status` cache).

**Failure boundaries:**
| Component | Failure | Detected by | Surface |
|---|---|---|---|
| Wallet scoring API down | `score-wallets-bg` marks wallets `failed`, retries up to 3× | `last_score_wallets_bg_at` staleness | Observer `system_health` alert |
| Activity polling API down | `activity-wallets-bg` per-chain fail-fast, signal table grows stale | `last_activity_wallets_bg_at` staleness | Observer `system_health` alert |
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
scripts/                  # Node.js scripts
  db.js                   # SQLite data access layer (schema, migrations)
  db-query.js             # CLI interface for agents to read/write DB
  package.json            # Dependencies (better-sqlite3, dotenv)
  scan-tokens.js          # DEXScreener trending/new
  token-metrics.js        # Detailed token data
  check-contract.js       # GoPlus safety scan
  check-positions.js      # Current prices vs stops/TPs
  check-liquidity.js      # LP change detection
  check-wallets.js        # Wallet activity tracking (multi-chain, reads from SQLite)
  harvest.js              # Wallet harvesting — proposes wallets from Birdeye/holders/top traders into tracked_wallets (status='proposed')
  score-wallet.js         # Smart-money scoring via Birdeye/Zerion PnL
  score-wallets-bg.js     # Background wallet scoring pipeline (runs one cycle, exits)
  activity-wallets-bg.js  # Background smart-money activity poller — writes per-swap rows to smart_money_signals (one cycle, exits)
  market-overview.js      # BTC dominance, fear/greed
  market-regime.js        # Market regime classification + parameter adjustment
  heartbeat-check.js      # Pre-check for sentinel/executor background loops
  agent-idleness.js       # Shared executor/sentinel idleness predicates — used by heartbeat-check.js (skip decision) and db-query.js get-heartbeats (idle_ok flag)
  portfolio-summary.js    # Allocation + P&L
  portfolio-load-evm.js   # On-chain portfolio sync (EVM via DeBank)
  portfolio-load-solana.js # On-chain portfolio sync (Solana via Helius)
  chains.js               # Centralized chain config (single source of truth)
  execute-trade-evm.js    # Safe wallet swap execution (EVM)
  execute-trade-solana.js # Squads/Jupiter swap execution (Solana)
  check-safe-status.js    # Safe wallet status check (EVM)
  check-squads-status.js  # Squads multisig status check (Solana)
  check-signer-balances.js # Signer-key gas/SOL balance check (used by Observer triage and entrypoint health)
  backfill-squads-nonce.js # One-off recovery: matches stuck Squads receipts to their transactionIndex and writes safe_nonce
  narrative-check.js      # Narrative momentum
  narrative-config.js     # Narrative definitions and tier affinities
  narrative-deep-scan.js  # Deep narrative analysis
  holder-distribution.js  # Top holder analysis
  process-order.js        # Atomic order processing with status workflow and multisig tracking
  emergency-sentinel.js   # Emergency sentinel activation on repeated model failures
  emergency-executor.js   # Emergency executor activation on repeated model failures
  track-multisig.js       # Multisig approval workflow tracking
  send-alert.js           # Telegram alerts via openclaw message send (topic routing)
  send-approval.js        # Telegram approval-request message with inline approve/reject buttons (research/portfolio)
  approval-bot.js         # Long-running Telegram bot — handles approve/reject button callbacks (background loop in entrypoint)
  redact.js               # Sensitive data redaction (shared module)
  log.js                  # Structured logging helper (writes to system.log + stderr)
  telegram-get-topics.js  # Setup helper: discover supergroup topic thread IDs
  pre-commit-check.js     # Secret scanner wired into .git/hooks/pre-commit (blocks commits containing keys)
  test-solana-tx-size.js  # Standalone diagnostic — proves the Squads LUT fix keeps the meta-tx under 1232 bytes
  memory-backup.sh        # Git auto-commit for agent memory
  codex-login.sh          # One-time Codex OAuth login (ChatGPT subscription)
tests/                    # 18 test suites + runner + helpers
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
| `scripts/db.js` | SQLite schema, migrations, connection management |
| `scripts/db-query.js` | 35+ CLI commands for agents to interact with wallet data |
| `scripts/chains.js` | Centralized chain config — Safe/Squads env vars, portfolio rules, cash tokens |
| `agents/{name}/TOOLS.md` | Per-agent CLI usage guide — each agent gets only the commands/scripts it uses |
| `scripts/redact.js` | Sensitive data redaction — used by log.js (2-layer defense) |
| `scripts/log.js` | Structured logging — writes redacted entries to /tmp/openclaw/system.log + stderr |
| `workspace/TOOLS.md` | Full tool reference (not deployed) — check this for the complete picture |
| `scripts/process-order.js` | Atomic order processing — validates, executes, updates status, writes receipts |
| `entrypoint.sh` | Docker runtime init — per-agent config, background loops, workspace seeding |
| `build-templates.sh` | Build-time deployment — which scripts/skills/markdown each agent gets |

## Commands

```bash
# Run all tests (offline — no API calls)
cd tests && node run-all.js --offline

# Run all tests including network-dependent script tests
cd tests && node run-all.js

# Run individual test suites
node tests/test-memory.js       # Agent memory + SQLite schema + CRUD
node tests/test-safety.js       # Safety rule logic
node tests/test-pipeline.js     # Pipeline stage integration + executor handoff
node tests/test-executor.js     # Executor validation, slippage, receipts, portfolio updates
node tests/test-paper-mode.js   # Paper trading lifecycle, P&L, stats
node tests/test-e2e-paper.js    # End-to-end paper trading + multi-chain
node tests/test-e2e-real.js     # End-to-end real trading
node tests/test-regime.js       # Market regime classification, adjustments, anti-whipsaw
node tests/test-chains.js       # Chain config + portfolio sync
node tests/test-execution.js    # Trade execution flow
node tests/test-emergency.js    # Emergency sentinel/executor activation
node tests/test-telegram.js     # Telegram alerts + topic routing
node tests/test-scripts.js      # Script output format (needs network)
node tests/test-process-order.js # Order processing lifecycle (needs network)
node tests/test-observer.js     # Observer agent, redaction, logging, GitHub integration
node tests/test-harvest.js      # Wallet harvesting — INSERT OR IGNORE, dedup, exclusions
node tests/test-activity-bg.js  # activity-wallets-bg producer + smart_money_signals schema/dedup/rotation/pruning
node tests/test-backfill-squads-nonce.js # backfill-squads-nonce matcher and applyBackfill

# Database queries (from project root)
SAFE_ID=my-fund node scripts/db-query.js get-portfolio
SAFE_ID=my-fund node scripts/db-query.js get-positions --status open

# Paper mode queries
SAFE_ID=my-fund node scripts/db-query.js get-paper-portfolio
SAFE_ID=my-fund node scripts/db-query.js get-paper-stats

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
- **Database:** SQLite via better-sqlite3 (WAL mode, auto-migration)
- **Dependencies:** better-sqlite3, dotenv
- **APIs used by scripts:** DEXScreener (free), GoPlus Security (free tier), CoinGecko (free), Etherscan (free tier), Birdeye (optional), Solscan (optional)
- **Execution:** Safe wallet SDK (EVM) and Squads Protocol V4 (Solana) for transaction building/signing, DEX aggregators (1inch for EVM, Jupiter for Solana) for swaps
- **No framework.** Scripts are standalone CLI tools that output JSON to stdout.

## Conventions

- **Agent instructions** live in Markdown files (AGENTS.md, SOUL.md, HEARTBEAT.md, skills/*/SKILL.md). These are natural language, not code.
- **Wallet data** is in SQLite, accessed exclusively through `db-query.js`. Agents never import db.js directly.
- **Agent memory** (MEMORY.md, daily logs) is in markdown, versioned in a separate private git repo.
- **Scripts** take CLI flags, output JSON to stdout, errors to stderr. Always exit 0 on success, 1 on failure.
- **Tests** use a custom minimal framework in `test-helpers.js` — no Jest, no Mocha. Functions: `describe()`, `test()`, `testAsync()`, `assert()`, `assertEqual()`, `assertType()`, `summary()`.
- **Safety rules are hard-coded** in `agents/research/AGENTS.md` under "Portfolio Rules" and in `agents/executor/AGENTS.md` under "Pre-Execution Validation." Never weaken these without explicit human approval.
- **Private keys** live ONLY in environment variables. Never in any file, log, receipt, or agent instruction.
- **SAFE_ID** env var determines which database file is used. One DB per fund/wallet.
- **Solana wallet config:** `SQUADS_VAULT_ADDRESS` (direct vault) takes priority over `SQUADS_MULTISIG_ADDRESS` (vault derived from multisig PDA). Set at least one for Solana.
- **OLLAMA_API_KEY** env var authenticates with Ollama Cloud model access.
- **Observer agent** requires `GH_TOKEN` and `OBSERVER_ISSUES_REPO` (private repo, e.g., `owner/crypto-claw-issues`) to create GitHub issues. Without these, the observer cron job is not created. `GH_TOKEN` is written to `~/.config/gh/hosts.yml` at container startup (writable tmpfs mount). Agents use `gh` CLI directly — no token env var needed at runtime (OpenClaw's gateway strips env vars whose values match GitHub token patterns).
- **OpenAI auth** supports two methods (priority order): (1) OpenAI Codex OAuth via ChatGPT subscription (flat fee, `openai-codex/` prefix) — setup: `docker compose exec crypto-claw openclaw models auth login --provider openai-codex`, (2) `OPENAI_API_KEY` static API key (per-token billing, `openai/` prefix).

## Safety Rules (Do Not Weaken)

These limits are intentionally strict and must not be relaxed:

- Max moonshot position: 5% of chain portfolio (Solana: 7% — see `scripts/chains.js`)
- Max conviction position: 10%
- Max base position: 30%
- Max total moonshot allocation: 30%
- Min cash reserve: 10%
- Max same-narrative positions: 3
- Auto-reject: honeypot, top holder >30%, liquidity <$5k, known scam deployers, pausable contracts
- Slippage limits: 5% moonshot, 2% conviction/base (enforced in `scripts/process-order.js:171`)
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

### Paper-Specific Commands
- `get-paper-portfolio`, `get-paper-positions`, `get-paper-receipts`, `get-paper-stats`
- `add-paper-position`, `update-paper-position`, `close-paper-position`, `add-paper-receipt`
- `get-paper-cash`, `set-paper-cash`

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
2. Run `node scripts/telegram-get-topics.js` to discover thread IDs
3. Set the `TG_TOPIC_*` env vars in `.env`
4. Set `TELEGRAM_OWNER_ID` to your Telegram user ID

### Daily Portfolio Reports
Configure `PORTFOLIO_REPORT_HOUR` (0-23, default: 0) to receive automated daily portfolio summaries in the portfolio topic.

## When Modifying

- **Adding a new script:** Add it to `scripts/`, document it in `workspace/TOOLS.md` (full reference) AND the relevant agent's `agents/{name}/TOOLS.md` (per-agent reference), add output validation to `tests/test-scripts.js`, add it to the appropriate agent's copy list in `build-templates.sh`, and add it to the agent's shell allowlist in `entrypoint.sh` (see per-agent `agents.list[N]` overrides).
- **Adding a new DB table:** Add a migration in `scripts/db.js` (increment migration number), add CLI commands in `db-query.js`, add schema tests to `tests/test-memory.js`, document commands in `workspace/TOOLS.md` (full reference) AND the relevant agent's `agents/{name}/TOOLS.md`.
- **Changing safety rules:** Update `agents/research/AGENTS.md` AND `agents/executor/AGENTS.md` (if execution-related) AND `tests/test-safety.js` AND `tests/test-executor.js` — tests enforce the exact limits.
- **Adding a new agent:** Follow the pattern in `agents/observer/` (the most recently added agent) — create a directory with AGENTS.md, SOUL.md, HEARTBEAT.md, and skills/. Add per-agent config overrides on `agents.list[N]` in `entrypoint.sh` (tools, permissions, memory, compaction — follow least privilege). Add directory creation, file copy, and symlink logic to `build-templates.sh`. Add heartbeat_state seeds in the db.js migration. Add the agent name to `HEARTBEAT_CADENCES` and `AGENT_HEARTBEAT_INTERVALS` in `scripts/db-query.js`. Update `docker-compose.yml` if it needs different resources.
- **Changing agent tool/permission config:** OpenClaw global config applies to all agents — per-agent tool restriction is enforced by **script deployment** (which .js files each agent gets in its workspace) and **skills directories** (each agent only sees its own skills). Edit `entrypoint.sh` for global settings, `build-templates.sh` for per-agent script deployment.
- **Modifying the pipeline:** Update `tests/test-pipeline.js` to verify the new data flow between stages.
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
- Scripts use ESM (`import`), not CommonJS (`require`). The package.json has `"type": "module"`.
- Sentinel only gets monitoring scripts (check-positions, check-liquidity, check-wallets) + db access. Executor only gets db access + execution scripts. Don't assume an agent has access to all scripts.
- Agent memory (markdown) is symlinked between all three agents. Daily logs written by any agent are visible to all.
- The database is also shared via symlinked `data/` directory — all agents read/write the same SQLite file.
- `entrypoint.sh` skips existing MEMORY.md to preserve learned patterns. If you need to reset, delete it first.
- Docker runs as non-root (UID 1000). File permissions matter.
- The Executor's `SAFE_SIGNER_KEY` must NEVER appear in any log, receipt, or file. Only read from env var.
- Executor validates orders independently (defense in depth) — don't assume Research's validation is sufficient.
- SQLite uses WAL mode for concurrent reads. Agents can query simultaneously without locking issues.
