# OpenClaw Deployment Guide

Step-by-step instructions for both Docker and bare-metal deployment paths.

---

## Docker Deployment

### 1. Dockerfile Pattern

```dockerfile
FROM ghcr.io/openclaw/openclaw:latest

# Install extra tools if needed (agent runs as non-root, install as root)
USER root
RUN apt-get update -qq && apt-get install -y -qq jq > /dev/null 2>&1 && rm -rf /var/lib/apt/lists/*

# Run as non-root (UID 1000) for security
USER 1000:1000

ENV OPENCLAW_HOME=/home/openclaw/.openclaw
WORKDIR /home/openclaw

# Copy your project files
COPY --chown=1000:1000 . /home/openclaw/my-project

# Install script dependencies during build (not at runtime)
RUN cd /home/openclaw/my-project/scripts && npm install --omit=dev && npm rebuild

# Create agent directories matching OpenClaw's expected structure
RUN mkdir -p \
  ${OPENCLAW_HOME}/agents/my-agent/workspace/memory \
  ${OPENCLAW_HOME}/agents/my-agent/workspace/skills \
  ${OPENCLAW_HOME}/agents/my-agent/workspace/scripts \
  ${OPENCLAW_HOME}/agents/my-agent/agent

# Build workspace templates (for multi-agent: create per-agent template dirs)
RUN chmod +x /home/openclaw/my-project/build-templates.sh && \
    /home/openclaw/my-project/build-templates.sh

# Pre-create OpenClaw state dir (volumes inherit UID 1000 ownership)
RUN mkdir -p ${OPENCLAW_HOME}/.openclaw

# Entrypoint: syncs templates, registers agents, starts gateway
COPY --chown=1000:1000 entrypoint.sh /home/openclaw/entrypoint.sh
RUN chmod +x /home/openclaw/entrypoint.sh

EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/health || exit 1

ENTRYPOINT ["/home/openclaw/entrypoint.sh"]
```

### 2. docker-compose.yml Pattern

```yaml
services:
  my-agent:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: my-agent
    restart: unless-stopped

    # Security hardening
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true

    # Writable directories
    tmpfs:
      - /tmp:size=100M
      # Agent workspaces that can be rebuilt from templates → tmpfs
      - /home/openclaw/.openclaw/agents/helper/workspace:size=50M,uid=1000,gid=1000,exec
    volumes:
      # Persistent: primary agent workspace (memory, learned patterns)
      - agent-memory:/home/openclaw/.openclaw/agents/primary/workspace
      # Persistent: data (databases)
      - agent-data:/home/openclaw/.openclaw/agents/primary/data
      # Persistent: OpenClaw state (config, registrations, cron)
      - agent-state:/home/openclaw/.openclaw/.openclaw
      # Persistent: agent auth/sessions
      - agent-auth:/home/openclaw/.openclaw/agents/primary/agent

    ports:
      - "${OPENCLAW_GATEWAY_PORT:-18789}:${OPENCLAW_GATEWAY_PORT:-18789}"

    environment:
      # Model provider (pick one or more)
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - OLLAMA_API_KEY=${OLLAMA_API_KEY:-}

      # Agent models
      - AGENT_MODEL=${AGENT_MODEL:-openai/gpt-5-mini}

      # Gateway
      - OPENCLAW_HOME=/home/openclaw/.openclaw
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-}
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND:-lan}

      - NODE_ENV=production

    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 8G
        reservations:
          cpus: "1.0"
          memory: 2G

volumes:
  agent-memory:
    driver: local
  agent-data:
    driver: local
  agent-state:
    driver: local
  agent-auth:
    driver: local
```

### 3. entrypoint.sh Pattern

```bash
#!/bin/bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/home/openclaw/.openclaw}"
SRC="/home/openclaw/my-project"
TEMPLATES="/home/openclaw/workspace-templates"

echo "[entrypoint] Starting agent setup..."

# ---- Sync workspace templates ----
# Primary agent: sync code-owned files, preserve user-owned files
for file in AGENTS.md SOUL.md HEARTBEAT.md TOOLS.md IDENTITY.md BOOT.md; do
  if [ -f "$TEMPLATES/$file" ]; then
    cp "$TEMPLATES/$file" "$OPENCLAW_HOME/agents/primary/workspace/$file"
  fi
done

# Preserve USER.md and MEMORY.md (user-owned — don't overwrite)
for file in USER.md MEMORY.md; do
  if [ ! -f "$OPENCLAW_HOME/agents/primary/workspace/$file" ] && [ -f "$TEMPLATES/$file" ]; then
    cp "$TEMPLATES/$file" "$OPENCLAW_HOME/agents/primary/workspace/$file"
  fi
done

# Sync skills
cp -r "$SRC/agents/primary/skills/"* "$OPENCLAW_HOME/agents/primary/workspace/skills/" 2>/dev/null || true

# Sync scripts
cp "$SRC/scripts/"*.js "$OPENCLAW_HOME/agents/primary/workspace/scripts/"
cp "$SRC/scripts/package.json" "$OPENCLAW_HOME/agents/primary/workspace/scripts/"

# Symlink node_modules (installed during build)
ln -sfn "$SRC/scripts/node_modules" "$OPENCLAW_HOME/agents/primary/workspace/scripts/node_modules"

# ---- Register agents ----
openclaw agents add primary --model "${AGENT_MODEL:-openai/gpt-5-mini}" --heartbeat "${HEARTBEAT_INTERVAL:-30m}"

# ---- Configure gateway ----
openclaw gateway config --port "${OPENCLAW_GATEWAY_PORT:-18789}" --bind "${OPENCLAW_GATEWAY_BIND:-lan}"

if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  openclaw gateway config --token "$OPENCLAW_GATEWAY_TOKEN"
fi

# ---- Start memory backup loop (optional) ----
if [ -n "${MEMORY_GIT_REMOTE:-}" ]; then
  (while true; do
    sleep 900  # 15 minutes
    cd "$OPENCLAW_HOME/agents/primary/workspace"
    git add -A && git commit -m "Auto-backup $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
    git push origin HEAD 2>/dev/null || true
  done) &
fi

echo "[entrypoint] Starting gateway..."
exec openclaw gateway start
```

### 4. Docker Commands

```bash
# Build and start
docker compose up -d

# Watch logs
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build

# Shell into container
docker compose exec my-agent bash

# Check agent status
docker compose exec my-agent openclaw agents list

# Paper mode
PAPER_MODE=true docker compose up -d
```

---

## Bare-Metal Deployment

### 1. setup.sh Pattern

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

echo "Setting up agent..."

# Create directories
AGENT_DIR="$OPENCLAW_HOME/agents/my-agent"
mkdir -p "$AGENT_DIR/workspace/memory"
mkdir -p "$AGENT_DIR/workspace/skills/my-skill"
mkdir -p "$AGENT_DIR/workspace/scripts"
mkdir -p "$AGENT_DIR/agent"

# Deploy workspace files (code-owned: always update)
cp "$SCRIPT_DIR/agents/my-agent/AGENTS.md"    "$AGENT_DIR/workspace/AGENTS.md"
cp "$SCRIPT_DIR/agents/my-agent/SOUL.md"      "$AGENT_DIR/workspace/SOUL.md"
cp "$SCRIPT_DIR/workspace/TOOLS.md"           "$AGENT_DIR/workspace/TOOLS.md"

# Deploy workspace files (user-owned: preserve on redeploy)
for file in USER.md MEMORY.md; do
  if [ ! -f "$AGENT_DIR/workspace/$file" ]; then
    cp "$SCRIPT_DIR/workspace/$file" "$AGENT_DIR/workspace/$file"
  else
    echo "  Skipping $file (already exists)"
  fi
done

# Deploy skills
cp "$SCRIPT_DIR/agents/my-agent/skills/my-skill/SKILL.md" \
   "$AGENT_DIR/workspace/skills/my-skill/SKILL.md"

# Deploy scripts
cp "$SCRIPT_DIR/scripts/"*.js "$AGENT_DIR/workspace/scripts/"
cp "$SCRIPT_DIR/scripts/package.json" "$AGENT_DIR/workspace/scripts/"

# Install dependencies
(cd "$AGENT_DIR/workspace/scripts" && npm install --production 2>/dev/null) || true

# Init git for memory backup
if [ ! -d "$AGENT_DIR/workspace/.git" ]; then
  cd "$AGENT_DIR/workspace"
  cat > .gitignore << 'EOF'
*
!.gitignore
!MEMORY.md
!memory/
!memory/*.md
EOF
  git init && git add -A && git commit -m "Initial agent memory"
fi

echo "Done! Agent workspace: $AGENT_DIR/workspace/"
echo "Next: edit USER.md, add API keys to .env, register agent"
```

### 2. Running the Gateway

```bash
# Start gateway (foreground)
openclaw gateway start

# Start gateway (background)
openclaw gateway start &

# Register agent
openclaw agents add my-agent --model openai/gpt-5-mini --heartbeat 30m

# Check status
openclaw agents list
curl -sf http://localhost:18789/health
```

### 3. Cron Jobs (Optional)

```bash
# Memory backup every 15 minutes
*/15 * * * * /path/to/scripts/memory-backup.sh /path/to/workspace >> /tmp/memory-backup.log 2>&1

# Background task every 10 minutes
*/10 * * * * cd /path/to/workspace && node scripts/background-task.js >> /tmp/background.log 2>&1
```

---

## Environment Variables Reference

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENCLAW_HOME` | No | `~/.openclaw` | OpenClaw root directory |
| `OPENCLAW_GATEWAY_PORT` | No | `18789` | Gateway HTTP port |
| `OPENCLAW_GATEWAY_TOKEN` | Prod | — | Bearer auth token |
| `OPENCLAW_GATEWAY_BIND` | No | `lan` | Network bind mode |

### Model Providers

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key |
| `ANTHROPIC_API_KEY` | If using Anthropic | Anthropic API key |
| `OLLAMA_API_KEY` | If using Ollama Cloud | Ollama Cloud API key |

### Agent Models

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MODEL` | `openai/gpt-5-mini` | Primary agent model |
| `SUBAGENT_MODEL` | — | Model for spawned sub-agents |

Model format: `provider/model-name` (e.g., `openai/gpt-5-mini`, `anthropic/claude-sonnet-4-6`, `ollama/llama4-maverick`)

### Application

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPER_MODE` | `false` | Enable simulated mode |
| `NODE_ENV` | — | `production` for Docker |
| `LOG_LEVEL` | `info` | Logging verbosity |

### Memory

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_GIT_REMOTE` | — | Git remote URL for memory backup push |

---

## Volume Strategy (Docker)

Decide what is **persistent** vs **ephemeral**:

| What | Persistent? | Why |
|------|-------------|-----|
| Primary agent workspace | **Yes** (volume) | Contains MEMORY.md, daily logs, learned patterns |
| Helper agent workspaces | No (tmpfs) | Rebuilt from templates each start |
| Agent state (auth/sessions) | **Yes** (volume) | Pairing tokens, session history |
| Data (databases) | **Yes** (volume) | Application data, must survive restarts |
| OpenClaw state | **Yes** (volume) | Gateway config, agent registrations, cron |
| /tmp | No (tmpfs) | Scratch space |

**Rule of thumb:** If losing it means losing knowledge or data, make it a volume. If it can be rebuilt from templates, use tmpfs.

---

## Security Checklist

- [ ] Container runs as non-root (UID 1000)
- [ ] `read_only: true` in docker-compose
- [ ] `cap_drop: ALL` — no extra Linux capabilities
- [ ] `no-new-privileges: true` — prevent privilege escalation
- [ ] Gateway token set in production
- [ ] Gateway bind is `local` or `lan` (never `wan` without reverse proxy)
- [ ] No private keys in workspace files, logs, or memory
- [ ] `.gitignore` excludes credentials and openclaw.json
- [ ] Volumes owned by UID 1000 (pre-create dirs in Dockerfile)
