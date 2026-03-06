#!/bin/bash
# ============================================================
# entrypoint.sh — CryptoClaw Container Startup
#
# Runs on every container start (not just first build).
# Handles three things before starting OpenClaw:
#
#   1. Sync code-owned workspace files from templates into volume
#      (preserves agent/user-owned files like MEMORY.md, USER.md)
#   2. Ensure symlinks exist (memory dirs, data dirs)
#   3. Run DB migrations
#
# Then exec's the OpenClaw gateway.
# ============================================================

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw/.openclaw}"
TEMPLATES_DIR="/home/openclaw/workspace-templates"
SAFE_ID="${SAFE_ID:-default}"

RESEARCH_DIR="$OPENCLAW_HOME/agents/research"
SENTINEL_DIR="$OPENCLAW_HOME/agents/sentinel"
EXECUTOR_DIR="$OPENCLAW_HOME/agents/executor"
DB_DIR="$RESEARCH_DIR/data"

echo "[entrypoint] CryptoClaw starting (Safe ID: $SAFE_ID)"

# ============================================================
# 1. Sync code-owned workspace files from templates
# ============================================================
echo "[entrypoint] Syncing workspace files..."

# Ensure workspace directories exist
mkdir -p "$RESEARCH_DIR/workspace/memory"
mkdir -p "$SENTINEL_DIR/workspace"
mkdir -p "$EXECUTOR_DIR/workspace"

# Code-owned files — ALWAYS overwrite from templates
# These get updated when the image is rebuilt
for file in TOOLS.md BOOT.md IDENTITY.md; do
  if [ -f "$TEMPLATES_DIR/$file" ]; then
    cp "$TEMPLATES_DIR/$file" "$RESEARCH_DIR/workspace/$file"
    echo "[entrypoint]   Updated $file"
  fi
done

# User/agent-owned files — seed only if missing
# These persist across redeploys
for file in USER.md MEMORY.md; do
  if [ ! -f "$RESEARCH_DIR/workspace/$file" ] && [ -f "$TEMPLATES_DIR/$file" ]; then
    cp "$TEMPLATES_DIR/$file" "$RESEARCH_DIR/workspace/$file"
    echo "[entrypoint]   Seeded $file (first run)"
  fi
done

# Sync code-owned files to sentinel/executor workspaces
for agent_dir in "$SENTINEL_DIR" "$EXECUTOR_DIR"; do
  for file in TOOLS.md IDENTITY.md; do
    if [ -f "$TEMPLATES_DIR/$file" ]; then
      cp "$TEMPLATES_DIR/$file" "$agent_dir/workspace/$file"
    fi
  done
done

# ============================================================
# 2. Ensure symlinks exist (memory dirs, data dirs)
# ============================================================
echo "[entrypoint] Checking symlinks..."

# Memory dir: sentinel/executor → research (shared daily logs)
for agent_dir in "$SENTINEL_DIR" "$EXECUTOR_DIR"; do
  target="$agent_dir/workspace/memory"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$RESEARCH_DIR/workspace/memory" "$target"
    echo "[entrypoint]   Linked $target → research memory"
  fi
done

# Data dir: sentinel/executor → research (shared SQLite DB)
mkdir -p "$DB_DIR"
for agent_dir in "$SENTINEL_DIR" "$EXECUTOR_DIR"; do
  target="$agent_dir/data"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$DB_DIR" "$target"
    echo "[entrypoint]   Linked $target → research data"
  fi
done

# ============================================================
# 3. Run DB migrations
# ============================================================
echo "[entrypoint] Running database migrations..."

export SAFE_ID
export DB_PATH="${DB_PATH:-$DB_DIR/$SAFE_ID.db}"

# Run migrations via the explicit migrate command
if (cd "$RESEARCH_DIR" && node scripts/db-query.js migrate) > /dev/null; then
  echo "[entrypoint] Database ready ($SAFE_ID.db)"
else
  echo "[entrypoint] ERROR: Database migration failed — aborting startup"
  exit 1
fi

# ============================================================
# 4. Start OpenClaw gateway
# ============================================================
echo "[entrypoint] Starting OpenClaw gateway..."
exec openclaw gateway start
