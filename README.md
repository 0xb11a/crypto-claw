# CryptoClaw

**Three-agent crypto research & portfolio management system for [OpenClaw](https://openclaw.ai/).**

CryptoClaw turns OpenClaw into an autonomous crypto trading assistant. One agent thinks. One agent watches. One agent executes. Agent knowledge is shared across deployments; wallet data is isolated per fund.

## Architecture

```
                            YOU
                       (approve buys)
                             |
          +------------------+---------------+
          v                  |               v
   +-----------------+       |       +-----------------+
   |   RESEARCH      |       |       |    SENTINEL     |
   |    AGENT        |       |       |      AGENT      |
   |                 |    SQLite     |                 |
   | * Discovery     |   Database    | * Price watch   |
   | * Analysis      |   (shared)    | * LP monitor    |
   | * Risk          |       |       | * Wallet track  |
   | * Portfolio     |       |       | * Auto-sells    |
   |                 |       |       |                 |
   | Claude Haiku    |       |       | GPT-5.4-mini    |
   |  + Sonnet       |       |       |   (10m)         |
   |  sub-agents     |       |       |                 |
   |   (30m)         |       |       |                 |
   +------+----------+       |       +-------+---------+
          |                  |               |
          v                  v               v
   approved_trades table     |      sell_orders table
          |                  |               |
          +------------------+---------------+
                             v
                   +----------------+
                   |   EXECUTOR     |
                   |    AGENT       |
                   |                |
                   | * Validate     |
                   | * Build tx     |
                   | * Sign         |
                   | * Submit       |
                   |                |
                   | GPT-5.4-mini   |
                   |    (1m)        |
                   +------+---------+
                          |
                          v
                   Safe Wallet
              (policies & co-signers)
```

## Key Design Decisions

**Three agents, clear separation.** Research thinks deeply (Claude Haiku 4.5, spawns Sonnet sub-agents for analysis/risk, 30m heartbeat). Sentinel reacts fast (GPT-5.4-mini, 10m). Executor handles wallet operations (GPT-5.4-mini, 1m).

**Cost-optimized model routing.** Research runs on Claude Haiku 4.5 by default; Sentinel and Executor run on GPT-5.4-mini. Research escalates to Claude Sonnet for the two expensive skills — deep token analysis and risk assessment — by spawning sub-agents via `sessions_spawn`. Discovery, market checks, and portfolio work stay on Haiku.

**Token deduplication.** Before spawning expensive Sonnet sub-agents, Research checks `check-token-status` against the database: open positions, pending orders, watchlist entries, and recently cached analysis results are all skipped. This prevents redundant analysis of the same trending tokens across heartbeats.

**Market regime awareness.** The system classifies market conditions (bullish, neutral, bearish, crisis) and automatically tightens position limits, raises cash reserves, and adjusts risk thresholds. In crisis mode, no new moonshot positions are allowed.

**Two-layer memory.** Agent knowledge (patterns, lessons, scoring calibration) lives in markdown files backed by a private git repo — shared across all fund deployments. Wallet data (positions, trades, orders, alerts) lives in SQLite — one database per fund, identified by `SAFE_ID`.

**Buys need approval, sells don't.** When Research proposes a buy, you get a message and must approve. When Sentinel detects danger, it writes a sell order immediately. The Executor picks it up and executes within 1 minute.

**Smart money tracking.** Interesting wallets (top holders, deployers) are proposed for background scoring via Birdeye/Zerion APIs. Wallets scoring 55+ are auto-classified as whale/smart_money and monitored for activity.

**Safe wallet for execution.** The Executor agent signs transactions via a Safe (multisig) wallet. Safe's policies decide how many signatures are needed — the agent can be one signer without being the sole authority.

**Database as message bus.** All agent-to-agent communication goes through SQLite tables via `db-query.js`. No JSON files, no direct file passing.

## Pipeline

```
1. Discovery ── scan-tokens.js ──▶ filter ──▶ dedup (check-token-status)
2. Analysis ─── token-metrics.js, check-contract.js, holder-distribution.js
                → spawn Sonnet sub-agent → score 0-100 across 6 dimensions
                → avoid? cache result, skip (saves future sub-agent spawns)
3. Risk ─────── check-contract.js --deep → spawn Sonnet sub-agent
                → auto-reject on critical flags → market regime risk modifier
                → portfolio-level checks → reject? cache result, skip
4. Proposal ─── position sizing, stops, take-profit levels
                → human approval (real) or auto-approve (paper)
5. Execution ── Executor validates → Safe wallet tx → receipt → position update
```

---

## Deployment Guide

### Prerequisites

- Docker and Docker Compose (for Docker path) or OpenClaw installed locally (for manual path)
- Node.js 22+ (manual path only)
- Anthropic API key (Haiku for Research agent, Sonnet for sub-agents)
- OpenAI API key (GPT-5.4-mini for Sentinel/Executor agents)
- A deployed Safe wallet on your target chain(s) (Ethereum, Base, etc.)
- RPC endpoints for each chain (Alchemy, Infura, etc.)

### Step 1: Clone and Configure

```bash
git clone https://github.com/your-org/crypto-claw.git
cd crypto-claw

cp .env.example .env
```

Edit `.env` with your values:

```bash
# Fund identity — pick a name for this deployment
SAFE_ID=fund-alpha

# Required: LLM providers
ANTHROPIC_API_KEY=sk-ant-...         # Research agent (Haiku) + sub-agents (Sonnet)
OPENAI_API_KEY=sk-...                # Sentinel/Executor agents (GPT-5.4-mini)

# Safe wallet
SAFE_ADDRESS_ETH=0x...               # Your Safe address on Ethereum
SAFE_ADDRESS_BASE=0x...              # Your Safe address on Base
SAFE_SIGNER_KEY=0x...                # Private key for one Safe signer (NEVER commit this)

# RPC endpoints
RPC_ETH=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Data APIs (optional but recommended)
GOPLUS_API_KEY=                       # Contract safety checks
ETHERSCAN_API_KEY=                    # Wallet tracking
```

### Step 2: Deploy

#### Option A: Docker (Recommended)

```bash
docker compose up -d
docker compose logs -f    # watch startup
```

What happens on first start:

1. Image builds: installs OpenClaw, deploys three agents, installs npm dependencies
2. `entrypoint.sh` runs: seeds workspace files (USER.md, MEMORY.md, TOOLS.md, etc.)
3. SQLite database created and migrated (`data/<SAFE_ID>.db` — 17 tables)
4. Background loops start: memory backup (15m), wallet scoring (10m), sentinel (10m), executor (1m)
5. OpenClaw gateway starts, research agent begins 30m heartbeat cycle via cron

#### Option B: Manual (No Docker)

```bash
chmod +x setup.sh
SAFE_ID=fund-alpha ./setup.sh

# Optional: install memory backup + wallet scoring cron jobs
SAFE_ID=fund-alpha ./setup.sh --memory-backup --wallet-scorer
```

### Paper Mode (Simulated Trading)

Run the full system autonomously without touching real funds:

```bash
# Docker
PAPER_MODE=true docker compose up -d

# With custom starting balance
PAPER_MODE=true PAPER_STARTING_BALANCE=5000 docker compose up -d
```

In paper mode:
- BUY proposals that pass all safety checks are auto-approved (`approved_by: 'paper_mode'`)
- No human approval needed — fully autonomous
- All safety rules remain enforced
- Trades recorded in `paper_trades` and `paper_positions` tables
- Use `get-paper-portfolio`, `get-paper-stats`, etc. for paper-specific queries

### Model Configuration

```bash
# Default: Research on Claude Haiku, Sentinel/Executor on GPT-5.4-mini, deep analysis on Sonnet
RESEARCH_MODEL=anthropic/claude-haiku-4-5-20251001
SENTINEL_MODEL=openai/gpt-5.4-mini
EXECUTOR_MODEL=openai/gpt-5.4-mini
RESEARCH_SUBAGENT_MODEL=anthropic/claude-sonnet-4-6

# Full quality Research (higher cost)
RESEARCH_MODEL=anthropic/claude-sonnet-4-6 docker compose up -d
```

### Step 3: Configure Your Profile

Edit `USER.md` in the research agent's workspace:

```bash
# Docker: exec into the container
docker compose exec crypto-claw nano /home/openclaw/.openclaw/agents/research/workspace/USER.md

# Manual
nano ~/.openclaw/agents/research/workspace/USER.md
```

Fill in your timezone, experience level, risk tolerance, portfolio targets, and any wallet addresses you want tracked.

### Step 4: Set Up Agent Memory Backup

Agent memory (MEMORY.md + daily logs) should be backed up to a **private** git repo, separate from the code repo.

```bash
# Docker: set MEMORY_GIT_REMOTE in .env
MEMORY_GIT_REMOTE=https://<token>@github.com/your-org/crypto-claw-memory.git

# Manual path
cd ~/.openclaw/agents/research/workspace
git remote add origin git@github.com:your-org/crypto-claw-memory.git
SAFE_ID=fund-alpha ./setup.sh --memory-backup
# Installs cron: commits + pushes every 15 minutes
```

### Step 5: Verify

```bash
# Run tests (offline — no API calls)
cd tests && node run-all.js --offline

# Check all 7 suites pass (262+ tests)
```

---

## Updating & Redeployment

### Docker Redeploy

```bash
git pull
docker compose up -d --build
```

What happens on restart:

1. Image rebuilds with the new code
2. `entrypoint.sh` syncs **code-owned** workspace files (TOOLS.md, BOOT.md, IDENTITY.md, agent skills, scripts)
3. **User/agent-owned** files are preserved: USER.md, MEMORY.md, daily logs
4. DB migrations run automatically — new migrations apply atomically via transactions
5. Agent models synced from env vars (picks up model changes without wiping state)

**What updates on redeploy:** agent rules, skills, scripts, TOOLS.md, BOOT.md, IDENTITY.md, DB schema.

**What persists across redeploys:** USER.md, MEMORY.md, daily logs, all wallet data (positions, trades, orders, receipts).

### Manual Redeploy

```bash
git pull
SAFE_ID=fund-alpha ./setup.sh
```

### File Ownership Model

| File | Owner | On Redeploy |
|------|-------|-------------|
| `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md` | Code | Always updated |
| `skills/*/SKILL.md` | Code | Always updated |
| `scripts/*.js` | Code | Always updated |
| `TOOLS.md`, `IDENTITY.md`, `BOOT.md` | Code | Synced from templates |
| `USER.md` | User | Preserved (seed only on first deploy) |
| `MEMORY.md` | Agent | Preserved (seed only on first deploy) |
| `memory/*.md` (daily logs) | Agent | Preserved |
| `data/*.db` (SQLite) | Agent | Preserved + migrated |

---

## Operations

### Checking Status

```bash
# Docker
docker compose logs -f                        # Live logs
docker compose exec crypto-claw \
  node scripts/db-query.js get-portfolio       # Portfolio state
docker compose exec crypto-claw \
  node scripts/db-query.js get-heartbeat --agent research  # When agent last ran

# Manual
SAFE_ID=fund-alpha node scripts/db-query.js get-portfolio
SAFE_ID=fund-alpha node scripts/db-query.js get-heartbeat --agent research
```

### Common Queries

```bash
# Open positions
node scripts/db-query.js get-positions --status open

# Pending trades waiting for your approval
node scripts/db-query.js get-approved-trades --pending

# Pending sell orders
node scripts/db-query.js get-sell-orders --pending

# Recent execution receipts
node scripts/db-query.js get-receipts --limit 10

# Trade performance stats
node scripts/db-query.js get-trade-stats

# Unprocessed sentinel alerts
node scripts/db-query.js get-alerts --unprocessed

# Current market regime
node scripts/db-query.js get-meta --key market_regime

# Tracked wallets (smart money)
node scripts/db-query.js get-tracked-wallets --status scored

# Analysis cache (dedup)
node scripts/db-query.js get-analysis-cache

# Check migration status
node scripts/db-query.js migrate
```

### Paper Mode Queries

```bash
node scripts/db-query.js get-paper-portfolio       # Cash, P&L, positions
node scripts/db-query.js get-paper-positions        # Open paper positions
node scripts/db-query.js get-paper-stats            # Win rate, returns
node scripts/db-query.js get-paper-trades --limit 10
```

### Depositing Funds

After depositing ETH/USDC to your Safe wallet, update the cash balance:

```bash
node scripts/db-query.js set-cash --amount 10000
node scripts/db-query.js set-meta --key total_deposited --value 10000
```

### Backing Up Wallet Data

```bash
# Docker: copy DB from volume
docker compose exec crypto-claw \
  sqlite3 /home/openclaw/.openclaw/agents/research/data/fund-alpha.db ".backup /tmp/backup.db"
docker compose cp crypto-claw:/tmp/backup.db ./backups/fund-alpha-$(date +%Y%m%d).db

# Manual: direct file copy (safe while agents run — WAL mode)
cp ~/.openclaw/agents/research/data/fund-alpha.db ./backups/
```

### Stopping and Restarting

```bash
# Docker
docker compose down          # Stop (data preserved in volumes)
docker compose up -d         # Restart

# Reset everything (DESTROYS ALL DATA)
docker compose down -v       # -v removes named volumes
docker compose up -d --build # Fresh start
```

---

## Multi-Fund Deployment

CryptoClaw supports managing multiple Safe wallets from the same codebase. Each fund gets its own SQLite database; agent memory (patterns, lessons) is shared.

```bash
# Fund A
SAFE_ID=fund-alpha docker compose up -d

# Fund B — use a separate compose project name
SAFE_ID=fund-beta docker compose -p crypto-claw-beta up -d
```

---

## Memory System

### Layer 1: Agent Memory (Markdown)

Agent knowledge that applies across all fund deployments. Backed by a **private git repo**, separate from the code repo. Backed up every 15 minutes.

| File | Purpose |
|------|---------|
| `MEMORY.md` | Curated patterns, lessons, scoring calibration (updated when pattern seen 3+ times) |
| `memory/YYYY-MM-DD.md` | Daily logs with timestamped, categorized entries |

### Layer 2: Wallet Data (SQLite)

Per-fund data in `data/<SAFE_ID>.db`. 17 tables, auto-migrating schema. Accessed via `node scripts/db-query.js` (35+ commands).

| Table | Written By | Read By | Purpose |
|-------|-----------|---------|---------|
| `positions` | Executor | All | Current positions with stops and TPs |
| `approved_trades` | Research | Executor | Human-approved buy queue |
| `sell_orders` | Sentinel | Executor | Auto-sell queue |
| `trade_receipts` | Executor | All | Execution results with tx hashes |
| `sentinel_alerts` | Sentinel | Research | Monitoring alerts |
| `watchlist` | Research | Research | Tokens waiting for entry |
| `trades` | Research, Executor | Research | Trade history with stats |
| `liquidity_snapshots` | Sentinel | Sentinel | LP snapshots for comparison |
| `tracked_wallets` | Research | Research, Sentinel | Smart money addresses with scores |
| `analysis_cache` | Research | Research | Dedup cache for avoid/reject verdicts (24h TTL) |
| `heartbeat_state` | All | All | Last-run timestamps per agent |
| `sentinel_log` | Sentinel | All | Monitoring check history |
| `executor_log` | Executor | Executor | Processing history |
| `portfolio_meta` | All | All | Cash balance, safe_id, market regime |
| `paper_trades` | Executor | All | Simulated trade records (paper mode) |
| `paper_positions` | Executor | All | Simulated positions (paper mode) |

---

## Project Structure

```
crypto-claw/
+-- agents/
|   +-- research/                    # RESEARCH AGENT
|   |   +-- AGENTS.md                # Operating rules + buy approval logic
|   |   +-- SOUL.md                  # Research persona
|   |   +-- HEARTBEAT.md             # 30min rotating checks
|   |   +-- skills/
|   |       +-- discovery/SKILL.md   # Token scanning + dedup
|   |       +-- analyst/SKILL.md     # Scoring framework (Sonnet sub-agent)
|   |       +-- risk/SKILL.md        # Safety checks (Sonnet sub-agent)
|   |       +-- portfolio/SKILL.md   # Position management
|   |
|   +-- sentinel/                    # SENTINEL AGENT
|   |   +-- AGENTS.md                # Monitoring rules + sell order logic
|   |   +-- SOUL.md                  # Watchdog persona
|   |   +-- HEARTBEAT.md             # 10min all checks
|   |   +-- skills/
|   |       +-- sentinel/SKILL.md    # Position monitoring
|   |
|   +-- executor/                    # EXECUTOR AGENT
|       +-- AGENTS.md                # Transaction rules + validation logic
|       +-- SOUL.md                  # Mechanical persona
|       +-- HEARTBEAT.md             # 1min order processing
|       +-- skills/
|           +-- executor/SKILL.md    # Safe wallet tx building
|
+-- workspace/                       # SHARED (copied to all agents)
|   +-- USER.md                      # Your profile (preserved on redeploy)
|   +-- IDENTITY.md                  # Agent identity
|   +-- TOOLS.md                     # Script + db-query.js usage guide
|   +-- BOOT.md                      # First-run setup
|   +-- MEMORY.md                    # Curated long-term memory (preserved)
|   +-- memory/                      # Daily logs (preserved)
|
+-- scripts/                         # NODE.JS SCRIPTS
|   +-- db.js                        # SQLite schema + migrations (17 tables)
|   +-- db-query.js                  # CLI interface for wallet data (35+ commands)
|   +-- package.json                 # Dependencies (better-sqlite3, dotenv)
|   +-- scan-tokens.js               # DEXScreener trending/new/established
|   +-- token-metrics.js             # Detailed token data
|   +-- check-contract.js            # GoPlus safety scan
|   +-- check-positions.js           # Current prices vs stops/TPs
|   +-- check-liquidity.js           # LP change detection
|   +-- check-wallets.js             # Multi-chain wallet activity tracking
|   +-- score-wallet.js              # Smart money scoring via Birdeye/Zerion
|   +-- score-wallets-bg.js          # Background wallet scoring pipeline
|   +-- market-overview.js           # BTC dominance, fear/greed
|   +-- market-regime.js             # Market regime classification + adjustments
|   +-- heartbeat-check.js           # Pre-check for background loops
|   +-- portfolio-summary.js         # Allocation + P&L
|   +-- narrative-check.js           # Narrative momentum
|   +-- holder-distribution.js       # Top holder analysis
|   +-- memory-backup.sh             # Git auto-commit for agent memory
|
+-- tests/                           # 7 TEST SUITES
|   +-- run-all.js                   # Test runner
|   +-- test-helpers.js              # Minimal test framework
|   +-- test-memory.js               # Agent memory + SQLite schema + CRUD
|   +-- test-safety.js               # Safety rules + regime adjustments
|   +-- test-pipeline.js             # Pipeline integration + dedup logic
|   +-- test-executor.js             # Executor validation + receipts
|   +-- test-paper-mode.js           # Paper trading lifecycle + P&L
|   +-- test-regime.js               # Market regime classification + anti-whipsaw
|   +-- test-scripts.js              # Script output validation (needs network)
|
+-- entrypoint.sh                    # Docker runtime init + background loops
+-- Dockerfile                       # Image build
+-- docker-compose.yml               # One-command deployment
+-- build-templates.sh               # Docker build-time template assembly
+-- setup.sh                         # Bare-metal installer
+-- .env.example                     # Environment variable template
+-- CLAUDE.md                        # Claude Code project guide
```

## Safety Rules (Hard-Coded)

| Rule | Limit | Enforced By |
|------|-------|------------|
| Max moonshot position | 5% | Research + Executor |
| Max conviction position | 10% | Research + Executor |
| Max base position | 50% | Research + Executor |
| Max moonshot allocation | 20% | Research |
| Min cash reserve | 10% (25% bearish, 40% crisis) | Research |
| Max same-narrative positions | 3 | Research |
| Max open positions | 15 | Research |
| Auto-reject: honeypot | Always | Research |
| Auto-reject: top holder >30% | Always | Research |
| Auto-reject: liquidity <$5k | Always | Research |
| Auto-reject: pausable contract | Always | Research |
| Auto-reject: known scam deployer | Always | Research |
| Stop-loss auto-sell | Immediate | Sentinel -> Executor |
| Take-profit auto-sell | Immediate | Sentinel -> Executor |
| Rug warning auto-sell | Immediate | Sentinel -> Executor |
| Slippage limit (moonshot) | 5% | Executor |
| Slippage limit (conviction/base) | 2% | Executor |
| Stale order protection | 10% price drift | Executor |

### Market Regime Adjustments (Can Only Tighten)

| Parameter | Bullish/Neutral | Bearish | Crisis |
|-----------|----------------|---------|--------|
| Min cash reserve | 10% | 25% | 40% |
| Max moonshot position | 5% | 3% | 0% (no new) |
| Max conviction position | 10% | 7% | 5% |
| Base tier buying | Enabled | Paused | Paused |
| Min buy score | 50 | 65 | 80 |

Anti-whipsaw: regime only changes after 2 consecutive consistent readings.

## Tests

```bash
# Run all tests (offline — no API calls needed)
cd tests && node run-all.js --offline

# Run all tests including API-dependent script tests
cd tests && node run-all.js

# Run individual suites
node tests/test-memory.js      # Agent memory + SQLite schema + CRUD (56 tests)
node tests/test-safety.js      # Safety rules + regime limits (35 tests)
node tests/test-pipeline.js    # Pipeline + dedup logic (44 tests)
node tests/test-executor.js    # Validation, slippage, receipts (25 tests)
node tests/test-paper-mode.js  # Paper trading lifecycle (14 tests)
node tests/test-regime.js      # Regime classification + anti-whipsaw (47 tests)
node tests/test-scripts.js     # Script output format (needs network)
```

## Cost Optimization

- Research runs on **Claude Haiku 4.5**; Sentinel/Executor on **GPT-5.4-mini**
- Research escalates to **Sonnet** for deep analysis/risk (on-demand sub-agents)
- **Token dedup** prevents redundant Sonnet spawns on already-analyzed tokens
- **Background loops** with pre-checks skip agent invocation when nothing is pending
- Scripts handle ALL API calls — LLM never fetches data directly
- Sentinel/Executor context stays minimal when portfolio is healthy or no orders pending

## License

MIT

## Disclaimer

CryptoClaw is experimental software. Cryptocurrency trading involves substantial risk. This is not financial advice. Always do your own research. Never invest more than you can afford to lose.
