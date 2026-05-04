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
RESEARCH_MODEL="${RESEARCH_MODEL:-}"
SENTINEL_MODEL="${SENTINEL_MODEL:-}"
EXECUTOR_MODEL="${EXECUTOR_MODEL:-}"
OBSERVER_MODEL="${OBSERVER_MODEL:-}"
SENTINEL_MODEL_FALLBACK="${SENTINEL_MODEL_FALLBACK:-}"
EXECUTOR_MODEL_FALLBACK="${EXECUTOR_MODEL_FALLBACK:-}"
EMERGENCY_AFTER="${EMERGENCY_AFTER:-3}"
PAPER_MODE="${PAPER_MODE:-false}"
PAPER_STARTING_BALANCE="${PAPER_STARTING_BALANCE:-10000}"
AUTO_APPROVE_BUY="${AUTO_APPROVE_BUY:-false}"

RESEARCH_WS="$OPENCLAW_HOME/agents/research/workspace"
SENTINEL_WS="$OPENCLAW_HOME/agents/sentinel/workspace"
EXECUTOR_WS="$OPENCLAW_HOME/agents/executor/workspace"
OBSERVER_WS="$OPENCLAW_HOME/agents/observer/workspace"
DB_DIR="$OPENCLAW_HOME/agents/research/data"
STATE_DIR="$OPENCLAW_HOME/.openclaw"

echo "[entrypoint] CryptoClaw starting (Safe ID: $SAFE_ID)"

if [ "$PAPER_MODE" = "true" ]; then
  echo "[entrypoint] *** PAPER MODE — no real transactions ***"
fi
if [ "$AUTO_APPROVE_BUY" = "true" ] && [ "$PAPER_MODE" != "true" ]; then
  echo "[entrypoint] *** AUTO-APPROVE BUY enabled — buys will not require human approval ***"
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
for file in BOOT.md IDENTITY.md; do
  if [ -f "$TEMPLATES_DIR/$file" ]; then
    cp "$TEMPLATES_DIR/$file" "$RESEARCH_WS/$file"
  fi
done
# Per-agent TOOLS.md (each agent gets its own version)
if [ -f "$AGENT_TEMPLATES/research/TOOLS.md" ]; then
  cp "$AGENT_TEMPLATES/research/TOOLS.md" "$RESEARCH_WS/TOOLS.md"
fi

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
for skill in discovery analyst risk portfolio orders; do
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

for agent in sentinel executor observer; do
  ws="$OPENCLAW_HOME/agents/$agent/workspace"
  tpl="$AGENT_TEMPLATES/$agent"

  mkdir -p "$ws/skills" "$ws/scripts"

  # Agent-specific workspace files (AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md)
  for file in AGENTS.md SOUL.md HEARTBEAT.md TOOLS.md; do
    [ -f "$tpl/$file" ] && cp "$tpl/$file" "$ws/$file"
  done

  # Shared workspace files — symlink to templates (identical across agents)
  for file in IDENTITY.md; do
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

echo "[entrypoint]   Sentinel/executor/observer workspaces ready"

# ============================================================
# 3. Set up symlinks (memory dirs, data dirs)
# ============================================================
echo "[entrypoint] Setting up symlinks..."

mkdir -p "$DB_DIR"

# Memory dir: sentinel/executor/observer → research (shared daily logs)
# This symlink architecture means all four agents' memory writes land in
# research's workspace. The single memory-backup loop covers everything.
for ws in "$SENTINEL_WS" "$EXECUTOR_WS" "$OBSERVER_WS"; do
  target="$ws/memory"
  if [ ! -L "$target" ]; then
    rm -rf "$target"
    ln -sf "$RESEARCH_WS/memory" "$target"
  fi
done

# Data dir: all agents get access to shared DB
for ws in "$RESEARCH_WS" "$SENTINEL_WS" "$EXECUTOR_WS" "$OBSERVER_WS"; do
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

# Seed paper cash from env if paper mode enabled (per-chain)
if [ "$PAPER_MODE" = "true" ]; then
  IFS=',' read -ra _CHAINS <<< "${ACTIVE_CHAINS:-base,ethereum,solana}"
  for _chain in "${_CHAINS[@]}"; do
    _chain=$(echo "$_chain" | xargs)
    _override_var="PAPER_STARTING_BALANCE_$(echo "$_chain" | tr '[:lower:]' '[:upper:]')"
    _balance="${!_override_var:-$PAPER_STARTING_BALANCE}"
    (cd "$RESEARCH_WS" && node scripts/db-query.js set-paper-cash --chain "$_chain" --amount "$_balance") > /dev/null
    (cd "$RESEARCH_WS" && node scripts/db-query.js set-meta --key "paper_initial_balance_$_chain" --value "$_balance") > /dev/null
    echo "[entrypoint] Paper mode balance seeded: $_chain = \$$_balance"
  done
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

  openclaw agents add observer \
    --workspace "$OBSERVER_WS" \
    --agent-dir "$OPENCLAW_HOME/agents/observer/agent" \
    --model "$OBSERVER_MODEL" \
    --non-interactive 2>/dev/null || true

  # Disable the built-in "main" agent (can't be deleted, but disable heartbeat + make non-default)
  openclaw config set 'agents.list[0].default' 'false'
  openclaw config set 'agents.list[0].heartbeat' '{"every":"0m"}' --strict-json
  # Make research the default agent
  openclaw config set 'agents.list[1].default' 'true'

  echo "[entrypoint]   Agents registered: research, sentinel, executor, observer"

  # --- Disable all heartbeats (using cron jobs instead for visibility) ---
  for i in 0 1 2 3 4; do
    openclaw config set "agents.list[$i].heartbeat" '{"every":"0m"}' --strict-json 2>/dev/null || true
  done

  # --- Global config (applies to all agents) ---
  # Per-agent tool restriction is enforced by script deployment:
  #   - Research gets all scripts (build-templates.sh / entrypoint.sh section 1)
  #   - Sentinel gets only: db-query, check-positions, check-liquidity, check-wallets
  #   - Executor gets only: db-query, execute-trade, check-safe-status
  # Per-agent skills are enforced by skills/ directory deployment (each agent has its own).
  # Exec uses security=full + ask=off (headless mode). Least privilege is enforced
  # by script deployment: agents can only run scripts present in their workspace.
  openclaw config set 'skills.allowBundled' '[]' --strict-json
  openclaw config set 'browser' '{"enabled":false}' --strict-json
  openclaw config set 'tools.web.search' '{"enabled":false}' --strict-json
  openclaw config set 'tools.web.fetch' '{"enabled":true}' --strict-json
  openclaw config set 'tools.exec' '{"host":"gateway","security":"full","ask":"off"}' --strict-json
  openclaw config set 'tools.sandbox.tools' '{"allow":["read","write","apply_patch","exec"],"deny":[]}' --strict-json
  # Per-agent exec override (agents.list[N] takes precedence over global tools.exec)
  for i in 0 1 2 3 4; do
    openclaw config set "agents.list[$i].tools.exec" '{"host":"gateway","security":"full","ask":"off"}' --strict-json 2>/dev/null || true
  done

  # --- Memory: compaction flush + search ---
  openclaw config set 'agents.defaults.compaction.reserveTokensFloor' 80000
  openclaw config set 'agents.defaults.compaction.memoryFlush' '{"enabled":true,"softThresholdTokens":8000,"systemPrompt":"Session nearing compaction. Store durable memories now.","prompt":"Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."}' --strict-json
  openclaw config set 'agents.defaults.memorySearch' '{"enabled":true,"provider":"local","local":{"modelPath":"hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"},"query":{"hybrid":{"enabled":true,"vectorWeight":0.7,"textWeight":0.3}},"cache":{"enabled":true}}' --strict-json
  openclaw config set 'agents.defaults.contextPruning' '{"mode":"cache-ttl","ttl":"5m"}' --strict-json
  openclaw config set 'agents.defaults.sandbox.mode' 'off'
  # Telegram channel config is applied after this block (section 5a) on every startup
  echo "[entrypoint]   Memory: flush at compaction, hybrid search enabled, context pruning 5m TTL"

  echo "[entrypoint] First-run configuration complete"
else
  echo "[entrypoint] State volume exists — preserving config/pairing/sessions"

  # --- Migrate compaction settings for larger context window models ---
  CURRENT_RESERVE=$(openclaw config get 'agents.defaults.compaction.reserveTokensFloor' 2>/dev/null || echo "0")
  if [ "$CURRENT_RESERVE" = "40000" ]; then
    openclaw config set 'agents.defaults.compaction.reserveTokensFloor' 80000
    openclaw config set 'agents.defaults.compaction.memoryFlush.softThresholdTokens' 8000
    echo "[entrypoint] Migrated compaction settings for larger context windows"
  fi

  # --- Migrate memorySearch from openai provider to local embeddings ---
  CURRENT_SEARCH_PROVIDER=$(openclaw config get 'agents.defaults.memorySearch.provider' 2>/dev/null || echo "")
  if [ "$CURRENT_SEARCH_PROVIDER" = "openai" ]; then
    openclaw config set 'agents.defaults.memorySearch' '{"enabled":true,"provider":"local","local":{"modelPath":"hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"},"query":{"hybrid":{"enabled":true,"vectorWeight":0.7,"textWeight":0.3}},"cache":{"enabled":true}}' --strict-json
    echo "[entrypoint] Migrated memorySearch from openai to local embeddings"
  fi

  # --- Ensure exec config for headless mode (security=full, ask=off, host=gateway) ---
  # Always set — both global and per-agent (per-agent takes precedence)
  openclaw config set 'tools.exec' '{"host":"gateway","security":"full","ask":"off"}' --strict-json
  for i in 0 1 2 3 4; do
    openclaw config set "agents.list[$i].tools.exec" '{"host":"gateway","security":"full","ask":"off"}' --strict-json 2>/dev/null || true
  done
  # Ensure sandbox-level exec permission exists (new in latest OpenClaw)
  openclaw config set 'tools.sandbox.tools' '{"allow":["read","write","apply_patch","exec"],"deny":[]}' --strict-json

  # --- Ensure all agents are registered (auto-recover removed agents) ---
  ensure_agents() {
    AGENTS_JSON=$(openclaw agents list --json 2>/dev/null || echo '[]')

    check_and_add() {
      local name="$1" workspace="$2" model="$3"
      if ! echo "$AGENTS_JSON" | grep -q "\"$name\""; then
        echo "[entrypoint]   Agent '$name' missing — re-registering..."
        openclaw agents add "$name" \
          --workspace "$workspace" \
          --agent-dir "$OPENCLAW_HOME/agents/$name/agent" \
          --model "$model" \
          --non-interactive 2>/dev/null || true
      fi
    }

    check_and_add research "$RESEARCH_WS" "$RESEARCH_MODEL"
    check_and_add sentinel "$SENTINEL_WS" "$SENTINEL_MODEL"
    check_and_add executor "$EXECUTOR_WS" "$EXECUTOR_MODEL"
    check_and_add observer "$OBSERVER_WS" "$OBSERVER_MODEL"
  }
  ensure_agents

  # --- Sync agent models (picks up model changes without wiping state volume) ---
  echo "[entrypoint]   Syncing agent models..."
  AGENTS_JSON=$(openclaw agents list --json 2>/dev/null || echo '[]')
  sync_model() {
    local name="$1" desired="$2" idx="$3"
    current=$(echo "$AGENTS_JSON" | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const a=JSON.parse(d);const m=a.find(x=>x.name==='$name');console.log(m?.model||'')}
        catch{console.log('')}
      })")
    if [ -n "$current" ] && [ "$current" != "$desired" ]; then
      openclaw config set "agents.list[$idx].model" "$desired" 2>/dev/null && \
        echo "[entrypoint]     $name: $current → $desired" || true
    fi
  }
  # indices: 0=main(disabled), 1=research, 2=sentinel, 3=executor, 4=observer
  sync_model research "$RESEARCH_MODEL" 1
  sync_model sentinel "$SENTINEL_MODEL" 2
  sync_model executor "$EXECUTOR_MODEL" 3
  sync_model observer "$OBSERVER_MODEL" 4

fi

# ============================================================
# 5a. Sync Telegram channel config (every startup)
#     Channel config must be applied on every start — not just first run —
#     so env var changes (ENABLE_CHANNELS, topic IDs) take effect on redeploy.
# ============================================================
if [ "${ENABLE_CHANNELS:-false}" = "true" ] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  # Build per-topic agent routing if topic env vars are set
  TOPIC_CONFIG='{}'
  if [ -n "${TG_TOPIC_RESEARCH:-}" ] || [ -n "${TG_TOPIC_SENTINEL:-}" ] || [ -n "${TG_TOPIC_EXECUTOR:-}" ] || [ -n "${TG_TOPIC_OBSERVER:-}" ]; then
    TOPIC_CONFIG=$(node -e "
      const t = {};
      if (process.env.TG_TOPIC_RESEARCH) t[process.env.TG_TOPIC_RESEARCH] = {agentId:'research'};
      if (process.env.TG_TOPIC_SENTINEL) t[process.env.TG_TOPIC_SENTINEL] = {agentId:'sentinel'};
      if (process.env.TG_TOPIC_EXECUTOR) t[process.env.TG_TOPIC_EXECUTOR] = {agentId:'executor'};
      if (process.env.TG_TOPIC_OBSERVER) t[process.env.TG_TOPIC_OBSERVER] = {agentId:'observer'};
      console.log(JSON.stringify(t));
    ")
  fi

  if [ -n "${TELEGRAM_CHAT_ID:-}" ] && [ "$TOPIC_CONFIG" != '{}' ]; then
    # Supergroup with forum topics — per-topic agent routing
    openclaw config set 'channels.telegram' "$(TOPIC_JSON="$TOPIC_CONFIG" node -e "
      const ownerId = process.env.TELEGRAM_OWNER_ID;
      const group = {
        requireMention: false,
        topics: JSON.parse(process.env.TOPIC_JSON)
      };
      if (ownerId) group.allowFrom = [Number(ownerId)];
      const cfg = {
        enabled: true,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        dmPolicy: 'disabled',
        groupPolicy: 'allowlist',
        groups: {
          [process.env.TELEGRAM_CHAT_ID]: group
        }
      };
      console.log(JSON.stringify(cfg));
    ")" --strict-json
    echo "[entrypoint] Telegram channel synced with forum topic routing (DMs disabled, groups allowlisted)"
  else
    # Flat group or DM — no topic routing
    openclaw config set 'channels.telegram' "$(node -e "
      console.log(JSON.stringify({
        enabled: true,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        dmPolicy: 'disabled',
        groupPolicy: 'allowlist'
      }));
    ")" --strict-json
    echo "[entrypoint] Telegram channel synced (flat mode, DMs disabled, groups allowlisted)"
  fi
else
  openclaw config set 'channels.telegram' '{"enabled":false,"groupPolicy":"allowlist"}' --strict-json
  echo "[entrypoint] Telegram channel disabled"
fi

# ============================================================
# 5c. Configure model providers (runs every start — API keys may change)
# ============================================================

# OpenAI model providers
# Always register openai-codex provider (OpenClaw handles OAuth auth internally)
CODEX_PROVIDER='{"baseUrl":"https://api.openai.com/v1","api":"openai-codex-responses","models":[{"id":"gpt-5.5","name":"GPT-5.5","contextWindow":1050000},{"id":"gpt-5.4","name":"GPT-5.4","contextWindow":1050000},{"id":"gpt-5.4-mini","name":"GPT-5.4 Mini","contextWindow":400000}]}'
openclaw config set 'models.providers.openai-codex' "$CODEX_PROVIDER" --strict-json
echo "[entrypoint] OpenAI: Codex OAuth provider registered"
echo "[entrypoint]   → If not yet authenticated: docker compose exec crypto-claw openclaw models auth login --provider openai-codex"

# Symlink Codex OAuth credentials from research (persistent) to sentinel/executor (tmpfs)
# NOTE: copy would cause token-refresh race — Research refreshes first, invalidating the
# old refresh token that Sentinel/Executor still hold.  Symlink ensures all agents read
# the same (always-current) file.
RESEARCH_AUTH="$OPENCLAW_HOME/agents/research/agent/auth-profiles.json"
if [ -f "$RESEARCH_AUTH" ]; then
  for agent_dir in "$OPENCLAW_HOME/agents/sentinel/agent" "$OPENCLAW_HOME/agents/executor/agent" "$OPENCLAW_HOME/agents/observer/agent"; do
    mkdir -p "$agent_dir"
    ln -sf "$RESEARCH_AUTH" "$agent_dir/auth-profiles.json"
  done
  echo "[entrypoint]   Auth profiles symlinked to sentinel + executor + observer"
else
  echo "[entrypoint]   ⚠ No auth-profiles.json found — run: docker compose exec crypto-claw openclaw models auth login --provider openai-codex"
fi

# Allow Codex models for agents
openclaw config set 'agents.defaults.models' '{"openai-codex/gpt-5.5":{},"openai-codex/gpt-5.4":{},"openai-codex/gpt-5.4-mini":{}}' --strict-json
# Clean up stale CLI backend config from previous approach
openclaw config unset 'agents.defaults.cliBackends.codex-cli' 2>/dev/null || true

# Also register API key provider if available (fallback)
if [ -n "${OPENAI_API_KEY:-}" ]; then
  OPENAI_CONFIG="{\"baseUrl\":\"https://api.openai.com/v1\",\"api\":\"openai-responses\",\"apiKey\":\"$OPENAI_API_KEY\",\"models\":[{\"id\":\"gpt-5.4\",\"name\":\"GPT-5.4\",\"contextWindow\":1050000},{\"id\":\"gpt-5.4-mini\",\"name\":\"GPT-5.4 Mini\",\"contextWindow\":400000}]}"
  openclaw config set 'models.providers.openai' "$OPENAI_CONFIG" --strict-json
  echo "[entrypoint] OpenAI: API key provider also registered (fallback)"
fi


# Anthropic provider (required for Claude agents)
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ANTHROPIC_CONFIG="{\"baseUrl\":\"https://api.anthropic.com/v1\",\"api\":\"anthropic-messages\",\"apiKey\":\"$ANTHROPIC_API_KEY\",\"models\":[{\"id\":\"claude-haiku-4-5-20251001\",\"name\":\"Claude Haiku 4.5\",\"contextWindow\":200000},{\"id\":\"claude-sonnet-4-6\",\"name\":\"Claude Sonnet 4.6\",\"contextWindow\":500000}]}"
  openclaw config set 'models.providers.anthropic' "$ANTHROPIC_CONFIG" --strict-json
  echo "[entrypoint] Anthropic provider configured"
else
  if echo "$RESEARCH_MODEL$SENTINEL_MODEL$EXECUTOR_MODEL" | grep -q "anthropic/"; then
    echo "[entrypoint] WARNING: Agents configured for Anthropic models but ANTHROPIC_API_KEY is not set"
  fi
fi

# Ollama Cloud provider (optional)
if [ -n "${OLLAMA_API_KEY:-}" ]; then
  OLLAMA_CONFIG="{\"baseUrl\":\"https://ollama.com\",\"api\":\"ollama\",\"apiKey\":\"$OLLAMA_API_KEY\",\"models\":[{\"id\":\"deepseek-v3.1:671b-cloud\",\"name\":\"DeepSeek V3.1 Cloud\"}]}"
  openclaw config set 'models.providers.ollama' "$OLLAMA_CONFIG" --strict-json
  echo "[entrypoint] Ollama Cloud provider configured"
fi

# ============================================================
# 5c¾. Authenticate gh CLI (every startup — token may change)
#       Stores auth in ~/.config/gh/hosts.yml so agents can use gh
#       without needing the token in their exec environment (OpenClaw
#       strips well-known credential values from agent env vars).
# ============================================================
if [ -n "${GH_TOKEN:-}" ]; then
  # Write hosts.yml directly — gh auth login refuses to write it when
  # GH_TOKEN env var is present (uses it in-memory instead).
  # /home/node/.config/gh is a writable tmpfs mount (docker-compose.yml).
  GH_HOSTS="/home/node/.config/gh/hosts.yml"
  cat > "$GH_HOSTS" <<GHEOF
github.com:
  oauth_token: ${GH_TOKEN}
  git_protocol: https
GHEOF
  chmod 600 "$GH_HOSTS"
  echo "[entrypoint] GitHub CLI authenticated (hosts.yml written)"
else
  echo "[entrypoint] GitHub CLI: GH_TOKEN not set, skipping auth"
fi

# ============================================================
# 5c½. Sync logging config (every startup — LOG_LEVEL changes take effect on restart)
# ============================================================
LOG_LEVEL="${LOG_LEVEL:-info}"
OPENCLAW_LOG_STYLE="${OPENCLAW_LOG_STYLE:-pretty}"

echo "[entrypoint] Configuring logging (level=$LOG_LEVEL, style=$OPENCLAW_LOG_STYLE)..."
mkdir -p /tmp/openclaw

openclaw config set 'logging.level' "$LOG_LEVEL"
openclaw config set 'logging.consoleLevel' "$LOG_LEVEL"
openclaw config set 'logging.consoleStyle' "$OPENCLAW_LOG_STYLE"
openclaw config set 'logging.file' '/tmp/openclaw/openclaw.log'
openclaw config set 'logging.redactSensitive' 'tools'
openclaw config set 'logging.redactPatterns' '["sk-.*","xprv.*","0x[a-fA-F0-9]{64}"]' --strict-json

echo "[entrypoint] Logging configured"

# ============================================================
# 5b. Ensure cron jobs exist (runs in background after gateway starts)
#     openclaw cron add requires a running gateway (WebSocket),
#     so we launch a background script that waits for the gateway
#     then creates missing jobs idempotently.
# ============================================================
ensure_cron_jobs() {
  echo "[cron-setup] Waiting for gateway..."
  # Wait for gateway to be fully ready (health + cron subsystem loaded)
  GATEWAY_READY=false
  for i in $(seq 1 60); do
    HEALTH_OUTPUT=$(timeout -k 5 30 openclaw gateway health 2>&1) && HEALTH_EXIT=0 || HEALTH_EXIT=$?
    if [ $HEALTH_EXIT -eq 0 ] || echo "$HEALTH_OUTPUT" | grep -q "Health OK"; then
      echo "[cron-setup] Gateway healthy after ${i}s"
      # Extra wait for cron subsystem to load existing jobs from disk
      sleep 5
      GATEWAY_READY=true
      break
    fi
    if [ $((i % 10)) -eq 0 ] || [ $i -eq 1 ]; then
      echo "[cron-setup] Attempt $i: exit=$HEALTH_EXIT output=$(echo "$HEALTH_OUTPUT" | head -2 | tr '\n' ' ')"
    fi
    sleep 1
  done

  if [ "$GATEWAY_READY" != "true" ]; then
    echo "[cron-setup] ERROR: gateway not ready after 60s — skipping cron setup"
    echo "[cron-setup] Last health output: $HEALTH_OUTPUT"
    return 1
  fi

  EXISTING=$(openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
  JOB_COUNT=$(echo "$EXISTING" | grep -c '"name"' || true)
  echo "[cron-setup] Found $JOB_COUNT existing cron job(s)"

  # Note: no early return — always proceed to force-recreate research-cycle
  # with explicit --model flag and clean up any legacy jobs

  # Extract job id by name from $EXISTING JSON
  get_job_id() {
    echo "$EXISTING" | grep -B5 "\"name\".*\"$1\"" | grep '"id"' | head -1 | sed 's/.*"id": *"\([a-f0-9-]*\)".*/\1/'
  }

  # Remove a cron job by name (looks up id from $EXISTING)
  remove_by_name() {
    local name="$1"
    local id
    id=$(get_job_id "$name")
    if [ -n "$id" ]; then
      echo "[cron-setup] Removing $name (id: $id)..."
      timeout -k 5 15 openclaw cron rm "$id" --json 2>/dev/null && \
        echo "[cron-setup] Removed $name" || \
        echo "[cron-setup] Failed to remove $name"
    fi
  }

  add_if_missing() {
    local name="$1"; shift
    if ! echo "$EXISTING" | grep -q "\"name\".*\"$name\""; then
      echo "[cron-setup] Adding $name..."
      timeout -k 5 30 openclaw cron add --name "$name" "$@" && \
        echo "[cron-setup] Created $name" || \
        echo "[cron-setup] Failed to create $name"
    else
      echo "[cron-setup] $name already exists, skipping"
    fi
  }

  # Remove legacy cron jobs (replaced by background loops)
  for legacy in executor-poll sentinel-watch observer-loop; do
    if echo "$EXISTING" | grep -q "\"name\".*\"$legacy\""; then
      remove_by_name "$legacy"
    fi
  done

  # Force recreate research-cycle if it exists (picks up --model flag)
  if echo "$EXISTING" | grep -q '"name".*"research-cycle"'; then
    remove_by_name "research-cycle"
  fi

  # Force recreate observer-cycle if it exists (picks up --model flag)
  if [ -n "${OBSERVER_ISSUES_REPO:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
    if echo "$EXISTING" | grep -q '"name".*"observer-cycle"'; then
      remove_by_name "observer-cycle"
    fi
  fi

  # Refresh EXISTING after all deletes so add_if_missing sees current state
  EXISTING=$(timeout -k 3 10 openclaw cron list --json 2>/dev/null || echo '{"jobs":[]}')
  echo "[cron-setup] After cleanup: $(echo "$EXISTING" | grep -c '"name"' || echo 0) job(s)"

  # Deliver research cycle output to Research topic if configured, otherwise suppress
  RESEARCH_CRON_DELIVERY="--no-deliver"
  if [ -n "${TG_TOPIC_RESEARCH:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    RESEARCH_CRON_DELIVERY="--announce --channel telegram --to ${TELEGRAM_CHAT_ID}:topic:${TG_TOPIC_RESEARCH}"
  fi

  add_if_missing "research-cycle" \
    --every "30m" --agent research --model "$RESEARCH_MODEL" --session isolated \
    $RESEARCH_CRON_DELIVERY \
    --message "OVERLAP GUARD: First run openclaw cron list --json to find the research-cycle job ID, then run openclaw cron runs --id <that-id> --limit 5. The output has an entries array. Skip the most recent entry (that is you). If any other entry has action other than finished, reply HEARTBEAT_SKIP and stop. Otherwise proceed. — Read HEARTBEAT.md. Check heartbeat state: node scripts/db-query.js get-heartbeat --agent research. Run the most overdue check. If the check produces discoveries, run the FULL pipeline autonomously: analysis, risk assessment, trade proposal. Do not stop after scanning — you decide what to buy. Update timestamps via db-query.js. Log results to daily memory and database (add-research-log). ALWAYS end with a short work summary: what check ran, what was found, counts (scanned/analyzed/proposed)."

  # --- Observer cycle (cron-based, replaces background loop) ---
  if [ -n "${OBSERVER_ISSUES_REPO:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
    OBSERVER_CRON_DELIVERY="--no-deliver"
    if [ -n "${TG_TOPIC_OBSERVER:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
      OBSERVER_CRON_DELIVERY="--announce --channel telegram --to ${TELEGRAM_CHAT_ID}:topic:${TG_TOPIC_OBSERVER}"
    fi

    add_if_missing "observer-cycle" \
      --every "120m" --agent observer --model "$OBSERVER_MODEL" --session isolated \
      $OBSERVER_CRON_DELIVERY \
      --message "OVERLAP GUARD: First run openclaw cron list --json to find the observer-cycle job ID, then run openclaw cron runs --id <that-id> --limit 5. The output has an entries array. Skip the most recent entry (that is you). If any other entry has action other than finished, reply HEARTBEAT_SKIP and stop. Otherwise proceed. — Read HEARTBEAT.md. Run the triage skill now: read system logs, query DB for failures, analyze, and take action (create issues or send alerts). Check heartbeat state: node scripts/db-query.js get-heartbeat --agent observer. Update heartbeat when done. If nothing to report, reply HEARTBEAT_OK."
  else
    echo "[cron-setup] Observer skipped — OBSERVER_ISSUES_REPO or GH_TOKEN not set"
  fi

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
# 5e2. Smart-money activity background loop
#      Runs activity-wallets-bg.js every 30 minutes. Polls a
#      rotating slice of 10 smart_money wallets for recent swaps
#      and writes per-swap rows to smart_money_signals (24 h
#      retention, pruned each cycle). Research and Sentinel read
#      the table via db-query.js get-smart-money-signals.
# ============================================================
run_activity_wallets_loop() {
  sleep 180  # wait for startup + first scoring cycle
  while true; do
    SAFE_ID="$SAFE_ID" DB_PATH="$DB_PATH" \
      node "$RESEARCH_WS/scripts/activity-wallets-bg.js" 2>&1 | \
      sed 's/^/[activity-wallets-bg] /'
    sleep 1800  # 30 minutes
  done
}

# ============================================================
# 5f. Multisig transaction tracker (real mode only)
#     Monitors queued Safe/Squads transactions every 5 minutes.
#     Confirms or reverts draft/pending_exit positions.
#     No LLM needed — deterministic script.
# ============================================================

run_multisig_tracker_loop() {
  if [ "${PAPER_MODE:-false}" = "true" ]; then
    return  # paper mode has no multisig transactions
  fi
  sleep 120  # wait for startup
  while true; do
    SAFE_ID="$SAFE_ID" DB_PATH="$DB_PATH" \
      node "$EXECUTOR_WS/scripts/track-multisig.js" 2>&1 | \
      sed 's/^/[multisig-tracker] /'
    sleep 300  # 5 minutes
  done
}

# ============================================================
# 5g. Executor background loop
#     Pre-checks DB for pending orders before invoking the agent.
#     Includes model fallback and emergency mode on repeated failures.
# ============================================================

# Build executor inline message (on-demand heartbeat — reads HEARTBEAT.md for details)
EXECUTOR_MSG="Read HEARTBEAT.md. Process all pending orders now. Check heartbeat state: node scripts/db-query.js get-heartbeat --agent executor. Update heartbeat when done. If nothing pending, reply HEARTBEAT_OK."

run_executor_loop() {
  sleep 30  # wait for gateway + agent registration
  local failures=0

  while true; do
    SKIP=$(SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
      node "$RESEARCH_WS/scripts/heartbeat-check.js" --agent executor 2>/dev/null \
      | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).skip)}catch{console.log('true')}})")
    if [ "$SKIP" != "true" ]; then
      echo "[executor-loop] Work found, triggering executor agent"
      openclaw agent --agent executor --session-id "executor-$(date +%s)" --message "$EXECUTOR_MSG" \
        2>&1 | sed 's/^/[executor] /'
      local exit_code=${PIPESTATUS[0]}

      if [ $exit_code -ne 0 ]; then
        failures=$((failures + 1))
        echo "[executor-loop] Agent failed (consecutive failures: $failures)"
        echo "[$(date -u +%FT%TZ)] [error] [executor-loop] Agent failed (consecutive failures: $failures)" >> /tmp/openclaw/system.log
        SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
          node "$RESEARCH_WS/scripts/send-alert.js" --type model_failure --agent executor \
          --message "Executor agent failed (attempt $failures)" 2>/dev/null || true

        # Try fallback model if configured
        if [ -n "$EXECUTOR_MODEL_FALLBACK" ]; then
          echo "[executor-loop] Trying fallback model: $EXECUTOR_MODEL_FALLBACK"
          openclaw config set "agents.list[3].model" "$EXECUTOR_MODEL_FALLBACK" 2>/dev/null || true
          openclaw agent --agent executor --session-id "executor-fallback-$(date +%s)" --message "$EXECUTOR_MSG" \
            2>&1 | sed 's/^/[executor-fallback] /'
          exit_code=${PIPESTATUS[0]}
          # Restore original model
          openclaw config set "agents.list[3].model" "$EXECUTOR_MODEL" 2>/dev/null || true

          if [ $exit_code -eq 0 ]; then
            failures=0
          fi
        fi

        # Emergency mode after EMERGENCY_AFTER consecutive failures
        if [ $failures -ge "$EMERGENCY_AFTER" ]; then
          echo "[executor-loop] EMERGENCY MODE — all models failed ($failures consecutive)"
          echo "[$(date -u +%FT%TZ)] [critical] [executor-loop] Emergency mode activated after $failures consecutive failures" >> /tmp/openclaw/system.log
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/emergency-executor.js" 2>&1 | sed 's/^/[emergency-executor] /'
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/send-alert.js" --type emergency_mode --agent executor \
            --message "Executor in emergency mode. Script-only sell execution active." 2>/dev/null || true
        fi
      else
        if [ $failures -gt 0 ]; then
          echo "[executor-loop] Recovered after $failures failures"
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/send-alert.js" --type recovered --agent executor \
            --message "Executor recovered after $failures consecutive failures" 2>/dev/null || true
        fi
        failures=0
      fi
    fi
    sleep 60
  done
}

# ============================================================
# 5g. Sentinel background loop
#     Pre-checks DB for open positions before invoking the agent.
#     Includes model fallback and emergency mode on first failure.
#     Sentinel activates emergency after 1 failure (positions can't wait).
# ============================================================

# Build sentinel inline message (on-demand heartbeat — reads HEARTBEAT.md for details)
SENTINEL_MSG="Read HEARTBEAT.md. Run all monitoring checks on open positions now. Check heartbeat state: node scripts/db-query.js get-heartbeat --agent sentinel. Update heartbeat when done. If nothing to report, reply HEARTBEAT_OK."

run_sentinel_loop() {
  sleep 60  # wait for gateway + agent registration
  local failures=0

  while true; do
    SKIP=$(SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
      node "$RESEARCH_WS/scripts/heartbeat-check.js" --agent sentinel 2>/dev/null \
      | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).skip)}catch{console.log('true')}})")
    if [ "$SKIP" != "true" ]; then
      echo "[sentinel-loop] Work found, triggering sentinel agent"
      openclaw agent --agent sentinel --session-id "sentinel-$(date +%s)" --message "$SENTINEL_MSG" \
        2>&1 | sed 's/^/[sentinel] /'
      local exit_code=${PIPESTATUS[0]}

      if [ $exit_code -ne 0 ]; then
        failures=$((failures + 1))
        echo "[sentinel-loop] Agent failed (consecutive failures: $failures)"
        echo "[$(date -u +%FT%TZ)] [error] [sentinel-loop] Agent failed (consecutive failures: $failures)" >> /tmp/openclaw/system.log
        SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
          node "$RESEARCH_WS/scripts/send-alert.js" --type model_failure --agent sentinel \
          --message "Sentinel agent failed (attempt $failures)" 2>/dev/null || true

        # Immediately try fallback model (if configured)
        if [ -n "$SENTINEL_MODEL_FALLBACK" ]; then
          echo "[sentinel-loop] Trying fallback model: $SENTINEL_MODEL_FALLBACK"
          openclaw config set "agents.list[2].model" "$SENTINEL_MODEL_FALLBACK" 2>/dev/null || true
          openclaw agent --agent sentinel --session-id "sentinel-fallback-$(date +%s)" --message "$SENTINEL_MSG" \
            2>&1 | sed 's/^/[sentinel-fallback] /'
          exit_code=${PIPESTATUS[0]}
          # Restore original model for next cycle
          openclaw config set "agents.list[2].model" "$SENTINEL_MODEL" 2>/dev/null || true

          if [ $exit_code -eq 0 ]; then
            failures=0
          fi
        fi

        # If fallback also failed (or not configured) → emergency mode immediately
        if [ $exit_code -ne 0 ]; then
          echo "[sentinel-loop] EMERGENCY MODE — all models failed"
          echo "[$(date -u +%FT%TZ)] [critical] [sentinel-loop] Emergency mode activated — all models failed" >> /tmp/openclaw/system.log
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/emergency-sentinel.js" 2>&1 | sed 's/^/[emergency-sentinel] /'
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/send-alert.js" --type emergency_mode --agent sentinel \
            --message "Sentinel in emergency mode. Script-only position protection active." 2>/dev/null || true
        fi
      else
        if [ $failures -gt 0 ]; then
          echo "[sentinel-loop] Recovered after $failures failures"
          SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
            node "$RESEARCH_WS/scripts/send-alert.js" --type recovered --agent sentinel \
            --message "Sentinel recovered after $failures consecutive failures" 2>/dev/null || true
        fi
        failures=0
      fi
    fi
    sleep 900  # 15 minutes
  done
}

# ============================================================
# 5h. Portfolio daily report loop
#     Posts a portfolio summary to the Portfolio topic once per day.
#     Only runs if TELEGRAM_CHAT_ID and TG_TOPIC_PORTFOLIO are set.
# ============================================================

PORTFOLIO_REPORT_HOUR=${PORTFOLIO_REPORT_HOUR:-0}  # UTC hour (0 = midnight)

run_portfolio_report_loop() {
  if [ -z "${TELEGRAM_CHAT_ID:-}" ] || [ -z "${TG_TOPIC_PORTFOLIO:-}" ]; then
    echo "[portfolio-report] Skipped — TG_TOPIC_PORTFOLIO or TELEGRAM_CHAT_ID not set"
    return
  fi
  sleep 120  # wait for gateway + DB initialization
  local last_report_day=""

  while true; do
    CURRENT_HOUR=$(date -u +%H)
    CURRENT_DAY=$(date -u +%Y-%m-%d)
    if [ "$CURRENT_HOUR" = "$(printf '%02d' $PORTFOLIO_REPORT_HOUR)" ] && [ "$CURRENT_DAY" != "$last_report_day" ]; then
      echo "[portfolio-report] Generating daily portfolio report..."
      SUMMARY=$(SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
        node "$RESEARCH_WS/scripts/portfolio-summary.js" 2>/dev/null || echo 'Portfolio summary unavailable')
      # Escape dollar signs so they survive shell expansion in the --message argument
      SAFE_SUMMARY=$(printf '%s' "$SUMMARY" | sed 's/\$/\\$/g')
      SAFE_ID="$SAFE_ID" PAPER_MODE="$PAPER_MODE" DB_PATH="$DB_PATH" \
        node "$RESEARCH_WS/scripts/send-alert.js" --type portfolio_daily --agent system \
        --message "$SAFE_SUMMARY" 2>/dev/null || true
      last_report_day="$CURRENT_DAY"
      echo "[portfolio-report] Daily report sent"
    fi
    sleep 1800  # check every 30 minutes
  done
}

# ============================================================
# 5h. Telegram approval bot (optional — requires separate bot token)
#     Long-polls getUpdates for callback_query (inline button presses).
#     Handles Approve/Reject for pending buy trade proposals.
# ============================================================

run_approval_bot() {
  if [ "${ENABLE_CHANNELS:-false}" != "true" ]; then
    return  # channels disabled — Telegram bot has nothing to deliver
  fi
  if [ -z "${TELEGRAM_APPROVAL_BOT_TOKEN:-}" ]; then
    return  # approval bot not configured — skip silently
  fi
  if [ -z "${TELEGRAM_OWNER_ID:-}" ]; then
    echo "[approval-bot] Skipped — TELEGRAM_OWNER_ID required for button approval"
    return
  fi
  sleep 30  # wait for gateway + DB initialization
  echo "[approval-bot] Starting Telegram approval bot..."
  while true; do
    SAFE_ID="$SAFE_ID" DB_PATH="$DB_PATH" \
      TELEGRAM_APPROVAL_BOT_TOKEN="$TELEGRAM_APPROVAL_BOT_TOKEN" \
      TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}" \
      TELEGRAM_OWNER_ID="${TELEGRAM_OWNER_ID:-}" \
      TG_TOPIC_APPROVALS="${TG_TOPIC_APPROVALS:-}" \
      TG_TOPIC_RESEARCH="${TG_TOPIC_RESEARCH:-}" \
      node "$RESEARCH_WS/scripts/approval-bot.js" 2>&1 | \
      sed 's/^/[approval-bot] /'
    echo "[approval-bot] Process exited, restarting in 5s..."
    sleep 5
  done
}

# ============================================================
# 6. Start OpenClaw gateway
#    Launch cron setup, memory backup, wallet scoring, executor
#    loop, sentinel loop, portfolio report, and approval bot in
#    background, then exec the gateway as PID 1.
# ============================================================
echo "[entrypoint] Starting OpenClaw gateway..."
run_memory_backup_loop &
run_wallet_scoring_loop &
run_activity_wallets_loop &
run_multisig_tracker_loop &
run_executor_loop &
run_sentinel_loop &
run_portfolio_report_loop &
run_approval_bot &
ensure_cron_jobs &

# Ensure Node.js heap limit is set for the gateway process (default V8 limit is ~2GB).
# Set explicitly here in case NODE_OPTIONS from docker-compose.yml is not inherited
# by the openclaw binary's embedded Node.js runtime.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
exec openclaw gateway run --port "$GATEWAY_PORT"
