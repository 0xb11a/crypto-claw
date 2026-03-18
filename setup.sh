#!/bin/bash
# ============================================================
# CryptoClaw Setup Script (Bare-Metal)
#
# Deploys the three-agent system into OpenClaw's directory structure.
# For Docker deployments, use docker-compose.yml instead.
#
# OpenClaw expects per-agent:
#   workspace/           — AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md, etc.
#     skills/            — per-agent skills (only this agent sees them)
#     memory/            — daily logs
#   agent/               — state dir (auth, sessions — managed by OpenClaw)
#
# Agent memory (markdown) and wallet data (SQLite) are separate:
#   - Agent memory: markdown files in workspace/memory/, backed by private git repo
#   - Wallet data: SQLite database per fund in data/ directory
#
# Usage:
#   ./setup.sh                    # Standard setup
#   ./setup.sh --memory-backup    # Also install agent memory git auto-commit cron
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
MEMORY_BACKUP=false
WALLET_SCORER=false

for arg in "$@"; do
  case $arg in
    --memory-backup) MEMORY_BACKUP=true ;;
    --wallet-scorer) WALLET_SCORER=true ;;
  esac
done

SAFE_ID="${SAFE_ID:-default}"

echo "CryptoClaw Setup"
echo "===================="
echo "Source:       $SCRIPT_DIR"
echo "OpenClaw dir: $OPENCLAW_HOME"
echo "Safe ID:      $SAFE_ID"
echo ""

# ============================================================
# 1. Create agent directories
#    Each agent gets: workspace/ (with skills inside) + agent/ (state)
# ============================================================
echo "Creating agent directories..."

RESEARCH_DIR="$OPENCLAW_HOME/agents/research"
SENTINEL_DIR="$OPENCLAW_HOME/agents/sentinel"
EXECUTOR_DIR="$OPENCLAW_HOME/agents/executor"

# Research agent
mkdir -p "$RESEARCH_DIR/workspace/memory"
mkdir -p "$RESEARCH_DIR/workspace/skills/discovery"
mkdir -p "$RESEARCH_DIR/workspace/skills/analyst"
mkdir -p "$RESEARCH_DIR/workspace/skills/risk"
mkdir -p "$RESEARCH_DIR/workspace/skills/portfolio"
mkdir -p "$RESEARCH_DIR/agent"
mkdir -p "$RESEARCH_DIR/data"

# Sentinel agent
mkdir -p "$SENTINEL_DIR/workspace/memory"
mkdir -p "$SENTINEL_DIR/workspace/skills/sentinel"
mkdir -p "$SENTINEL_DIR/agent"

# Executor agent
mkdir -p "$EXECUTOR_DIR/workspace/memory"
mkdir -p "$EXECUTOR_DIR/workspace/skills/executor"
mkdir -p "$EXECUTOR_DIR/agent"

# ============================================================
# 2. Deploy Research Agent
# ============================================================
echo "Deploying Research Agent..."

# Workspace files (AGENTS.md, SOUL.md, HEARTBEAT.md go in workspace)
cp "$SCRIPT_DIR/agents/research/AGENTS.md"     "$RESEARCH_DIR/workspace/AGENTS.md"
cp "$SCRIPT_DIR/agents/research/SOUL.md"        "$RESEARCH_DIR/workspace/SOUL.md"
cp "$SCRIPT_DIR/agents/research/HEARTBEAT.md"   "$RESEARCH_DIR/workspace/HEARTBEAT.md"

# Per-agent skills (inside workspace/skills/)
cp "$SCRIPT_DIR/agents/research/skills/discovery/SKILL.md"  "$RESEARCH_DIR/workspace/skills/discovery/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/analyst/SKILL.md"    "$RESEARCH_DIR/workspace/skills/analyst/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/risk/SKILL.md"       "$RESEARCH_DIR/workspace/skills/risk/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/portfolio/SKILL.md"  "$RESEARCH_DIR/workspace/skills/portfolio/SKILL.md"

# Shared workspace files — code-owned (always update)
cp "$SCRIPT_DIR/workspace/IDENTITY.md"   "$RESEARCH_DIR/workspace/IDENTITY.md"
cp "$SCRIPT_DIR/workspace/TOOLS.md"      "$RESEARCH_DIR/workspace/TOOLS.md"
cp "$SCRIPT_DIR/workspace/BOOT.md"       "$RESEARCH_DIR/workspace/BOOT.md"

# User-owned (preserve customizations on redeploy)
if [ ! -f "$RESEARCH_DIR/workspace/USER.md" ]; then
  cp "$SCRIPT_DIR/workspace/USER.md" "$RESEARCH_DIR/workspace/USER.md"
else
  echo "  Skipping USER.md (already exists)"
fi

# ============================================================
# 3. Deploy Sentinel Agent
# ============================================================
echo "Deploying Sentinel Agent..."

cp "$SCRIPT_DIR/agents/sentinel/AGENTS.md"     "$SENTINEL_DIR/workspace/AGENTS.md"
cp "$SCRIPT_DIR/agents/sentinel/SOUL.md"        "$SENTINEL_DIR/workspace/SOUL.md"
cp "$SCRIPT_DIR/agents/sentinel/HEARTBEAT.md"   "$SENTINEL_DIR/workspace/HEARTBEAT.md"

# Per-agent skill
cp "$SCRIPT_DIR/agents/sentinel/skills/sentinel/SKILL.md" "$SENTINEL_DIR/workspace/skills/sentinel/SKILL.md"

# Shared workspace files — symlink to research copy
ln -sf "$RESEARCH_DIR/workspace/TOOLS.md"      "$SENTINEL_DIR/workspace/TOOLS.md"
ln -sf "$RESEARCH_DIR/workspace/IDENTITY.md"   "$SENTINEL_DIR/workspace/IDENTITY.md"

# ============================================================
# 4. Deploy Executor Agent
# ============================================================
echo "Deploying Executor Agent..."

cp "$SCRIPT_DIR/agents/executor/AGENTS.md"     "$EXECUTOR_DIR/workspace/AGENTS.md"
cp "$SCRIPT_DIR/agents/executor/SOUL.md"        "$EXECUTOR_DIR/workspace/SOUL.md"
cp "$SCRIPT_DIR/agents/executor/HEARTBEAT.md"   "$EXECUTOR_DIR/workspace/HEARTBEAT.md"

# Per-agent skill
cp "$SCRIPT_DIR/agents/executor/skills/executor/SKILL.md" "$EXECUTOR_DIR/workspace/skills/executor/SKILL.md"

# Shared workspace files — symlink to research copy
ln -sf "$RESEARCH_DIR/workspace/TOOLS.md"      "$EXECUTOR_DIR/workspace/TOOLS.md"
ln -sf "$RESEARCH_DIR/workspace/IDENTITY.md"   "$EXECUTOR_DIR/workspace/IDENTITY.md"

# ============================================================
# 5. Deploy agent memory (markdown — shared knowledge)
# ============================================================
echo "Setting up agent memory..."

# MEMORY.md goes to research agent (the thinker)
if [ ! -f "$RESEARCH_DIR/workspace/MEMORY.md" ]; then
  cp "$SCRIPT_DIR/workspace/MEMORY.md" "$RESEARCH_DIR/workspace/MEMORY.md"
else
  echo "  Skipping MEMORY.md (already exists)"
fi

# Sentinel and Executor get symlinks to research memory dir (for daily logs)
for dir in "$SENTINEL_DIR" "$EXECUTOR_DIR"; do
  target="$dir/workspace/memory"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$RESEARCH_DIR/workspace/memory" "$target"
  fi
done

# ============================================================
# 6. Deploy scripts (into workspace so agents can run them)
# ============================================================
echo "Deploying scripts..."

mkdir -p "$RESEARCH_DIR/workspace/scripts"
mkdir -p "$SENTINEL_DIR/workspace/scripts"
mkdir -p "$EXECUTOR_DIR/workspace/scripts"

# Research gets all scripts
cp "$SCRIPT_DIR/scripts/"*.js "$RESEARCH_DIR/workspace/scripts/"
cp "$SCRIPT_DIR/scripts/package.json" "$RESEARCH_DIR/workspace/scripts/"

# Sentinel gets monitoring scripts + db access
for script in db.js db-query.js check-positions.js check-liquidity.js check-wallets.js; do
  cp "$SCRIPT_DIR/scripts/$script" "$SENTINEL_DIR/workspace/scripts/"
done
cp "$SCRIPT_DIR/scripts/package.json" "$SENTINEL_DIR/workspace/scripts/"

# Executor gets execution scripts + db access + price checking
for script in db.js db-query.js token-metrics.js; do
  cp "$SCRIPT_DIR/scripts/$script" "$EXECUTOR_DIR/workspace/scripts/"
done
for script in execute-trade.js check-safe-status.js; do
  cp "$SCRIPT_DIR/scripts/$script" "$EXECUTOR_DIR/workspace/scripts/"
done
cp "$SCRIPT_DIR/scripts/package.json" "$EXECUTOR_DIR/workspace/scripts/"

# Install deps once, symlink to all agents
echo "Installing script dependencies..."
(cd "$RESEARCH_DIR/workspace/scripts" && npm install --production 2>/dev/null) || true
ln -sfn "$RESEARCH_DIR/workspace/scripts/node_modules" "$SENTINEL_DIR/workspace/scripts/node_modules"
ln -sfn "$RESEARCH_DIR/workspace/scripts/node_modules" "$EXECUTOR_DIR/workspace/scripts/node_modules"

# ============================================================
# 7. Initialize SQLite database (wallet-specific)
# ============================================================
echo "Initializing wallet database (Safe ID: $SAFE_ID)..."

DB_DIR="$RESEARCH_DIR/data"
mkdir -p "$DB_DIR"

# Symlink data dir for all agents (inside workspace for script access)
for dir in "$SENTINEL_DIR" "$EXECUTOR_DIR"; do
  if [ ! -L "$dir/data" ]; then
    ln -sf "$DB_DIR" "$dir/data"
  fi
  # Also symlink into workspace so agents can access via relative paths
  if [ ! -L "$dir/workspace/data" ]; then
    ln -sf "$DB_DIR" "$dir/workspace/data"
  fi
done
# Research also needs data accessible from workspace
if [ ! -L "$RESEARCH_DIR/workspace/data" ]; then
  ln -sf "$DB_DIR" "$RESEARCH_DIR/workspace/data"
fi

# Create the database with initial schema (auto-migrates on first query)
(cd "$RESEARCH_DIR/workspace" && SAFE_ID="$SAFE_ID" DB_PATH="$DB_DIR/$SAFE_ID.db" node scripts/db-query.js get-cash 2>/dev/null) || echo "  DB init will happen on first agent run (npm deps needed)"

# ============================================================
# 8. Init git in agent memory (for memory backup)
#    Each deployment uses its own branch: memory/<SAFE_ID>
# ============================================================
if command -v git &> /dev/null; then
  MEMORY_BRANCH="memory/${SAFE_ID}"
  if [ ! -d "$RESEARCH_DIR/workspace/.git" ]; then
    echo "Initializing git in agent memory workspace (branch: $MEMORY_BRANCH)..."
    cat > "$RESEARCH_DIR/workspace/.gitignore" << 'GITIGNORE'
*
!.gitignore
!MEMORY.md
!memory/
!memory/*.md
GITIGNORE
    (cd "$RESEARCH_DIR/workspace" \
      && git init \
      && git checkout -b "$MEMORY_BRANCH" \
      && git config user.name "CryptoClaw" \
      && git config user.email "cryptoClaw@openclaw.local" \
      && git add -A \
      && git commit -m "Initial CryptoClaw agent memory" 2>/dev/null) || true
  else
    # Existing repo — ensure identity is set (was missing before this fix)
    (cd "$RESEARCH_DIR/workspace" \
      && git config user.name "CryptoClaw" \
      && git config user.email "cryptoClaw@openclaw.local") 2>/dev/null || true
  fi
fi

# ============================================================
# 9. Install memory backup cron (optional)
# ============================================================
if [ "$MEMORY_BACKUP" = true ]; then
  echo "Installing agent memory auto-commit cron..."
  cp "$SCRIPT_DIR/scripts/memory-backup.sh" "$RESEARCH_DIR/workspace/scripts/memory-backup.sh"
  chmod +x "$RESEARCH_DIR/workspace/scripts/memory-backup.sh"

  CRON_CMD="*/15 * * * * $RESEARCH_DIR/workspace/scripts/memory-backup.sh $RESEARCH_DIR/workspace >> /tmp/crypto-claw-memory-backup.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "memory-backup.sh"; echo "$CRON_CMD") | crontab -
  echo "  Cron installed: agent memory backup every 15 minutes"
fi

# ============================================================
# 10. Install wallet scorer cron (optional)
# ============================================================
if [ "$WALLET_SCORER" = true ]; then
  echo "Installing wallet scoring background cron..."
  CRON_CMD="*/10 * * * * cd $RESEARCH_DIR/workspace && SAFE_ID=$SAFE_ID DB_PATH=$DB_DIR/$SAFE_ID.db node scripts/score-wallets-bg.js >> /tmp/crypto-claw-wallet-scorer.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "score-wallets-bg.js"; echo "$CRON_CMD") | crontab -
  echo "  Cron installed: wallet scoring every 10 minutes"
fi

# ============================================================
# Done
# ============================================================
echo ""
echo "CryptoClaw deployed! (3 agents: Research, Sentinel, Executor)"
echo ""
echo "Directory structure:"
echo "  Research workspace: $RESEARCH_DIR/workspace/"
echo "  Sentinel workspace: $SENTINEL_DIR/workspace/"
echo "  Executor workspace: $EXECUTOR_DIR/workspace/"
echo "  Wallet data:        $DB_DIR/$SAFE_ID.db"
echo ""
echo "Next steps:"
echo "  1. Edit $RESEARCH_DIR/workspace/USER.md with your profile"
echo "  2. Add API keys to .env (copy from .env.example)"
echo "  3. Set SAFE_ID, SAFE_ADDRESS_*, SAFE_SIGNER_KEY, RPC_* in .env"
echo "  4. Register agents: see entrypoint.sh or run manually"
echo ""
