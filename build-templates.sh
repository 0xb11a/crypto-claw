#!/bin/bash
# ============================================================
# build-templates.sh — Docker Build-Time Template Assembly
#
# Creates the template layout used by entrypoint.sh to populate
# agent workspaces on container start. Run only during Docker build.
#
# Layout:
#   /home/openclaw/workspace-templates/   — shared workspace files
#   /home/openclaw/agent-templates/       — per-agent workspace files + scripts
# ============================================================

set -euo pipefail

SRC="/home/openclaw/crypto-claw"
TEMPLATES="/home/openclaw/workspace-templates"
AGENT_TPL="/home/openclaw/agent-templates"
SCRIPTS_DIR="$SRC/scripts"

echo "[build-templates] Building workspace templates..."

# ============================================================
# 1. Shared workspace templates (used by all agents)
# ============================================================
mkdir -p "$TEMPLATES"
cp "$SRC/workspace/TOOLS.md"     "$TEMPLATES/TOOLS.md"
cp "$SRC/workspace/BOOT.md"      "$TEMPLATES/BOOT.md"
cp "$SRC/workspace/IDENTITY.md"  "$TEMPLATES/IDENTITY.md"
cp "$SRC/workspace/USER.md"      "$TEMPLATES/USER.md"
cp "$SRC/workspace/MEMORY.md"    "$TEMPLATES/MEMORY.md"

# ============================================================
# 2. Per-agent templates (sentinel, executor)
#    Research workspace is a persistent volume — synced at runtime
# ============================================================

# --- Sentinel ---
mkdir -p "$AGENT_TPL/sentinel/skills/sentinel" "$AGENT_TPL/sentinel/scripts"
cp "$SRC/agents/sentinel/AGENTS.md"     "$AGENT_TPL/sentinel/AGENTS.md"
cp "$SRC/agents/sentinel/SOUL.md"       "$AGENT_TPL/sentinel/SOUL.md"
cp "$SRC/agents/sentinel/HEARTBEAT.md"  "$AGENT_TPL/sentinel/HEARTBEAT.md"
cp "$SRC/agents/sentinel/skills/sentinel/SKILL.md" "$AGENT_TPL/sentinel/skills/sentinel/SKILL.md"

# Sentinel scripts: monitoring + db access + chain config + portfolio sync
for script in db.js db-query.js chains.js check-positions.js check-liquidity.js check-wallets.js check-contract.js portfolio-load-evm.js portfolio-load-solana.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/sentinel/scripts/"
done
cp "$SCRIPTS_DIR/package.json" "$AGENT_TPL/sentinel/scripts/"

# --- Executor ---
mkdir -p "$AGENT_TPL/executor/skills/executor" "$AGENT_TPL/executor/scripts"
cp "$SRC/agents/executor/AGENTS.md"     "$AGENT_TPL/executor/AGENTS.md"
cp "$SRC/agents/executor/SOUL.md"       "$AGENT_TPL/executor/SOUL.md"
cp "$SRC/agents/executor/HEARTBEAT.md"  "$AGENT_TPL/executor/HEARTBEAT.md"
cp "$SRC/agents/executor/skills/executor/SKILL.md" "$AGENT_TPL/executor/skills/executor/SKILL.md"

# Executor scripts: db access + execution + price checking + chain config + portfolio sync
for script in db.js db-query.js chains.js token-metrics.js portfolio-load-evm.js portfolio-load-solana.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/executor/scripts/"
done
for script in execute-trade.js check-safe-status.js execute-trade-solana.js check-squads-status.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/executor/scripts/"
done
cp "$SCRIPTS_DIR/package.json" "$AGENT_TPL/executor/scripts/"

echo "[build-templates] Done"
