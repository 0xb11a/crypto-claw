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
#
# Retained-set deletion follow-up note: db.js, db-query.js, chains.js,
# order-approval.js, and agent-idleness.js were deleted after porting
# heartbeat-check.js, promote-pattern.js, emergency-sentinel.js, and
# emergency-executor.js off db.js to use cclaw subprocess calls.
# Retained script set is now ~10 files:
#   log.js, redact.js, promote-pattern.js, emergency-executor.js,
#   emergency-sentinel.js, heartbeat-check.js, pre-commit-check.js,
#   memory-backup.sh, codex-login.sh, ci/*.mjs
# send-alert.js was deleted in P5c — Telegram alerts now flow through
# cclaw alerts send (POST /v1/alerts/send, ADR-0028).
# log.js and redact.js are retained because heartbeat-check.js,
# emergency-sentinel.js, emergency-executor.js, and promote-pattern.js
# import them directly.
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
cp "$SRC/workspace/BOOT.md"      "$TEMPLATES/BOOT.md"
cp "$SRC/workspace/IDENTITY.md"  "$TEMPLATES/IDENTITY.md"
cp "$SRC/workspace/USER.md"      "$TEMPLATES/USER.md"
cp "$SRC/workspace/MEMORY.md"    "$TEMPLATES/MEMORY.md"

# ============================================================
# 1b. Research agent template (TOOLS.md is per-agent)
# ============================================================
mkdir -p "$AGENT_TPL/research"
cp "$SRC/agents/research/TOOLS.md" "$AGENT_TPL/research/TOOLS.md"

# ============================================================
# 2. Per-agent templates (sentinel, executor)
#    Research workspace is a persistent volume — synced at runtime
# ============================================================

# --- Sentinel ---
mkdir -p "$AGENT_TPL/sentinel/skills/sentinel" "$AGENT_TPL/sentinel/scripts"
cp "$SRC/agents/sentinel/AGENTS.md"     "$AGENT_TPL/sentinel/AGENTS.md"
cp "$SRC/agents/sentinel/SOUL.md"       "$AGENT_TPL/sentinel/SOUL.md"
cp "$SRC/agents/sentinel/HEARTBEAT.md"  "$AGENT_TPL/sentinel/HEARTBEAT.md"
cp "$SRC/agents/sentinel/TOOLS.md"      "$AGENT_TPL/sentinel/TOOLS.md"
cp "$SRC/agents/sentinel/skills/sentinel/SKILL.md" "$AGENT_TPL/sentinel/skills/sentinel/SKILL.md"

# Sentinel scripts: emergency + logging (retained set only, post-retained-deletion).
# db.js, db-query.js, chains.js, order-approval.js, agent-idleness.js deleted —
# ported scripts now use cclaw subprocess calls instead.
# send-alert.js deleted in P5c — Telegram alerts now via cclaw alerts send.
for script in emergency-sentinel.js redact.js log.js promote-pattern.js heartbeat-check.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/sentinel/scripts/"
done
cp "$SCRIPTS_DIR/package.json" "$AGENT_TPL/sentinel/scripts/"

# --- Executor ---
mkdir -p "$AGENT_TPL/executor/skills/executor" "$AGENT_TPL/executor/scripts"
cp "$SRC/agents/executor/AGENTS.md"     "$AGENT_TPL/executor/AGENTS.md"
cp "$SRC/agents/executor/SOUL.md"       "$AGENT_TPL/executor/SOUL.md"
cp "$SRC/agents/executor/HEARTBEAT.md"  "$AGENT_TPL/executor/HEARTBEAT.md"
cp "$SRC/agents/executor/TOOLS.md"      "$AGENT_TPL/executor/TOOLS.md"
cp "$SRC/agents/executor/skills/executor/SKILL.md" "$AGENT_TPL/executor/skills/executor/SKILL.md"

# Executor scripts: emergency + logging (retained set only, post-retained-deletion).
# db.js, db-query.js, chains.js, order-approval.js, agent-idleness.js deleted —
# ported scripts now use cclaw subprocess calls instead.
# Execution is fully handled by ExecuteOrderProcessor (NestJS worker) via
# cclaw orders execute --id X. The legacy execute-trade-*.js scripts are deleted.
# send-alert.js deleted in P5c — Telegram alerts now via cclaw alerts send.
for script in emergency-executor.js redact.js log.js promote-pattern.js heartbeat-check.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/executor/scripts/"
done
cp "$SCRIPTS_DIR/package.json" "$AGENT_TPL/executor/scripts/"

# --- Observer ---
mkdir -p "$AGENT_TPL/observer/skills/triage" "$AGENT_TPL/observer/skills/create-gh-issue" "$AGENT_TPL/observer/scripts"
cp "$SRC/agents/observer/AGENTS.md"     "$AGENT_TPL/observer/AGENTS.md"
cp "$SRC/agents/observer/SOUL.md"       "$AGENT_TPL/observer/SOUL.md"
cp "$SRC/agents/observer/HEARTBEAT.md"  "$AGENT_TPL/observer/HEARTBEAT.md"
cp "$SRC/agents/observer/TOOLS.md"      "$AGENT_TPL/observer/TOOLS.md"
cp "$SRC/agents/observer/skills/triage/SKILL.md" "$AGENT_TPL/observer/skills/triage/SKILL.md"
cp "$SRC/agents/observer/skills/create-gh-issue/SKILL.md" "$AGENT_TPL/observer/skills/create-gh-issue/SKILL.md"

# Observer scripts: logging + MEMORY.md write-protection (post-retained-deletion).
# db.js, db-query.js, chains.js, order-approval.js, agent-idleness.js deleted.
# P5: check-signer-balances.js deleted; Observer reads signer state via cclaw or logs.
# P5c: send-alert.js deleted; Observer alerts now via cclaw alerts send.
for script in redact.js log.js promote-pattern.js; do
  cp "$SCRIPTS_DIR/$script" "$AGENT_TPL/observer/scripts/"
done
cp "$SCRIPTS_DIR/package.json" "$AGENT_TPL/observer/scripts/"

echo "[build-templates] Done"
