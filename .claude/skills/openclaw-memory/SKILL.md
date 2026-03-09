---
name: openclaw-memory
description: "OpenClaw memory management, diagnostics, and optimization. Use this skill whenever the user mentions OpenClaw memory issues, context loss, compaction problems, agent forgetting things, MEMORY.md, AGENTS.md, SOUL.md, USER.md, bootstrap files, memory flush, pre-compaction flush, context window overflow, session pruning, memory_search, memory_get, QMD, daily memory logs, /context list, /compact command, openclaw.json configuration, reserveTokensFloor, or any situation where an OpenClaw agent is losing context, forgetting instructions, or behaving inconsistently across sessions. Also trigger when the user wants to set up, audit, or improve their OpenClaw workspace file structure."
---

# OpenClaw Memory Management Skill

You are helping a user manage, diagnose, and optimize memory in their OpenClaw agent. OpenClaw's memory system is file-based — if information isn't written to disk, it doesn't survive compaction or new sessions. Your job is to help users understand this, configure it properly, and build habits that prevent context loss.

## Core Principle

**If it's not written to a file, it doesn't exist.** Chat instructions do not survive long sessions. When compaction fires, anything only in conversation history gets summarized and the original wording is lost. Durable information must live in workspace files.

## The Four Memory Layers

When diagnosing memory issues, identify which layer failed:

1. **Bootstrap files** (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`) — loaded from disk at session start, survive compaction because they're reloaded from disk each turn. Most durable layer.
2. **Session transcript** — conversation saved on disk, but gets compacted (summarized) when context fills. The model loses access to original messages after compaction.
3. **LLM context window** — the ~200K token container where system prompt, workspace files, conversation history, and tool results all compete for space. When full, compaction fires.
4. **Retrieval index** — searchable layer beside memory files, queried via `memory_search` / `memory_get`. Only works if information was written to files first.

## Three Failure Modes

When diagnosing why an agent forgot something, check these in order:

- **Failure A (Never Stored):** The information only existed in chat, never written to a file. Most common cause. Fix: write it to `MEMORY.md` or a daily log.
- **Failure B (Compaction Loss):** Long session hit the token limit, compaction summary dropped important details. Fix: tune the pre-compaction flush config and use manual saves.
- **Failure C (Pruning Trimmed Tool Results):** Tool outputs (file reads, API responses) were trimmed by session pruning. Fix: save important tool results to files explicitly.

**Quick diagnostic:**
- Agent forgot a preference → Failure A (never in `MEMORY.md`)
- Agent forgot a whole conversation thread → Failure B (compaction/reset)
- Agent forgot what a tool returned → Failure C (pruning)

## Compaction vs. Pruning

These are different systems — help users understand the distinction:

- **Compaction** summarizes the entire conversation when the context window fills. It changes what the model sees. This is dangerous and causes most memory problems.
- **Pruning** trims old tool results in-memory. The on-disk session is untouched. Only affects tool result messages. User and assistant messages are never modified. Pruning is beneficial — it reduces bloat without destroying conversation context.

## Two Compaction Paths

- **Good path (maintenance):** Context nears limit → flush fires → agent saves important context to disk → compaction summarizes → agent continues. This is what configuration optimizes for.
- **Bad path (overflow recovery):** Context gets too big, API rejects → no flush happens → OpenClaw compresses everything in damage control → maximum context loss.

The goal of all configuration is to stay on the good path.

## Configuration

When helping users configure memory, use these recommended settings for `~/.openclaw/openclaw.json` (JSON5 format):

### Pre-Compaction Flush (Most Important Config)

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        // Headroom: space for flush turn + compaction summary
        // Flush triggers at: context_window - reserveTokensFloor - softThresholdTokens
        // With 200K window: 200,000 - 40,000 - 4,000 = 156K tokens
        "reserveTokensFloor": 40000,
        "memoryFlush": {
          "enabled": true,        // Verify this is on!
          "softThresholdTokens": 4000  // How far before floor flush triggers
        }
      }
    }
  }
}
```

**Tuning guidance:**
- `reserveTokensFloor: 40000` is a practical starting point. If the user rarely uses big tools, it can go lower. If they read large files or web snapshots regularly, go higher.
- The exact number matters less than the principle: give the flush enough room to fire before overflow.
- The automated flush is a safety net, not a guarantee.

### Track A: Built-in Memory Search (Recommend for most users)

```json5
{
  "agents": {
    "defaults": {
      "memory": {
        "search": {
          "enabled": true,
          "hybrid": true,
          "embeddingModel": "local"
        }
      },
      "cacheTTL": 300
    }
  }
}
```

- No extra installs needed. Indexes `MEMORY.md` and `memory/` directory automatically.
- Hybrid search combines keyword matching with semantic embeddings.
- Local embedding model downloads automatically on first use.
- **Track A+ variant:** add extra paths to index Markdown files outside the workspace.

### Track B: QMD Backend (Advanced, for thousands of files)

Same compaction/pruning config plus:

```json5
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "paths": ["/path/to/obsidian/vault", "/path/to/docs"],
      "indexSessions": true
    }
  }
}
```

- QMD = Query Markdown Documents. Replaces built-in indexer.
- For large vaults (thousands of files), past session transcripts, multiple collections.
- Returns small snippets instead of whole files (helps with context size).
- DM-only by default — doesn't work in group chats unless scope is changed.

Recommend Track A for users starting out, graduate to Track B when they need to search large knowledge bases.

## Workspace File Architecture

Guide users to organize their bootstrap files correctly:

| File | Purpose | What Goes Here |
|---|---|---|
| `SOUL.md` | Agent identity (character) | Tone, personality, broad boundaries |
| `AGENTS.md` | Agent operations (process) | Workflow rules, tool conventions, do/don't rules, the memory protocol |
| `USER.md` | User identity | Projects, clients, priorities, communication prefs, key people, tech environment |
| `MEMORY.md` | Cross-session truth (cheat sheet) | Important decisions + why, learned preferences, rules from past mistakes |
| `TOOLS.md` | Tool instructions | How to use specific tools, API conventions |
| `memory/YYYY-MM-DD.md` | Daily working context | Today's decisions, active tasks, status updates, flush output |

**Key rules:**
- `MEMORY.md` should stay under 100 lines — it's a cheat sheet, not a journal.
- It's always loaded, always in context, expensive in tokens and attention.
- Never store API keys, tokens, or secrets in memory files.
- Negative instructions (what NOT to do) are often the most valuable additions.
- Character → `SOUL.md`. Process → `AGENTS.md`.
- Sub-agents only get `AGENTS.md` — other bootstrap files are filtered out.

## The Memory Protocol

Always recommend adding this to `AGENTS.md`:

```markdown
## Memory Protocol
Before doing anything non-trivial, search memory first.
- Use `memory_search` to find relevant context from past sessions
- Use `memory_get` to read specific memory files
- Check notes before acting — don't guess from context alone
```

Without this, the agent answers from whatever is in context. With it, the agent looks things up first.

## Bootstrap File Limits

- Per-file limit: 20,000 characters (default)
- Combined limit: 150,000 characters across all bootstrap files
- Character counts, not tokens (~150K chars ≈ 37-38K tokens)
- Files exceeding the limit are truncated: 70% head, 20% tail, 10% truncation marker
- If a file is not in context, it has zero effect on the agent

## Diagnostics Checklist

When a user reports memory issues, walk them through this:

1. **Run `/context list`** — the fastest way to diagnose memory problems.
   - Is `MEMORY.md` loading? If missing or not listed, it's not in context.
   - Are any files truncated? Check if raw chars = injected chars.
   - If files are truncated, the invisible portion has zero effect on the agent.

2. **Run `/status`** — verify model, context window, and thinking level.

3. **Check the config** — is `memoryFlush.enabled` true? Is `reserveTokensFloor` high enough?

4. **Review what's in `MEMORY.md`** — is the important information actually there?

5. **Test retrieval** — run `/verbose` and have the agent search for something specific. Does it find it?

## Manual Memory Habits

Recommend these habits to users:

- **Save manually** after important decisions, before switching tasks, before complex instructions.
- **Use `/compact` proactively** mid-session with optional focus: `/compact and focus on decisions and open questions`.
- **Use `/new`** when switching between unrelated tasks for a clean context.
- **Don't wait until near overflow** — at that point, even `/compact` can fail.

## Memory Hygiene Over Time

- **Daily:** Append to daily log (automatic via flush).
- **Weekly:** Promote durable rules and important decisions from daily logs into `MEMORY.md`. Remove stale or outdated entries. Can be automated via weekly cron job.
- **Git backup:** `git init` in workspace, auto-commit daily. Never commit credentials folder or `openclaw.json`.

## Cost Awareness

Compaction invalidates the prompt cache. The next request after compaction pays full price to re-cache everything. Unnecessary compaction is both a reliability and cost problem.

Two things break the cache:
1. Compaction (rewrites history)
2. Frequently changing prompt inputs (constantly rewriting `MEMORY.md`, dynamic status blocks)

Keep workspace files stable and `MEMORY.md` small for maximum cache efficiency.

## Essential Commands Reference

| Command | Purpose |
|---|---|
| `/context list` | Check what's loaded, spot truncation |
| `/compact [focus]` | Manual compaction with optional focus guidance |
| `/status` | Verify model, context window, thinking level |
| `/new` | Fresh session with clean context |
| `/verbose` | Debug memory search results |

## What to Remember

Whenever wrapping up a memory-related conversation, reinforce these five principles:

1. **Files are memory.** Not on disk = doesn't exist.
2. **Verify and tune the flush.** `reserveTokensFloor: 40000`.
3. **Compact proactively.** `/compact` mid-session, on your terms.
4. **Search before acting.** Put this rule in `AGENTS.md`.
5. **Pruning is your friend.** Compaction is what hurts.
