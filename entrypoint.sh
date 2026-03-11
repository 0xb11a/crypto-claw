#!/bin/bash
# ============================================================
# entrypoint.sh — CryptoClaw Container Startup
#
# Runs on every container start:
#   1. Sync code-owned workspace files from templates into volumes
#   2. Repopulate sentinel/executor tmpfs workspaces from agent templates
#   3. Set up symlinks (memory dirs, data dirs, node_modules, shared files)
#   4. Run DB migrations (+ paper mode balance seeding)
#   5. First-run: configure gateway, register agents, set heartbeats, add cron jobs
#   6. Start OpenClaw gateway
# ============================================================

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw/.openclaw}"
TEMPLATES_DIR="/home/openclaw/workspace-templates"
AGENT_TEMPLATES="/home/openclaw/agent-templates"
NODE_MODULES_SRC="/home/openclaw/crypto-claw/scripts/node_modules"
SAFE_ID="${SAFE_ID:-default}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"
RESEARCH_MODEL="${RESEARCH_MODEL:-anthropic/claude-sonnet-4-5-20250929}"
SENTINEL_MODEL="${SENTINEL_MODEL:-ollama/deepseek-v3.1:671b-cloud}"
EXECUTOR_MODEL="${EXECUTOR_MODEL:-ollama/deepseek-v3.1:671b-cloud}"
PAPER_MODE="${PAPER_MODE:-false}"
PAPER_STARTING_BALANCE="${PAPER_STARTING_BALANCE:-10000}"

RESEARCH_WS="$OPENCLAW_HOME/agents/research/workspace"
SENTINEL_WS="$OPENCLAW_HOME/agents/sentinel/workspace"
EXECUTOR_WS="$OPENCLAW_HOME/agents/executor/workspace"
DB_DIR="$OPENCLAW_HOME/agents/research/data"
STATE_DIR="$OPENCLAW_HOME/.openclaw"

echo "[entrypoint] CryptoClaw starting (Safe ID: $SAFE_ID)"

if [ "$PAPER_MODE" = "true" ]; then
  echo "[entrypoint] *** PAPER MODE — no real transactions ***"
fi

# ============================================================
# 1. Sync research workspace (persistent volume)
# ============================================================
echo "[entrypoint] Syncing research workspace..."

mkdir -p "$RESEARCH_WS/memory"
mkdir -p "$RESEARCH_WS/skills"
mkdir -p "$RESEARCH_WS/scripts"

# Verify workspace dirs are writable (catches stale volume ownership from older builds)
for dir in "$RESEARCH_WS/scripts" "$RESEARCH_WS/memory" "$RESEARCH_WS/skills"; do
  if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    echo "[entrypoint] ERROR: $dir is not writable (likely root-owned from a previous build)."
    echo "[entrypoint] Fix: docker compose down -v && docker compose up -d"
    exit 1
  fi
done

# Code-owned files — always overwrite from templates
for file in TOOLS.md BOOT.md IDENTITY.md; do
  if [ -f "$TEMPLATES_DIR/$file" ]; then
    cp "$TEMPLATES_DIR/$file" "$RESEARCH_WS/$file"
  fi
done

# Research agent-specific files — always overwrite from source
for file in AGENTS.md SOUL.md HEARTBEAT.md; do
  src="/home/openclaw/crypto-claw/agents/research/$file"
  if [ -f "$src" ]; then
    cp "$src" "$RESEARCH_WS/$file"
  fi
done

# User/agent-owned files — seed only if missing
for file in USER.md MEMORY.md; do
  if [ ! -f "$RESEARCH_WS/$file" ] && [ -f "$TEMPLATES_DIR/$file" ]; then
    cp "$TEMPLATES_DIR/$file" "$RESEARCH_WS/$file"
    echo "[entrypoint]   Seeded $file (first run)"
  fi
done

# Research skills — always sync from image (may update between builds)
for skill in discovery analyst risk portfolio; do
  skill_src="/home/openclaw/crypto-claw/agents/research/skills/$skill/SKILL.md"
  if [ -f "$skill_src" ]; then
    mkdir -p "$RESEARCH_WS/skills/$skill"
    cp "$skill_src" "$RESEARCH_WS/skills/$skill/SKILL.md"
  fi
done

# Research scripts — copy .js and package.json, symlink node_modules
cp /home/openclaw/crypto-claw/scripts/*.js "$RESEARCH_WS/scripts/"
cp /home/openclaw/crypto-claw/scripts/package.json "$RESEARCH_WS/scripts/"
cp /home/openclaw/crypto-claw/scripts/memory-backup.sh "$RESEARCH_WS/scripts/memory-backup.sh"
chmod +x "$RESEARCH_WS/scripts/memory-backup.sh"
ln -sfn "$NODE_MODULES_SRC" "$RESEARCH_WS/scripts/node_modules"

# Init git repo for memory backup
# Each deployment uses its own branch: memory/<SAFE_ID>
MEMORY_BRANCH="memory/${SAFE_ID}"

if [ ! -d "$RESEARCH_WS/.git" ]; then
  echo "[entrypoint]   Initializing git in research workspace (branch: $MEMORY_BRANCH)..."
  cat > "$RESEARCH_WS/.gitignore" << 'GITIGNORE'
*
!.gitignore
!MEMORY.md
!memory/
!memory/*.md
GITIGNORE
  (cd "$RESEARCH_WS" && git init -q \
    && git checkout -b "$MEMORY_BRANCH" \
    && git config user.name "CryptoClaw" \
    && git config user.email "cryptoClaw@openclaw.local" \
    && git add -A && git commit -q -m "Initial CryptoClaw agent memory" 2>/dev/null) || true
else
  # Existing repo — ensure identity and correct branch (upgrade path)
  (cd "$RESEARCH_WS" \
    && git config user.name "CryptoClaw" \
    && git config user.email "cryptoClaw@openclaw.local") 2>/dev/null || true

  # Abort stuck rebase if present
  if [ -d "$RESEARCH_WS/.git/rebase-merge" ] || [ -d "$RESEARCH_WS/.git/rebase-apply" ]; then
    echo "[entrypoint]   Aborting stuck rebase..."
    (cd "$RESEARCH_WS" && git rebase --abort 2>/dev/null) || true
  fi

  # Switch to deployment branch if not already on it
  CURRENT_BRANCH=$(cd "$RESEARCH_WS" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  if [ "$CURRENT_BRANCH" != "$MEMORY_BRANCH" ]; then
    echo "[entrypoint]   Switching from '$CURRENT_BRANCH' to '$MEMORY_BRANCH'..."
    (cd "$RESEARCH_WS" && git checkout -B "$MEMORY_BRANCH" --quiet) 2>/dev/null || true
  fi
fi

# Configure git remote for memory push (if MEMORY_GIT_REMOTE is set)
if [ -n "${MEMORY_GIT_REMOTE:-}" ]; then
  (cd "$RESEARCH_WS" && git remote remove origin 2>/dev/null; git remote add origin "$MEMORY_GIT_REMOTE") || true
  # Fetch remote refs (non-blocking — ok if remote is unreachable)
  (cd "$RESEARCH_WS" && git fetch origin --quiet 2>/dev/null) || true
  # Log remote and branch without exposing token
  SAFE_REMOTE=$(echo "$MEMORY_GIT_REMOTE" | sed 's|://[^@]*@|://***@|')
  echo "[entrypoint]   Memory git remote: $SAFE_REMOTE (branch: $MEMORY_BRANCH)"
fi

echo "[entrypoint]   Research workspace ready"

# ============================================================
# 2. Repopulate sentinel/executor workspaces (tmpfs — empty each start)
# ============================================================
echo "[entrypoint] Populating sentinel/executor workspaces..."

for agent in sentinel executor; do
  ws="$OPENCLAW_HOME/agents/$agent/workspace"
  tpl="$AGENT_TEMPLATES/$agent"

  mkdir -p "$ws/skills" "$ws/scripts"

  # Agent-specific workspace files (AGENTS.md, SOUL.md, HEARTBEAT.md)
  for file in AGENTS.md SOUL.md HEARTBEAT.md; do
    [ -f "$tpl/$file" ] && cp "$tpl/$file" "$ws/$file"
  done

  # Shared workspace files — symlink to templates (identical across agents)
  for file in TOOLS.md IDENTITY.md; do
    ln -sf "$TEMPLATES_DIR/$file" "$ws/$file"
  done

  # MEMORY.md — symlink to research's curated patterns (shared across all agents)
  ln -sf "$RESEARCH_WS/MEMORY.md" "$ws/MEMORY.md"

  # Per-agent skills
  if [ -d "$tpl/skills" ]; then
    cp -r "$tpl/skills/"* "$ws/skills/" 2>/dev/null || true
  fi

  # Scripts — copy .js files, symlink node_modules
  if [ -d "$tpl/scripts" ]; then
    cp "$tpl/scripts/"*.js "$ws/scripts/" 2>/dev/null || true
    cp "$tpl/scripts/package.json" "$ws/scripts/" 2>/dev/null || true
  fi
  ln -sfn "$NODE_MODULES_SRC" "$ws/scripts/node_modules"
done

echo "[entrypoint]   Sentinel/executor workspaces ready"

# ============================================================
# 3. Set up symlinks (memory dirs, data dirs)
# ============================================================
echo "[entrypoint] Setting up symlinks..."

mkdir -p "$DB_DIR"

# Memory dir: sentinel/executor → research (shared daily logs)
# This symlink architecture means all three agents' memory writes land in
# research's workspace. The single memory-backup loop covers everything.
for ws in "$SENTINEL_WS" "$EXECUTOR_WS"; do
  target="$ws/memory"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$RESEARCH_WS/memory" "$target"
  fi
done

# Data dir: all agents get access to shared DB
for ws in "$RESEARCH_WS" "$SENTINEL_WS" "$EXECUTOR_WS"; do
  target="$ws/data"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$DB_DIR" "$target"
  fi
done

echo "[entrypoint]   Symlinks ready"

# ============================================================
# 4. Run DB migrations + paper mode balance seeding
# ============================================================
echo "[entrypoint] Running database migrations..."

export SAFE_ID
export DB_PATH="${DB_PATH:-$DB_DIR/$SAFE_ID.db}"

if (cd "$RESEARCH_WS" && node scripts/db-query.js migrate) > /dev/null; then
  echo "[entrypoint] Database ready ($SAFE_ID.db)"
else
  echo "[entrypoint] ERROR: Database migration failed"
  exit 1
fi

# Seed paper cash from env if paper mode enabled
if [ "$PAPER_MODE" = "true" ]; then
  (cd "$RESEARCH_WS" && node scripts/db-query.js set-paper-cash --amount "$PAPER_STARTING_BALANCE") > /dev/null
  (cd "$RESEARCH_WS" && node scripts/db-query.js set-meta --key paper_initial_balance --value "$PAPER_STARTING_BALANCE") > /dev/null
  echo "[entrypoint] Paper mode balance seeded: \$$PAPER_STARTING_BALANCE"
fi

# ============================================================
# 5. First-run: configure gateway, register agents, heartbeats, cron
#    Only on first run (fresh state volume). Restarts preserve
#    existing config, pairing, cron jobs, and sessions.
# ============================================================
if [ ! -f "$STATE_DIR/openclaw.json" ]; then
  echo "[entrypoint] First run — configuring OpenClaw..."

  # --- Gateway config ---
  openclaw config set gateway.mode local
  openclaw config set gateway.bind "$GATEWAY_BIND"
  openclaw config set gateway.port "$GATEWAY_PORT"
  openclaw config set gateway.controlUi.allowedOrigins '["*"]' --strict-json

  if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    openclaw config set gateway.auth.mode token
    openclaw config set gateway.auth.token "$OPENCLAW_GATEWAY_TOKEN"
    echo "[entrypoint]   Gateway auth: token"
  else
    openclaw config set gateway.auth none
    echo "[entrypoint]   Gateway auth: none"
  fi

  # --- Register agents ---
  echo "[entrypoint]   Registering agents..."

  openclaw agents add research \
    --workspace "$RESEARCH_WS" \
    --agent-dir "$OPENCLAW_HOME/agents/research/agent" \
    --model "$RESEARCH_MODEL" \
    --non-interactive 2>/dev/null || true

  openclaw agents add sentinel \
    --workspace "$SENTINEL_WS" \
    --agent-dir "$OPENCLAW_HOME/agents/sentinel/agent" \
    --model "$SENTINEL_MODEL" \
    --non-interactive 2>/dev/null || true

  openclaw agents add executor \
    --workspace "$EXECUTOR_WS" \
    --agent-dir "$OPENCLAW_HOME/agents/executor/agent" \
    --model "$EXECUTOR_MODEL" \
    --non-interactive 2>/dev/null || true

  # Disable the built-in "main" agent (can't be deleted, but disable heartbeat + make non-default)
  openclaw config set 'agents.list[0].default' 'false'
  openclaw config set 'agents.list[0].heartbeat' '{"every":"0m"}' --strict-json
  # Make research the default agent
  openclaw config set 'agents.list[1].default' 'true'

  echo "[entrypoint]   Agents registered: research, sentinel, executor"

  # --- Disable all heartbeats (using cron jobs instead for visibility) ---
  for i in 0 1 2 3; do
    openclaw config set "agents.list[$i].heartbeat" '{"every":"0m"}' --strict-json 2>/dev/null || true
  done

  # --- Global config (applies to all agents) ---
  # Per-agent tool restriction is enforced by script deployment:
  #   - Research gets all scripts (build-templates.sh / entrypoint.sh section 1)
  #   - Sentinel gets only: db-query, check-positions, check-liquidity, check-wallets
  #   - Executor gets only: db-query, execute-trade, check-safe-status
  # Per-agent skills are enforced by skills/ directory deployment (each agent has its own).
  # The safeBins allowlist uses "node scripts/*" — agents can only run scripts that
  # exist in their workspace, so the allowlist + deployment = least privilege.
  openclaw config set 'skills.allowBundled' '[]' --strict-json
  openclaw config set 'browser' '{"enabled":false}' --strict-json
  openclaw config set 'tools.web.search' '{"enabled":false}' --strict-json
  openclaw config set 'tools.web.fetch' '{"enabled":true}' --strict-json
  openclaw config set 'tools.exec' '{"security":"allowlist","ask":"on-miss","safeBins":["node scripts/*","cat memory/*","ls memory/","echo *"],"safeBinProfiles":{"node scripts/*":{"minPositional":1,"maxPositional":10,"deniedFlags":["-e","--eval","--input-type","-p","--print","-c","--check"]},"cat memory/*":{"minPositional":1,"maxPositional":5},"ls memory/":{"minPositional":0,"maxPositional":2},"echo *":{"minPositional":0,"maxPositional":10}}}' --strict-json

  # --- Memory: compaction flush + search ---
  openclaw config set 'agents.defaults.compaction.reserveTokensFloor' 40000
  openclaw config set 'agents.defaults.compaction.memoryFlush' '{"enabled":true,"softThresholdTokens":4000,"systemPrompt":"Session nearing compaction. Store durable memories now.","prompt":"Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."}' --strict-json
  openclaw config set 'agents.defaults.memorySearch' '{"enabled":true,"provider":"local","local":{"modelPath":"hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"},"query":{"hybrid":{"enabled":true,"vectorWeight":0.7,"textWeight":0.3}},"cache":{"enabled":true}}' --strict-json
  openclaw config set 'agents.defaults.contextPruning' '{"mode":"cache-ttl","ttl":"5m"}' --strict-json
  openclaw config set 'channels.telegram' '{"enabled":false,"groupPolicy":"open"}' --strict-json
  echo "[entrypoint]   Memory: flush at compaction, hybrid search enabled, context pruning 5m TTL"

  echo "[entrypoint] First-run configuration complete"
else
  echo "[entrypoint] State volume exists — preserving config/pairing/sessions"
fi

# ============================================================
# 5c. Configure Ollama Cloud provider (runs every start — API key may change)
# ============================================================
if [ -n "${OLLAMA_API_KEY:-}" ]; then
  OLLAMA_CONFIG="{\"baseUrl\":\"https://ollama.com\",\"api\":\"ollama\",\"apiKey\":\"$OLLAMA_API_KEY\",\"models\":[{\"id\":\"deepseek-v3.1:671b-cloud\",\"name\":\"DeepSeek V3.1 Cloud\"}]}"
  openclaw config set 'models.providers.ollama' "$OLLAMA_CONFIG" --strict-json
  echo "[entrypoint] Ollama Cloud provider configured"
fi

# ============================================================
# 5b. Ensure cron jobs exist (runs in background after gateway starts)
#     openclaw cron add requires a running gateway (WebSocket),
#     so we launch a background script that waits for the gateway
#     then creates missing jobs idempotently.
# ============================================================
ensure_cron_jobs() {
  # Wait for gateway to be fully ready (health + cron subsystem loaded)
  for i in $(seq 1 60); do
    if openclaw gateway health > /dev/null 2>&1; then
      # Extra wait for cron subsystem to load existing jobs from disk
      sleep 5
      break
    fi
    sleep 1
  done

  EXISTING=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
  JOB_COUNT=$(echo "$EXISTING" | grep -c '"name"' || true)

  # If jobs already exist, skip creation entirely
  if [ "$JOB_COUNT" -ge 3 ]; then
    echo "[cron-setup] All 3 jobs already exist, skipping"
    return 0
  fi

  add_if_missing() {
    local name="$1"; shift
    if ! echo "$EXISTING" | grep -q "\"name\".*\"$name\""; then
      openclaw cron add --name "$name" "$@" 2>/dev/null && \
        echo "[cron-setup] Created $name" || \
        echo "[cron-setup] Failed to create $name"
    fi
  }

  add_if_missing "executor-poll" \
    --every "1m" --agent executor --session isolated --light-context --no-deliver \
    --message "Respond in English only. Read HEARTBEAT.md. Check for approved trades and pending sell orders. Execute any that are ready. Reply HEARTBEAT_OK if nothing to do."

  add_if_missing "sentinel-watch" \
    --every "5m" --agent sentinel --session isolated --light-context --no-deliver \
    --message "Respond in English only. Read HEARTBEAT.md. Run ALL checks every cycle: price check, liquidity check, wallet check. Write sell orders and alerts to DB as needed. Log results via db-query.js. If no open positions or nothing wrong, reply HEARTBEAT_OK."

  add_if_missing "research-cycle" \
    --every "30m" --agent research --session isolated --no-deliver \
    --message "Read HEARTBEAT.md. Check heartbeat state: node scripts/db-query.js get-heartbeat --agent research. Run the most overdue check. If the check produces discoveries, run the FULL pipeline autonomously: analysis, risk assessment, trade proposal. Do not stop after scanning — you decide what to buy. Update timestamps via db-query.js. Log results to daily memory. If nothing actionable, reply HEARTBEAT_OK."

  echo "[cron-setup] Done"
}

# ============================================================
# 5d. Memory backup background loop
#     Runs memory-backup.sh every 15 minutes as a plain shell loop.
#     This replaces the previous agent cron approach which wasted
#     Sonnet API tokens just to execute a bash script.
# ============================================================
run_memory_backup_loop() {
  sleep 60  # wait for initial startup
  while true; do
    if [ -x "$RESEARCH_WS/scripts/memory-backup.sh" ]; then
      bash "$RESEARCH_WS/scripts/memory-backup.sh" "$RESEARCH_WS" 2>&1 | \
        sed 's/^/[memory-backup-bg] /'
    fi
    sleep 900  # 15 minutes
  done
}

# ============================================================
# 5e. Wallet scoring background loop
#     Runs score-wallets-bg.js every 10 minutes to pick up
#     proposed wallets and score them via Birdeye/Zerion APIs.
# ============================================================
run_wallet_scoring_loop() {
  sleep 120  # wait for startup + first heartbeat
  while true; do
    SAFE_ID="$SAFE_ID" DB_PATH="$DB_PATH" \
      node "$RESEARCH_WS/scripts/score-wallets-bg.js" 2>&1 | \
      sed 's/^/[wallet-scorer-bg] /'
    sleep 600  # 10 minutes
  done
}

# ============================================================
# 6. Start OpenClaw gateway
#    Launch cron setup, memory backup, and wallet scoring in
#    background (cron needs running gateway), then exec the
#    gateway as PID 1.
# ============================================================
echo "[entrypoint] Starting OpenClaw gateway..."
run_memory_backup_loop &
run_wallet_scoring_loop &
ensure_cron_jobs &
exec openclaw gateway run --port "$GATEWAY_PORT"
