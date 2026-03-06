#!/bin/bash
# ============================================================
# CryptoClaw Setup Script
#
# Deploys the three-agent system into OpenClaw's directory structure.
# Agent memory (markdown) and wallet data (SQLite) are separate:
#   - Agent memory: markdown files in workspace/memory/, backed by private git repo
#   - Wallet data: SQLite database per fund in data/ directory
#
# Usage:
#   ./setup.sh                    # Interactive setup
#   ./setup.sh --docker           # Non-interactive (Docker build)
#   ./setup.sh --memory-backup    # Also install agent memory git auto-commit cron
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
DOCKER_MODE=false
MEMORY_BACKUP=false

for arg in "$@"; do
  case $arg in
    --docker) DOCKER_MODE=true ;;
    --memory-backup) MEMORY_BACKUP=true ;;
  esac
done

SAFE_ID="${SAFE_ID:-default}"

echo "🦞 CryptoClaw Setup"
echo "===================="
echo "Source:       $SCRIPT_DIR"
echo "OpenClaw dir: $OPENCLAW_HOME"
echo "Safe ID:      $SAFE_ID"
echo ""

# ============================================================
# 1. Create agent directories
# ============================================================
echo "📁 Creating agent directories..."

RESEARCH_DIR="$OPENCLAW_HOME/agents/research"
SENTINEL_DIR="$OPENCLAW_HOME/agents/sentinel"
EXECUTOR_DIR="$OPENCLAW_HOME/agents/executor"

mkdir -p "$RESEARCH_DIR/workspace/memory"
mkdir -p "$RESEARCH_DIR/skills/discovery"
mkdir -p "$RESEARCH_DIR/skills/analyst"
mkdir -p "$RESEARCH_DIR/skills/risk"
mkdir -p "$RESEARCH_DIR/skills/portfolio"

mkdir -p "$SENTINEL_DIR/workspace/memory"
mkdir -p "$SENTINEL_DIR/skills/sentinel"

mkdir -p "$EXECUTOR_DIR/workspace/memory"
mkdir -p "$EXECUTOR_DIR/skills/executor"

# ============================================================
# 2. Deploy Research Agent
# ============================================================
echo "🔬 Deploying Research Agent..."

cp "$SCRIPT_DIR/agents/research/AGENTS.md"     "$RESEARCH_DIR/AGENTS.md"
cp "$SCRIPT_DIR/agents/research/SOUL.md"        "$RESEARCH_DIR/SOUL.md"
cp "$SCRIPT_DIR/agents/research/HEARTBEAT.md"   "$RESEARCH_DIR/HEARTBEAT.md"
cp "$SCRIPT_DIR/agents/research/openclaw.json"  "$RESEARCH_DIR/openclaw.json"

# Skills
cp "$SCRIPT_DIR/agents/research/skills/discovery/SKILL.md"  "$RESEARCH_DIR/skills/discovery/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/analyst/SKILL.md"     "$RESEARCH_DIR/skills/analyst/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/risk/SKILL.md"        "$RESEARCH_DIR/skills/risk/SKILL.md"
cp "$SCRIPT_DIR/agents/research/skills/portfolio/SKILL.md"   "$RESEARCH_DIR/skills/portfolio/SKILL.md"

# Shared workspace files — code-owned (always update)
cp "$SCRIPT_DIR/workspace/IDENTITY.md"   "$RESEARCH_DIR/workspace/IDENTITY.md"
cp "$SCRIPT_DIR/workspace/TOOLS.md"      "$RESEARCH_DIR/workspace/TOOLS.md"
cp "$SCRIPT_DIR/workspace/BOOT.md"       "$RESEARCH_DIR/workspace/BOOT.md"

# User-owned (preserve customizations on redeploy)
if [ ! -f "$RESEARCH_DIR/workspace/USER.md" ]; then
  cp "$SCRIPT_DIR/workspace/USER.md" "$RESEARCH_DIR/workspace/USER.md"
else
  echo "  ⏭  Skipping USER.md (already exists — preserving customizations)"
fi

# ============================================================
# 3. Deploy Sentinel Agent
# ============================================================
echo "🛡️  Deploying Sentinel Agent..."

cp "$SCRIPT_DIR/agents/sentinel/AGENTS.md"     "$SENTINEL_DIR/AGENTS.md"
cp "$SCRIPT_DIR/agents/sentinel/SOUL.md"        "$SENTINEL_DIR/SOUL.md"
cp "$SCRIPT_DIR/agents/sentinel/HEARTBEAT.md"   "$SENTINEL_DIR/HEARTBEAT.md"
cp "$SCRIPT_DIR/agents/sentinel/openclaw.json"  "$SENTINEL_DIR/openclaw.json"

# Skills
cp "$SCRIPT_DIR/agents/sentinel/skills/sentinel/SKILL.md" "$SENTINEL_DIR/skills/sentinel/SKILL.md"

# Shared workspace files
cp "$SCRIPT_DIR/workspace/TOOLS.md"      "$SENTINEL_DIR/workspace/TOOLS.md"
cp "$SCRIPT_DIR/workspace/IDENTITY.md"   "$SENTINEL_DIR/workspace/IDENTITY.md"

# ============================================================
# 4. Deploy Executor Agent
# ============================================================
echo "⚡ Deploying Executor Agent..."

cp "$SCRIPT_DIR/agents/executor/AGENTS.md"     "$EXECUTOR_DIR/AGENTS.md"
cp "$SCRIPT_DIR/agents/executor/SOUL.md"        "$EXECUTOR_DIR/SOUL.md"
cp "$SCRIPT_DIR/agents/executor/HEARTBEAT.md"   "$EXECUTOR_DIR/HEARTBEAT.md"
cp "$SCRIPT_DIR/agents/executor/openclaw.json"  "$EXECUTOR_DIR/openclaw.json"

# Skills
cp "$SCRIPT_DIR/agents/executor/skills/executor/SKILL.md" "$EXECUTOR_DIR/skills/executor/SKILL.md"

# Shared workspace files
cp "$SCRIPT_DIR/workspace/TOOLS.md"      "$EXECUTOR_DIR/workspace/TOOLS.md"
cp "$SCRIPT_DIR/workspace/IDENTITY.md"   "$EXECUTOR_DIR/workspace/IDENTITY.md"

# ============================================================
# 5. Deploy agent memory (markdown — shared knowledge)
# ============================================================
echo "🧠 Setting up agent memory..."

# MEMORY.md goes to research agent (the thinker)
if [ ! -f "$RESEARCH_DIR/workspace/MEMORY.md" ]; then
  cp "$SCRIPT_DIR/workspace/MEMORY.md" "$RESEARCH_DIR/workspace/MEMORY.md"
else
  echo "  ⏭  Skipping MEMORY.md (already exists — preserving learned patterns)"
fi

# Sentinel and Executor get symlinks to research memory dir (for daily logs)
if [ ! -L "$SENTINEL_DIR/workspace/memory" ] || [ -d "$SENTINEL_DIR/workspace/memory" ]; then
  rm -rf "$SENTINEL_DIR/workspace/memory"
  ln -sf "$RESEARCH_DIR/workspace/memory" "$SENTINEL_DIR/workspace/memory"
fi
if [ ! -L "$EXECUTOR_DIR/workspace/memory" ] || [ -d "$EXECUTOR_DIR/workspace/memory" ]; then
  rm -rf "$EXECUTOR_DIR/workspace/memory"
  ln -sf "$RESEARCH_DIR/workspace/memory" "$EXECUTOR_DIR/workspace/memory"
fi

# ============================================================
# 6. Deploy scripts
# ============================================================
echo "⚙️  Deploying scripts..."

mkdir -p "$RESEARCH_DIR/scripts"
mkdir -p "$SENTINEL_DIR/scripts"
mkdir -p "$EXECUTOR_DIR/scripts"

# Research gets all scripts
cp "$SCRIPT_DIR/scripts/"*.js "$RESEARCH_DIR/scripts/"
cp "$SCRIPT_DIR/scripts/package.json" "$RESEARCH_DIR/scripts/"

# Sentinel gets monitoring scripts + db access
for script in db.js db-query.js check-positions.js check-liquidity.js check-wallets.js; do
  cp "$SCRIPT_DIR/scripts/$script" "$SENTINEL_DIR/scripts/"
done
cp "$SCRIPT_DIR/scripts/package.json" "$SENTINEL_DIR/scripts/"

# Executor gets execution scripts + db access
for script in db.js db-query.js; do
  cp "$SCRIPT_DIR/scripts/$script" "$EXECUTOR_DIR/scripts/"
done
for script in execute-trade.js check-safe-status.js; do
  if [ -f "$SCRIPT_DIR/scripts/$script" ]; then
    cp "$SCRIPT_DIR/scripts/$script" "$EXECUTOR_DIR/scripts/"
  fi
done
cp "$SCRIPT_DIR/scripts/package.json" "$EXECUTOR_DIR/scripts/"

# Install deps if not in Docker
if [ "$DOCKER_MODE" = false ]; then
  echo "📦 Installing script dependencies..."
  (cd "$RESEARCH_DIR/scripts" && npm install --production 2>/dev/null) || true
  (cd "$SENTINEL_DIR/scripts" && npm install --production 2>/dev/null) || true
  (cd "$EXECUTOR_DIR/scripts" && npm install --production 2>/dev/null) || true
fi

# ============================================================
# 7. Initialize SQLite database (wallet-specific)
# ============================================================
echo "💾 Initializing wallet database (Safe ID: $SAFE_ID)..."

DB_DIR="$RESEARCH_DIR/data"
mkdir -p "$DB_DIR"

# Symlink data dir for all agents
if [ ! -L "$SENTINEL_DIR/data" ]; then
  ln -sf "$DB_DIR" "$SENTINEL_DIR/data"
fi
if [ ! -L "$EXECUTOR_DIR/data" ]; then
  ln -sf "$DB_DIR" "$EXECUTOR_DIR/data"
fi

# Create the database with initial schema (auto-migrates on first query)
if [ "$DOCKER_MODE" = false ]; then
  (cd "$RESEARCH_DIR" && SAFE_ID="$SAFE_ID" DB_PATH="$DB_DIR/$SAFE_ID.db" node scripts/db-query.js get-cash 2>/dev/null) || echo "  ⚠️  DB init will happen on first agent run (npm deps needed)"
fi

# ============================================================
# 8. Init git in agent memory (for memory backup)
# ============================================================
if command -v git &> /dev/null; then
  if [ ! -d "$RESEARCH_DIR/workspace/.git" ]; then
    echo "📚 Initializing git in agent memory workspace..."
    (cd "$RESEARCH_DIR/workspace" && git init && git add -A && git commit -m "Initial CryptoClaw agent memory" 2>/dev/null) || true
  fi
fi

# ============================================================
# 9. Install memory backup cron (optional)
# ============================================================
if [ "$MEMORY_BACKUP" = true ]; then
  echo "🔄 Installing agent memory auto-commit cron..."
  cp "$SCRIPT_DIR/scripts/memory-backup.sh" "$RESEARCH_DIR/scripts/memory-backup.sh"
  chmod +x "$RESEARCH_DIR/scripts/memory-backup.sh"

  CRON_CMD="*/15 * * * * $RESEARCH_DIR/scripts/memory-backup.sh $RESEARCH_DIR/workspace >> /tmp/crypto-claw-memory-backup.log 2>&1"
  (crontab -l 2>/dev/null | grep -v "memory-backup.sh"; echo "$CRON_CMD") | crontab -
  echo "  ✅ Cron installed: agent memory backup every 15 minutes"
fi

# ============================================================
# Done
# ============================================================
echo ""
echo "✅ CryptoClaw deployed! (3 agents: Research, Sentinel, Executor)"
echo ""
echo "Memory architecture:"
echo "  Agent memory (markdown): $RESEARCH_DIR/workspace/ → back up with private git repo"
echo "  Wallet data (SQLite):    $DB_DIR/$SAFE_ID.db"
echo ""
echo "Next steps:"
echo "  1. Edit $RESEARCH_DIR/workspace/USER.md with your profile"
echo "  2. Add API keys to .env (copy from .env.example)"
echo "  3. Set SAFE_ID, SAFE_ADDRESS_*, SAFE_SIGNER_KEY, RPC_* in .env"
echo "  4. Run: openclaw doctor --fix"
echo "  5. Run: openclaw security audit --deep"
echo "  6. Connect your messaging channel: openclaw onboard"
echo ""
echo "To back up agent memory to a private git repo:"
echo "  cd $RESEARCH_DIR/workspace"
echo "  git remote add origin git@github.com:your-org/crypto-claw-memory.git"
echo "  ./setup.sh --memory-backup"
echo ""
