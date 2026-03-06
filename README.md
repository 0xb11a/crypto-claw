# CryptoClaw

**Three-agent crypto research & portfolio management system for [OpenClaw](https://openclaw.ai/).**

CryptoClaw is a scalable, three-agent workspace that turns OpenClaw into an autonomous crypto trading assistant. One agent thinks. One agent watches. One agent executes. Agent knowledge is shared across deployments; wallet data is isolated per fund.

## Architecture

```
                          YOU
                     (approve buys)
                          |
          +---------------+---------------+
          v               |               v
   +--------------+       |       +---------------+
   |   RESEARCH   |       |       |   SENTINEL    |
   |    AGENT     |       |       |    AGENT      |
   |              |    SQLite     |               |
   | * Discovery  |   Database    | * Price watch |
   | * Analysis   |   (shared)    | * LP monitor  |
   | * Risk       |       |       | * Wallet track|
   | * Portfolio  |       |       | * Auto-sells  |
   |              |       |       |               |
   | Sonnet (30m) |       |       | Haiku (5m)    |
   +------+-------+       |       +-------+-------+
          |               |               |
          v               v               v
   approved_trades table  |    sell_orders table
          |               |               |
          +---------------+---------------+
                          v
                   +--------------+
                   |   EXECUTOR   |
                   |    AGENT     |
                   |              |
                   | * Validate   |
                   | * Build tx   |
                   | * Sign       |
                   | * Submit     |
                   |              |
                   | Haiku (1m)   |
                   +------+-------+
                          |
                          v
                   Safe Wallet
              (policies & co-signers)
```

## Key Design Decisions

**Three agents, clear separation.** Research thinks deeply (Sonnet, 30m). Sentinel reacts fast (Haiku, 5m). Executor handles wallet operations (Haiku, 1m).

**Two-layer memory.** Agent knowledge (patterns, lessons, scoring calibration) lives in markdown files backed by a private git repo — shared across all fund deployments. Wallet data (positions, trades, orders, alerts) lives in SQLite — one database per fund, identified by `SAFE_ID`.

**Buys need approval, sells don't.** When Research proposes a buy, you get a message and must approve. When Sentinel detects danger, it writes a sell order immediately. The Executor picks it up and executes within 1 minute.

**Safe wallet for execution.** The Executor agent signs transactions via a Safe (multisig) wallet. Safe's policies decide how many signatures are needed — the agent can be one signer without being the sole authority.

**Database as message bus.** All agent-to-agent communication goes through SQLite tables via `db-query.js`. No JSON files, no direct file passing.

## Pipeline

```
Discovery -> Analysis -> Risk -> Trade Proposal -> YOU APPROVE -> approved_trades table
                                                                        |
                                                                 Executor signs
                                                                 via Safe wallet
                                                                        |
                                                              positions table updated
                                                                        |
                                                           Sentinel monitors 24/7
                                                                        |
                                                  stop-loss / take-profit / rug warning
                                                                        |
                                                           sell_orders table (no approval)
                                                                        |
                                                           Executor auto-executes via Safe
```

---

## Deployment Guide

### Prerequisites

- Docker and Docker Compose (for Docker path) or OpenClaw installed locally (for manual path)
- Node.js 22+ (manual path only)
- Anthropic API key
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

# Required
ANTHROPIC_API_KEY=sk-ant-...

# Safe wallet
SAFE_ADDRESS_ETH=0x...         # Your Safe address on Ethereum
SAFE_ADDRESS_BASE=0x...        # Your Safe address on Base
SAFE_SIGNER_KEY=0x...          # Private key for one Safe signer (NEVER commit this)

# RPC endpoints
RPC_ETH=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Data APIs (optional but recommended)
GOPLUS_API_KEY=                # Contract safety checks
ETHERSCAN_API_KEY=             # Wallet tracking
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
3. SQLite database created and migrated (`data/<SAFE_ID>.db` — 14 tables)
4. OpenClaw gateway starts, all three agents begin their heartbeat cycles

#### Option B: Manual (No Docker)

```bash
chmod +x setup.sh
SAFE_ID=fund-alpha ./setup.sh

# Install script deps
cd ~/.openclaw/agents/research/scripts && npm install

# Copy API keys
cp .env ~/.openclaw/agents/research/scripts/.env
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
# Manual path
cd ~/.openclaw/agents/research/workspace
git remote add origin git@github.com:your-org/crypto-claw-memory.git
SAFE_ID=fund-alpha ./setup.sh --memory-backup
# Installs cron: commits + pushes every 15 minutes
```

For Docker, the agent memory lives in the `crypto-claw-memory` named volume. You can either mount a host directory instead (see docker-compose.yml comments) or back up the volume externally.

### Step 5: Verify

```bash
# Run tests (offline — no API calls)
cd tests && node run-all.js --offline

# Check OpenClaw sees all agents
openclaw doctor --fix

# Security audit
openclaw security audit --deep
```

---

## Updating & Redeployment

When you pull new code (updated agent rules, new scripts, schema changes), here's how to redeploy.

### Docker Redeploy

```bash
git pull
docker compose up -d --build
```

What happens on restart:

1. Image rebuilds with the new code
2. `entrypoint.sh` runs and syncs **code-owned** workspace files (TOOLS.md, BOOT.md, IDENTITY.md) from baked-in templates into the persistent volume
3. **User/agent-owned** files are preserved: USER.md (your profile), MEMORY.md (learned patterns), daily logs — the entrypoint never overwrites these
4. DB migrations run automatically — if a new migration was added (e.g., `002_add_column`), it applies atomically via a transaction; if it fails, the container stops instead of running with a broken schema
5. Agent configs (AGENTS.md, SOUL.md, HEARTBEAT.md, skills) are always fresh from the image — they live outside the volume

**What updates on redeploy:** agent rules, skills, scripts, TOOLS.md, BOOT.md, IDENTITY.md, DB schema.

**What persists across redeploys:** USER.md, MEMORY.md, daily logs, all wallet data (positions, trades, orders, receipts).

### Manual Redeploy

```bash
git pull
SAFE_ID=fund-alpha ./setup.sh
```

Same behavior: code-owned files update, USER.md and MEMORY.md are preserved (skip-if-exists guards), DB migrations run on next agent query.

### Schema Migrations

Migrations are defined in `scripts/db.js` and managed automatically. Each migration:

- Has a unique name (e.g., `001_initial`, `002_add_narrative_field`)
- Is wrapped in a SQLite transaction — all-or-nothing, auto-rollback on failure
- Is tracked in the `_migrations` table — never runs twice
- Runs at container startup (Docker) or on first DB query (manual)

To add a new migration, append to the `migrations` array in `db.js`:

```javascript
{
  name: '002_add_narrative_field',
  sql: `ALTER TABLE positions ADD COLUMN narrative_score INTEGER;`
}
```

On next deploy, `entrypoint.sh` calls `node scripts/db-query.js migrate`, detects the new migration, and applies it.

### File Ownership Model

Understanding which files update and which persist:

| File | Owner | On Redeploy |
|------|-------|-------------|
| `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md` | Code | Always updated |
| `openclaw.json` | Code | Always updated |
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
  node scripts/db-query.js get-heartbeat       # When agents last ran

# Manual
SAFE_ID=fund-alpha node scripts/db-query.js get-portfolio
SAFE_ID=fund-alpha node scripts/db-query.js get-heartbeat
```

### Common Queries

```bash
# Open positions
node scripts/db-query.js get-positions --status open

# Pending trades waiting for your approval
node scripts/db-query.js get-approved-trades --pending

# Pending sell orders
node scripts/db-query.js get-sell-orders

# Recent execution receipts
node scripts/db-query.js get-receipts --limit 10

# Trade performance stats
node scripts/db-query.js get-trade-stats

# Unprocessed sentinel alerts
node scripts/db-query.js get-alerts --unprocessed

# Check migration status
node scripts/db-query.js migrate
```

### Depositing Funds

After depositing ETH/USDC to your Safe wallet, update the cash balance:

```bash
node scripts/db-query.js set-cash --amount 10000
node scripts/db-query.js set-meta --key total_deposited --value 10000
```

### Backing Up Wallet Data

The SQLite database is the most critical data. Back it up independently of agent memory.

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
docker compose up -d         # Restart (entrypoint re-syncs files + runs migrations)

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

Or with manual setup:

```bash
SAFE_ID=fund-alpha ./setup.sh
SAFE_ID=fund-beta ./setup.sh
```

Each fund creates `data/fund-alpha.db` and `data/fund-beta.db`. What the agent learns from Fund A's trades (stored in MEMORY.md) benefits Fund B's decisions.

---

## Memory System

### Layer 1: Agent Memory (Markdown)

Agent knowledge that applies across all fund deployments. Backed by a **private git repo**, separate from the code repo.

| File | Purpose |
|------|---------|
| `MEMORY.md` | Curated patterns, lessons, scoring calibration (updated when pattern seen 3+ times) |
| `memory/YYYY-MM-DD.md` | Daily logs with timestamped, categorized entries |

### Layer 2: Wallet Data (SQLite)

Per-fund data in `data/<SAFE_ID>.db`. Accessed via `node scripts/db-query.js`.

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
| `tracked_wallets` | Research | Research, Sentinel | Smart money addresses |
| `heartbeat_state` | All | All | Last-run timestamps per agent |
| `sentinel_log` | Sentinel | All | Monitoring check history |
| `executor_log` | Executor | Executor | Processing history |
| `portfolio_meta` | All | All | Cash balance, safe_id, totals |

---

## Project Structure

```
crypto-claw/
+-- agents/
|   +-- research/                    # RESEARCH AGENT
|   |   +-- AGENTS.md                # Operating rules + buy approval logic
|   |   +-- SOUL.md                  # Research persona
|   |   +-- HEARTBEAT.md             # 30min rotating checks
|   |   +-- openclaw.json            # Sonnet model, 30m heartbeat
|   |   +-- skills/
|   |       +-- discovery/SKILL.md   # Token scanning
|   |       +-- analyst/SKILL.md     # Scoring framework
|   |       +-- risk/SKILL.md        # Safety checks
|   |       +-- portfolio/SKILL.md   # Position management
|   |
|   +-- sentinel/                    # SENTINEL AGENT
|   |   +-- AGENTS.md                # Monitoring rules + sell order logic
|   |   +-- SOUL.md                  # Minimal persona
|   |   +-- HEARTBEAT.md             # 5min ALL checks
|   |   +-- openclaw.json            # Haiku model, 5m heartbeat
|   |   +-- skills/
|   |       +-- sentinel/SKILL.md    # Position monitoring
|   |
|   +-- executor/                    # EXECUTOR AGENT
|       +-- AGENTS.md                # Transaction rules + validation logic
|       +-- SOUL.md                  # Mechanical persona
|       +-- HEARTBEAT.md             # 1min order processing
|       +-- openclaw.json            # Haiku model, 1m heartbeat
|       +-- skills/
|           +-- executor/SKILL.md    # Safe wallet tx building
|
+-- workspace/                       # SHARED (copied to all agents)
|   +-- USER.md                      # Your profile (preserved on redeploy)
|   +-- IDENTITY.md                  # Agent identity
|   +-- TOOLS.md                     # Script + db-query.js usage guide
|   +-- BOOT.md                      # First-run setup
|   +-- MEMORY.md                    # Curated long-term memory (preserved on redeploy)
|   +-- memory/                      # Daily logs (preserved on redeploy)
|
+-- scripts/                         # NODE.JS SCRIPTS
|   +-- db.js                        # SQLite schema + transaction-wrapped migrations
|   +-- db-query.js                  # CLI interface for wallet data (30+ commands)
|   +-- package.json                 # Dependencies (better-sqlite3, dotenv)
|   +-- scan-tokens.js               # DEXScreener trending/new
|   +-- token-metrics.js             # Detailed token data
|   +-- check-contract.js            # GoPlus safety scan
|   +-- check-positions.js           # Current prices vs stops/TPs
|   +-- check-liquidity.js           # LP change detection
|   +-- check-wallets.js             # Wallet activity tracking
|   +-- market-overview.js           # BTC dominance, fear/greed
|   +-- portfolio-summary.js         # Allocation + P&L
|   +-- narrative-check.js           # Narrative momentum
|   +-- holder-distribution.js       # Top holder analysis
|   +-- memory-backup.sh             # Git auto-commit for agent memory
|
+-- tests/                           # TEST SUITES
|   +-- run-all.js                   # Test runner
|   +-- test-helpers.js              # Minimal test framework
|   +-- test-memory.js               # Agent memory + SQLite schema + CRUD
|   +-- test-safety.js               # Safety rule logic tests
|   +-- test-pipeline.js             # Pipeline integration tests
|   +-- test-executor.js             # Executor validation + receipt tests
|   +-- test-scripts.js              # Script output validation
|
+-- entrypoint.sh                    # Docker runtime init (file sync + migrations)
+-- Dockerfile                       # Image build
+-- docker-compose.yml               # One-command deployment
+-- setup.sh                         # Manual install script
+-- .env.example                     # Environment variable template
+-- CLAUDE.md                        # Claude Code project guide
+-- README.md
```

## Safety Rules (Hard-Coded)

| Rule | Limit | Enforced By |
|------|-------|------------|
| Max moonshot position | 5% | Research + Executor |
| Max conviction position | 10% | Research + Executor |
| Max moonshot allocation | 20% | Research |
| Min cash reserve | 10% | Research |
| Max same-narrative positions | 3 | Research |
| Auto-reject: honeypot | Always | Research |
| Auto-reject: top holder >30% | Always | Research |
| Auto-reject: liquidity <$5k | Always | Research |
| Stop-loss auto-sell | Immediate | Sentinel -> Executor |
| Take-profit auto-sell | Immediate | Sentinel -> Executor |
| Rug warning auto-sell | Immediate | Sentinel -> Executor |
| Slippage limit (moonshot) | 5% | Executor |
| Slippage limit (conviction/base) | 2% | Executor |
| Stale order protection | 10% price drift | Executor |

## Tests

```bash
# Run all tests (offline — no API calls needed)
cd tests && node run-all.js --offline

# Run all tests including API-dependent script tests
cd tests && node run-all.js

# Run individual suites
node tests/test-memory.js      # Agent memory + SQLite schema + CRUD ops
node tests/test-safety.js      # Safety rule logic
node tests/test-pipeline.js    # Pipeline integration + executor handoff
node tests/test-executor.js    # Executor validation, slippage, receipts
node tests/test-scripts.js     # Script outputs (needs network)
```

## Cost Optimization

- Sentinel runs on **Haiku** (~$0.001/heartbeat with small context)
- Executor runs on **Haiku** (~$0.001/heartbeat, even smaller context)
- Research heartbeats also use **Haiku** for cheap checks
- Research only escalates to **Sonnet** for deep analysis (on-demand)
- Scripts handle ALL API calls — LLM never fetches data directly
- Sentinel context stays under 2k tokens when portfolio is healthy
- Executor context stays under 1k tokens when no orders pending

## Scaling

The three-agent split is designed to scale:
- Add a fourth agent for **social monitoring** (Twitter/Telegram sentiment)
- Add a fifth for **cross-chain arbitrage** detection
- Each agent gets its own heartbeat interval, model, and cost profile
- All share state through the same database
- Deploy multiple funds with different `SAFE_ID` values

## License

MIT

## Disclaimer

CryptoClaw is experimental software. Cryptocurrency trading involves substantial risk. This is not financial advice. Always do your own research. Never invest more than you can afford to lose.
