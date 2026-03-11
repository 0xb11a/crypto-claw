# CLAUDE.md — CryptoClaw Developer Guide

This file helps Claude Code (and any Claude-based tool) understand the CryptoClaw project so it can assist with development, debugging, and extending the system.

## What This Project Is

CryptoClaw is a three-agent crypto research and portfolio management system built for [OpenClaw](https://openclaw.ai/). It discovers high-potential tokens, analyzes them, proposes BUY trades (requiring human approval), and auto-executes SELL trades (stop-loss, take-profit, rug warnings) without approval — all through a Safe multisig wallet.

## Architecture

Three agents communicate through a shared SQLite database:

- **Research Agent** (`agents/research/`) — Runs on Sonnet, 30-minute heartbeat. Handles discovery, analysis, risk assessment, and trade proposals. Has 4 skills: discovery, analyst, risk, portfolio.
- **Sentinel Agent** (`agents/sentinel/`) — Runs on DeepSeek via Ollama Cloud, 5-minute heartbeat. Monitors positions, detects stop-loss/take-profit/rug conditions, writes sell orders. Has 1 skill: sentinel.
- **Executor Agent** (`agents/executor/`) — Runs on DeepSeek via Ollama Cloud, 1-minute heartbeat. Reads approved trades and sell orders, validates, builds Safe wallet transactions, signs, and submits. Has 1 skill: executor.
- **Ollama Cloud** — Sentinel and Executor use DeepSeek V3.1 via Ollama Cloud's API (`https://ollama.com/api/chat`). No sidecar needed — OpenClaw's built-in Ollama provider sends `OLLAMA_API_KEY` as a Bearer token directly.

## Memory System — Two Layers

CryptoClaw separates memory into two distinct layers:

### Layer 1: Agent Memory (Markdown — shared knowledge)
Patterns, lessons, scoring calibration — knowledge that applies across all fund deployments. Lives in markdown files, backed by a **private git repo** (separate from the code repo).

- `workspace/MEMORY.md` — Curated long-term patterns (updated when pattern seen 3+ times)
- `workspace/memory/YYYY-MM-DD.md` — Daily logs with timestamped entries
- Backed up every 15 minutes via `memory-backup.sh` cron

### Layer 2: Wallet Data (SQLite — per-fund)
Positions, trades, orders, alerts, receipts — everything tied to a specific Safe wallet. One database per fund, identified by `SAFE_ID`.

- Database path: `data/<SAFE_ID>.db`
- Access via CLI: `node scripts/db-query.js <command> [--flags]`
- Schema managed by auto-migrations in `scripts/db.js`
- 16 tables: positions, trades, approved_trades, sell_orders, trade_receipts, sentinel_alerts, watchlist, liquidity_snapshots, tracked_wallets, heartbeat_state, sentinel_log, executor_log, portfolio_meta, paper_trades, paper_positions, _migrations

### Why Two Layers?
The project can be deployed multiple times managing different Safe wallets/funds. Agent memory (patterns, lessons) is universal knowledge shared across all deployments. Wallet data (positions, cash, orders) is specific to one fund and must be isolated.

## Data Flow

```
Research → approved_trades table  → Executor → Safe wallet → positions table
Sentinel → sell_orders table      → Executor → Safe wallet → positions table
Executor → trade_receipts table   → Research (learning), Sentinel (awareness)
```

In **paper mode** (`PAPER_MODE=true`), the flow is identical but uses simulated tables:
```
Research → approved_trades (auto-approved) → Executor → paper_trades + paper_positions
Sentinel → sell_orders                     → Executor → paper_trades + paper_positions
```

All agent-to-agent communication goes through the database via `db-query.js`.

## Project Structure

```
agents/research/          # Research Agent config (AGENTS.md, SOUL.md, HEARTBEAT.md, skills/)
agents/sentinel/          # Sentinel Agent config (same structure, fewer skills)
agents/executor/          # Executor Agent config (same structure, 1 skill)
workspace/                # Shared workspace (copied to all agents by setup.sh)
  MEMORY.md               # Curated long-term patterns and lessons (agent memory)
  memory/                 # Daily log directory (agent memory)
  USER.md                 # Operator profile (editable)
  IDENTITY.md             # Agent identity
  TOOLS.md                # Script + db-query.js usage guide
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
  check-wallets.js        # Wallet activity tracking
  market-overview.js      # BTC dominance, fear/greed
  portfolio-summary.js    # Allocation + P&L
  narrative-check.js      # Narrative momentum
  holder-distribution.js  # Top holder analysis
  memory-backup.sh        # Git auto-commit for agent memory
tests/                    # 6 test suites + runner + helpers
Dockerfile                # Based on ghcr.io/openclaw/openclaw:latest
docker-compose.yml        # One-command deployment
build-templates.sh        # Docker build-time template assembly (replaces setup.sh in Docker)
setup.sh                  # Bare-metal installer (deploys agents into OpenClaw directory structure)
.env.example              # Environment variable template
```

## Key Files to Know

| File | What It Does |
|------|-------------|
| `agents/research/AGENTS.md` | Core operating contract — pipeline, safety rules, memory protocol, approval logic |
| `agents/sentinel/AGENTS.md` | Monitoring rules, sell order logic, alert format |
| `agents/executor/AGENTS.md` | Transaction rules, validation logic, receipt format, Safe integration |
| `scripts/db.js` | SQLite schema, migrations, connection management |
| `scripts/db-query.js` | 30+ CLI commands for agents to interact with wallet data |
| `workspace/TOOLS.md` | CLI usage for every script + db-query.js — check this before modifying |
| `setup.sh` | Understand this to know how files get deployed to OpenClaw |

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
node tests/test-scripts.js      # Script output format (needs network)

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

# Manual setup (without Docker)
SAFE_ID=my-fund ./setup.sh                      # Deploy agents to OpenClaw
SAFE_ID=my-fund ./setup.sh --memory-backup       # Also install memory backup cron
```

## Tech Stack

- **Runtime:** Node.js 22+ (ESM modules, `"type": "module"`)
- **Database:** SQLite via better-sqlite3 (WAL mode, auto-migration)
- **Dependencies:** better-sqlite3, dotenv
- **APIs used by scripts:** DEXScreener (free), GoPlus Security (free tier), CoinGecko (free), Etherscan (free tier), Birdeye (optional), Solscan (optional)
- **Execution:** Safe wallet SDK for transaction building/signing, DEX aggregators (1inch, 0x, Jupiter) for swaps
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
- **OLLAMA_API_KEY** env var authenticates with Ollama Cloud for DeepSeek model access (Sentinel/Executor).

## Safety Rules (Do Not Weaken)

These limits are intentionally strict and must not be relaxed:

- Max moonshot position: 5% of portfolio
- Max conviction position: 10%
- Max total moonshot allocation: 20%
- Min cash reserve: 10%
- Max same-narrative positions: 3
- Auto-reject: honeypot, top holder >30%, liquidity <$5k, known scam deployers, pausable contracts
- Slippage limits: 5% moonshot, 2% conviction/base
- Stale order protection: reject if price drifted >10% from proposal

## Paper Mode

Paper mode (`PAPER_MODE=true`) runs the full system autonomously without touching real funds. Useful for backtesting strategy, validating agent behavior, and building confidence before deploying capital.

### How It Works
- **Research Agent:** BUY proposals that pass all safety checks are auto-approved (`approved_by: 'paper_mode'`). No human in the loop.
- **Sentinel Agent:** Monitors `paper_positions` instead of `positions`. All monitoring logic (price checks, liquidity, wallets) runs identically.
- **Executor Agent:** Validates orders normally but skips Safe wallet transactions. Records results in `paper_trades` and `paper_positions` tables. Updates `paper_cash` instead of `cash`.
- **Safety rules are fully enforced** — paper mode tests the strategy, not a weakened version of it.

### Environment Variables
- `PAPER_MODE=true|false` (default: `false`)
- `PAPER_STARTING_BALANCE=10000` (default: `10000`, simulated USD)

### Paper-Specific Tables
- `paper_trades` — what would have been executed (buy/sell records with P&L)
- `paper_positions` — simulated portfolio positions

### Paper-Specific Commands
- `get-paper-portfolio`, `get-paper-positions`, `get-paper-trades`, `get-paper-stats`
- `add-paper-position`, `update-paper-position`, `close-paper-position`, `add-paper-trade`
- `get-paper-cash`, `set-paper-cash`

## When Modifying

- **Adding a new script:** Add it to `scripts/`, document it in `workspace/TOOLS.md`, add output validation to `tests/test-scripts.js`, add it to the appropriate agent's copy list in `setup.sh`, and add it to the agent's shell allowlist in `entrypoint.sh` (see per-agent `agents.list[N]` overrides).
- **Adding a new DB table:** Add a migration in `scripts/db.js` (increment migration number), add CLI commands in `db-query.js`, add schema tests to `tests/test-memory.js`, document commands in `workspace/TOOLS.md`.
- **Changing safety rules:** Update `agents/research/AGENTS.md` AND `agents/executor/AGENTS.md` (if execution-related) AND `tests/test-safety.js` AND `tests/test-executor.js` — tests enforce the exact limits.
- **Adding a fourth agent:** Follow the pattern in `agents/executor/` — create a directory with AGENTS.md, SOUL.md, HEARTBEAT.md, and skills/. Add per-agent config overrides on `agents.list[N]` in `entrypoint.sh` (tools, permissions, memory, compaction — follow least privilege). Add directory creation, file copy, and symlink logic to `setup.sh` and `build-templates.sh`. Add heartbeat_state seeds in the db.js migration. Update `docker-compose.yml` if it needs different resources.
- **Changing agent tool/permission config:** OpenClaw global config applies to all agents — per-agent tool restriction is enforced by **script deployment** (which .js files each agent gets in its workspace) and **skills directories** (each agent only sees its own skills). Edit `entrypoint.sh` for global settings, `build-templates.sh`/`setup.sh` for per-agent script deployment.
- **Modifying the pipeline:** Update `tests/test-pipeline.js` to verify the new data flow between stages.
- **Changing Safe wallet config:** Update `.env.example`, `docker-compose.yml`, and `agents/executor/AGENTS.md`. Never put keys in files.
- **Multi-fund deployment:** Set different `SAFE_ID` values. Each gets its own SQLite database. Agent memory (markdown) is shared across all deployments.

## Common Pitfalls

- Scripts use ESM (`import`), not CommonJS (`require`). The package.json has `"type": "module"`.
- Sentinel only gets monitoring scripts (check-positions, check-liquidity, check-wallets) + db access. Executor only gets db access + execution scripts. Don't assume an agent has access to all scripts.
- Agent memory (markdown) is symlinked between all three agents. Daily logs written by any agent are visible to all.
- The database is also shared via symlinked `data/` directory — all agents read/write the same SQLite file.
- The `setup.sh` script skips existing MEMORY.md to preserve learned patterns. If you need to reset, delete it first.
- Docker runs as non-root (UID 1000). File permissions matter.
- The Executor's `SAFE_SIGNER_KEY` must NEVER appear in any log, receipt, or file. Only read from env var.
- Executor validates orders independently (defense in depth) — don't assume Research's validation is sufficient.
- SQLite uses WAL mode for concurrent reads. Agents can query simultaneously without locking issues.
