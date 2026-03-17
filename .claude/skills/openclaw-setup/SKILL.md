---
name: openclaw-setup
description: "OpenClaw setup, installation, configuration, and deployment guide. Use this skill whenever the user mentions setting up OpenClaw, creating a new agent, configuring openclaw.json, workspace creation, agent registration, gateway setup, model providers (OpenAI, Anthropic, Ollama Cloud), creating SOUL.md/AGENTS.md/USER.md/HEARTBEAT.md, multi-agent systems, heartbeat configuration, skill creation, tool permissions, Docker deployment, bare-metal setup, entrypoint configuration, first-run onboarding, or deploying an agent system on OpenClaw."
---

# OpenClaw Setup Skill

You are helping a user set up, configure, and deploy agents on OpenClaw. OpenClaw is a file-based agent platform — agents are defined by workspace files + skills + scripts, not code. Configuration lives in `openclaw.json`. Your job is to guide users through the full setup process interactively.

## Core Principle

**Agents are files.** There is no agent "code" to write. An OpenClaw agent is:
1. A directory with workspace files (SOUL.md, AGENTS.md, USER.md, etc.)
2. Skills (subdirectories with SKILL.md files)
3. Scripts (tools the agent can execute)
4. Configuration in `openclaw.json`

Everything the agent knows, does, and is comes from these files. If you want the agent to behave differently, you edit the files.

## Two Deployment Paths

### Docker (Recommended for production)
- Single container runs gateway + all agents
- Persistent volumes for memory, data, and state
- `docker-compose.yml` defines the full stack
- `entrypoint.sh` syncs templates, registers agents, starts gateway
- Best for: always-on deployments, multi-agent systems, reproducible setups

### Bare-Metal (Development / single-machine)
- `setup.sh` deploys agents into `~/.openclaw/` directory structure
- Manual gateway start via `openclaw` CLI
- Cron jobs for background tasks (memory backup, background tasks)
- Best for: local development, testing, single-agent setups

## Workspace File Architecture

Every agent workspace can contain these bootstrap files. They are loaded into the agent's context at session start and survive compaction (because they're reloaded from disk each turn).

| File | Required | Purpose | What Goes Here |
|------|----------|---------|----------------|
| `AGENTS.md` | **Yes** | Operating contract | Workflow rules, pipeline stages, tool conventions, safety rules, memory protocol, do/don't lists |
| `SOUL.md` | **Yes** | Identity & personality | Tone, values, persona, communication style, quirks |
| `USER.md` | Recommended | Operator profile | Who the human is, their preferences, priorities, timezone, experience level |
| `MEMORY.md` | Recommended | Cross-session truth | Learned patterns, important decisions, calibration data, rules from past mistakes |
| `TOOLS.md` | If scripts exist | Tool documentation | How to use each script, CLI flags, expected output format, API keys needed |
| `IDENTITY.md` | Optional | Extended identity | Agent name, emoji, theme, description (used by gateway for display) |
| `HEARTBEAT.md` | If periodic | Heartbeat rules | Schedule of rotating checks, cadence, active hours, what to do per check |
| `BOOT.md` | Optional | First-run checklist | One-time setup tasks, deleted after completion |
| `BOOTSTRAP.md` | Optional | Extra bootstrap config | Additional startup instructions beyond AGENTS.md |

**Key rules:**
- `AGENTS.md` is the most important file. It defines what the agent does and how.
- `SOUL.md` defines character. `AGENTS.md` defines process. Keep them separate.
- Sub-agents (spawned via `sessions_spawn`) only receive `AGENTS.md` and `TOOLS.md` — other bootstrap files are filtered out.
- Per-file character limit: 20,000 (default). Combined limit: 150,000 across all bootstrap files (~50K tokens).
- Files exceeding the limit are truncated: 70% head, 20% tail, 10% truncation marker.
- `MEMORY.md` should stay under 100 lines — it's a cheat sheet, not a journal. It's always loaded, always in context, expensive in tokens and attention.
- Never store API keys, tokens, or secrets in workspace files.

For starter templates of each file, refer to `references/workspace-templates.md`.

## Agent Registration

Agents are registered with the OpenClaw gateway. Each agent gets:
- A workspace directory (`workspace/`) containing all bootstrap files, skills, and scripts
- An agent state directory (`agent/`) for auth, sessions — managed by OpenClaw
- Optional: a data directory for databases or other persistent storage

### Directory Structure

```
~/.openclaw/
  .openclaw/              # Gateway state (config, registrations, cron, pairing)
  agents/
    <agent-name>/
      workspace/          # Bootstrap files, skills, scripts — the agent sees this
        AGENTS.md
        SOUL.md
        USER.md
        MEMORY.md
        TOOLS.md
        skills/           # Per-agent skills
          <skill-name>/
            SKILL.md
        scripts/          # Per-agent tools
          *.js
        memory/           # Daily log directory
          YYYY-MM-DD.md
      agent/              # OpenClaw-managed state (auth, sessions)
      data/               # Optional: databases, caches
```

### Per-Agent Configuration

Each agent can have different:
- **Model** — set via environment variables (e.g., `AGENT_MODEL=openai/gpt-5-mini`)
- **Scripts** — deploy only the scripts each agent needs (least privilege)
- **Skills** — each agent only sees skills in its own `workspace/skills/` directory
- **Tools/permissions** — configured via `openclaw.json` agent overrides or entrypoint

The pattern for per-agent overrides in entrypoint:
```bash
# Register agent with workspace path, agent state dir, and model
openclaw agents add analyst \
  --workspace "$OPENCLAW_HOME/agents/analyst/workspace" \
  --agent-dir "$OPENCLAW_HOME/agents/analyst/agent" \
  --model "$ANALYST_MODEL" \
  --non-interactive

openclaw agents add monitor \
  --workspace "$OPENCLAW_HOME/agents/monitor/workspace" \
  --agent-dir "$OPENCLAW_HOME/agents/monitor/agent" \
  --model "$MONITOR_MODEL" \
  --non-interactive

openclaw agents add worker \
  --workspace "$OPENCLAW_HOME/agents/worker/workspace" \
  --agent-dir "$OPENCLAW_HOME/agents/worker/agent" \
  --model "$WORKER_MODEL" \
  --non-interactive
```

### Least Privilege for Scripts

Don't give every agent every script. Deploy only what each agent needs:
- **Primary agent**: all scripts (discovery, analysis, monitoring, db access)
- **Monitor agent**: monitoring and alerting scripts + db access
- **Worker agent**: execution scripts + db access

## openclaw.json Configuration

The gateway configuration file lives at `~/.openclaw/.openclaw/openclaw.json` (JSON5 format). It controls agent defaults, model providers, gateway settings, and memory search.

The essential sections are: `agents.defaults.compaction` (pre-compaction flush + reserve tokens), `agents.defaults.contextPruning` (tool result TTL), `agents.defaults.memorySearch` (hybrid search), `tools.exec` (script execution security — allowlist, safeBins, denied flags), `gateway` (mode, port, bind, auth via `gateway.auth.mode` + `gateway.auth.token`), and `agents.list[N]` for per-agent overrides (indexed: 0 = built-in main, 1+ = custom agents in registration order).

For a complete annotated reference with all fields and defaults, see `references/config-reference.md`. For ready-to-use config examples (Track A/A+/B, minimal), see `references/config-examples.md`.

## Model Provider Setup

OpenClaw supports multiple LLM providers. Configure them via environment variables.

### OpenAI
```bash
OPENAI_API_KEY=sk-...
AGENT_MODEL=openai/gpt-5-mini
```

### Anthropic
```bash
ANTHROPIC_API_KEY=sk-ant-...
AGENT_MODEL=anthropic/claude-sonnet-4-6
# Or for highest quality:
AGENT_MODEL=anthropic/claude-opus-4-6
```

### Ollama Cloud
No sidecar needed — OpenClaw's built-in Ollama provider sends `OLLAMA_API_KEY` as a Bearer token directly to `https://ollama.com/api/chat`.
```bash
OLLAMA_API_KEY=...
AGENT_MODEL=ollama/llama4-maverick
```

### Cost-Optimization Pattern: Cheap Model + Smart Sub-Agents

Run the main agent on a cheaper model (GPT-5-mini) and spawn expensive sub-agents only for tasks that need deep reasoning:

```bash
# Main agents: cheap and fast
AGENT_MODEL=openai/gpt-5-mini

# Sub-agents: smart and expensive (only spawned when needed)
SUBAGENT_MODEL=anthropic/claude-sonnet-4-6
```

The main agent handles routine tasks (data gathering, logging, DB queries) itself. For complex tasks (deep analysis, planning, evaluation), it spawns a sub-agent with `sessions_spawn --model $SUBAGENT_MODEL`.

## Gateway Configuration

The gateway is the HTTP server that connects messaging platforms to agents.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| Port | `OPENCLAW_GATEWAY_PORT` | `18789` | HTTP port for the gateway |
| Auth token | `OPENCLAW_GATEWAY_TOKEN` | (none) | Bearer token for API access |
| Bind mode | `OPENCLAW_GATEWAY_BIND` | `lan` | `local` (localhost only), `lan` (local network), `wan` (public) |

### Health Check
```bash
# HTTP health check
curl -sf http://localhost:18789/health

# CLI health check (used in entrypoint wait loops)
openclaw gateway health
```

### Security
- Use `local` bind for development, `lan` for Docker, `wan` only behind a reverse proxy
- Always set `OPENCLAW_GATEWAY_TOKEN` in production
- Never expose the gateway to the internet without auth

## Secrets & Configuration

All secrets and configuration should live in environment variables, never hardcoded in workspace files, scripts, or agent instructions. Use a `.env` file as the single source of truth.

### .env File

Create a `.env` file in your project root (and **never commit it**):
```bash
# .env — secrets and per-deployment config
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_API_KEY=...

AGENT_MODEL=openai/gpt-5-mini
SUBAGENT_MODEL=anthropic/claude-sonnet-4-6

OPENCLAW_GATEWAY_TOKEN=my-secret-token
OPENCLAW_GATEWAY_PORT=18789

# Project-specific
MY_API_KEY=...
DB_PATH=data/my-db.sqlite
```

### .env.example

Commit a `.env.example` with placeholder values so collaborators know what's needed:
```bash
# .env.example — copy to .env and fill in real values
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=
AGENT_MODEL=openai/gpt-5-mini
SUBAGENT_MODEL=anthropic/claude-sonnet-4-6
OPENCLAW_GATEWAY_TOKEN=
MY_API_KEY=
DB_PATH=data/my-db.sqlite
```

### Docker: env_file

Pass the `.env` file to your container — don't bake secrets into the image:
```yaml
# docker-compose.yml
services:
  my-agent:
    image: my-agent:latest
    env_file: .env
    # Or pass individual vars:
    environment:
      - AGENT_MODEL=${AGENT_MODEL}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
```

### Bare-Metal: dotenv or Shell Export

Scripts can load `.env` via `dotenv` (Node.js) or source it in your shell:
```bash
# Option 1: dotenv in scripts (Node.js)
import 'dotenv/config';
const apiKey = process.env.MY_API_KEY;

# Option 2: source in shell before running
set -a; source .env; set +a
openclaw start
```

### Rules

| Do | Don't |
|----|-------|
| Store secrets in `.env` | Hardcode keys in scripts or workspace files |
| Add `.env` to `.gitignore` | Commit `.env` to version control |
| Commit `.env.example` with placeholders | Put real values in `.env.example` |
| Read secrets via `process.env` in scripts | Pass secrets as CLI arguments (visible in `ps`) |
| Use `env_file` in docker-compose | Use `COPY .env` in Dockerfile |
| Rotate keys if accidentally exposed | Assume a leaked key is still safe |

### Accessing Config in Agent Scripts

Scripts should always read configuration from environment variables:
```javascript
// Good — reads from environment
const apiKey = process.env.MY_API_KEY;
if (!apiKey) {
  console.error(JSON.stringify({ error: 'MY_API_KEY not set' }));
  process.exit(1);
}

// Bad — hardcoded
const apiKey = 'sk-abc123...';
```

### Agent Instructions

If an agent needs to know about available config, document the env var **names** (not values) in TOOLS.md:
```markdown
## Environment Variables
- `MY_API_KEY` — required for data-source.js
- `DB_PATH` — path to SQLite database (default: data/my-db.sqlite)
```

Never put actual secret values in AGENTS.md, SOUL.md, MEMORY.md, or any workspace file.

## Multi-Agent Patterns

When building systems with multiple agents that need to coordinate:

### Shared Workspace Files via Symlinks
Agents that need the same TOOLS.md or IDENTITY.md can share them via symlinks:
```bash
# Helper agents get symlinks to primary agent's copy
ln -sf "$PRIMARY_DIR/workspace/TOOLS.md" "$AGENT2_DIR/workspace/TOOLS.md"
ln -sf "$PRIMARY_DIR/workspace/IDENTITY.md" "$AGENT3_DIR/workspace/IDENTITY.md"
```

### Shared Memory via Symlinks
All agents can read/write the same daily memory logs:
```bash
# Helper agent memory dirs point to primary agent's
ln -sf "$PRIMARY_DIR/workspace/memory" "$AGENT2_DIR/workspace/memory"
ln -sf "$PRIMARY_DIR/workspace/memory" "$AGENT3_DIR/workspace/memory"
```

### Shared Database
Multiple agents can access the same SQLite database (WAL mode enables concurrent reads):
```bash
# Symlink data directory to all agents
ln -sf "$PRIMARY_DIR/data" "$AGENT2_DIR/data"
ln -sf "$PRIMARY_DIR/data" "$AGENT3_DIR/data"
```

### Skill Isolation
Each agent only sees skills in its own `workspace/skills/` directory. This prevents a worker agent from accidentally running discovery logic.

### Communication via Database
Agents communicate through shared database tables, not direct messages:
```
Agent A → tasks table   → Agent B reads and executes
Agent B → results table → Agent A reads for awareness
Agent C → alerts table  → Agent B reads and acts on
```

## Skills & Heartbeats

### Creating a Skill

A skill is a subdirectory under `workspace/skills/` with a `SKILL.md` file:

```
workspace/skills/
  my-skill/
    SKILL.md        # Skill instructions (loaded when skill activates)
    references/     # Optional: additional reference files
```

SKILL.md format:
```markdown
---
name: my-skill
description: "When to activate this skill — be specific about triggers"
---

# My Skill

Instructions for the agent when this skill is active.
Include: what to do, step-by-step process, expected outputs, error handling.
```

### Heartbeat Configuration

Heartbeats are periodic check-ins. Configure them in `HEARTBEAT.md`:

1. Define a schedule (which checks, how often, active hours)
2. Use a rotating check pattern (one check per heartbeat, most overdue first)
3. Track last-run timestamps in a state file or database
4. Define what each check does and what happens with results

There are two ways to schedule periodic agent runs:

**Option A: Built-in heartbeat** — set via config after registration:
```bash
# Register agents first (see Agent Registration section for full flags)
# openclaw agents add analyst --workspace ... --agent-dir ... --model "$AGENT_MODEL" --non-interactive
# openclaw agents add monitor --workspace ... --agent-dir ... --model "$AGENT_MODEL" --non-interactive

# Then configure heartbeat intervals
openclaw config set 'agents.list[1].heartbeat' '{"every":"30m"}' --strict-json
openclaw config set 'agents.list[2].heartbeat' '{"every":"10m"}' --strict-json
```

**Option B: Cron jobs** (preferred for control — custom messages, model overrides, session isolation):
```bash
# Disable built-in heartbeats
openclaw config set 'agents.list[1].heartbeat' '{"every":"0m"}' --strict-json

# Use cron with explicit message and model
openclaw cron add --name "analyst-cycle" \
  --every "30m" --agent analyst --model "$AGENT_MODEL" \
  --session isolated --no-deliver \
  --message "Read HEARTBEAT.md. Run the most overdue check."

openclaw cron add --name "monitor-cycle" \
  --every "10m" --agent monitor --model "$AGENT_MODEL" \
  --session isolated --no-deliver \
  --message "Read HEARTBEAT.md. Run all monitoring checks."
```

**Option C: Background shell loops** (best for pre-check gating — skip the agent if there's nothing to do):
```bash
run_monitor_loop() {
  sleep 60  # wait for gateway + agent registration
  while true; do
    # Pre-check: only invoke agent if there's work
    SKIP=$(node scripts/pre-check.js 2>/dev/null | node -e "
      process.stdin.on('data',d=>{try{console.log(JSON.parse(d).skip)}catch{console.log('true')}})")
    if [ "$SKIP" != "true" ]; then
      openclaw agent --agent monitor --session-id "monitor-$(date +%s)" \
        --message "Read HEARTBEAT.md. Run monitoring checks."
    fi
    sleep 600  # 10 minutes
  done
}
run_monitor_loop &
```

## Interactive Setup Checklist

When helping a user set up OpenClaw from scratch, walk through these decisions:

### 1. What's your use case?
- Single assistant (personal agent)
- Multi-agent system (specialized agents coordinating)
- Autonomous pipeline (agents running on heartbeats, minimal human intervention)

### 2. How many agents?
- Single agent: simplest setup, one workspace directory
- Multi-agent: plan the responsibility split, communication pattern, shared vs isolated resources

### 3. Which models?
- Budget: GPT-5-mini for everything
- Balanced: GPT-5-mini main + Sonnet sub-agents for complex tasks
- Quality: Sonnet or Opus for main agents
- Open-source: Ollama Cloud models

### 4. Docker or bare-metal?
- Docker: production-ready, handles volumes/networking/restarts
- Bare-metal: simpler for development, manual process management

### 5. Paper mode?
- If the system makes decisions with real consequences (trades, deployments, emails), start with paper mode to validate behavior before going live

### 6. Which external APIs/integrations?
- What data sources does the agent need?
- What actions should it be able to take?
- Build scripts for each, document in TOOLS.md

### 7. Memory strategy
- Enable memory flush in `openclaw.json`
- Add memory protocol to AGENTS.md
- Set up git backup for workspace
- See the `openclaw-memory` skill for detailed memory configuration

## Common Pitfalls

### File Permissions (Docker)
- Docker runs as non-root (UID 1000). All workspace files must be owned by 1000:1000.
- Use `COPY --chown=1000:1000` in Dockerfile.
- Volumes inherit ownership from the directory they mount on — pre-create directories as UID 1000.

### ESM Modules
- Node.js scripts use ESM (`import`), not CommonJS (`require`).
- `package.json` must have `"type": "module"`.
- File extensions matter: use `.js` with ESM-compatible syntax.

### Symlink Gotchas
- Symlinks in Docker tmpfs mounts need the target to exist first.
- Entrypoint must create symlinks after volumes are mounted, not during build.
- Test symlinks resolve correctly inside the container.

### Key Exposure
- **NEVER** put private keys, API keys, or tokens in workspace files, bootstrap files, memory, or logs.
- Keys belong in environment variables via `.env` files only. See the **Secrets & Configuration** section above.
- If an agent writes a key to a file accidentally, treat it as compromised — rotate immediately.

### Bootstrap File Limits
- Files over 20,000 characters get truncated silently.
- If an agent seems to ignore rules at the bottom of AGENTS.md, the file may be truncated.
- Use `/context list` to verify what's actually loaded.

### Missing Memory Protocol
- Without a memory protocol in AGENTS.md, the agent won't search memory before acting.
- This is the #1 cause of agents "forgetting" things — they never looked.

### Read-Only Container
- Production Docker containers should be `read_only: true` with explicit tmpfs/volume mounts.
- Helper agent workspaces can be tmpfs (repopulated from templates each start).
- Primary agent workspace needs a persistent volume (contains memory and learned patterns).

### Script Dependencies
- Install `node_modules` once, symlink to other agents.
- Native modules (better-sqlite3) need `npm rebuild` when moving between platforms.
- Docker: install deps during build, not at runtime.

## Verification Steps

After setup, verify everything works:

### 1. Gateway Health
```bash
curl -sf http://localhost:18789/health
# Should return 200 OK
```

### 2. Agent List
```bash
openclaw agents list
# Should show all registered agents with correct models

# Machine-readable output (used for idempotent re-registration checks)
openclaw agents list --json
```

### 3. Test Message
Send a test message to each agent through the gateway or messaging platform. Verify:
- Agent responds
- Bootstrap files are loaded (ask "what files are in your workspace?")
- Skills are available (ask "what skills do you have?")

### 4. Memory Search Test
```bash
# In agent conversation:
# "Search your memory for [topic]"
# Should return results if memory files exist
```

### 5. Script Execution
```bash
# Test a simple script through the agent:
# "Run: node scripts/my-script.js"
# Should return valid JSON
```

### 6. Tool Validation
```bash
# Test a script directly:
node scripts/my-script.js --test
# Should return expected output
```

### 7. Docker-Specific
```bash
docker compose up -d
docker compose logs -f          # Watch for startup errors
docker compose exec my-agent openclaw agents list
```

## Deployment Reference

For detailed step-by-step deployment instructions (Dockerfile patterns, docker-compose.yml, entrypoint.sh, setup.sh, environment variables), see `references/deployment-guide.md`.

## What This Skill Does NOT Cover

- **Memory management, diagnostics, and optimization** — use the `openclaw-memory` skill for compaction tuning, flush configuration, memory debugging, and context loss issues.
- **Agent logic and behavior** — this skill covers infrastructure/setup, not what your agent should think or do.
- **External integrations** — API-specific setup depends on your use case.
