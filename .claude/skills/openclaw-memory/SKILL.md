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

1. **Bootstrap files** (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, and optionally `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) — loaded from disk at session start, survive compaction because they're reloaded from disk each turn. Most durable layer.
2. **Session transcript** — conversation saved as JSONL on disk, but gets compacted (summarized) when context fills. The model loses access to original messages after compaction. Sessions reset daily at 4:00 AM local time.
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

| | **Compaction** | **Pruning** |
|---|---|---|
| **What it does** | Summarizes entire conversation history | Trims old tool results in-memory |
| **Triggered by** | Context window filling up | Cache TTL (time-to-live, default 5 min) |
| **Affects** | Everything: user messages, assistant messages, tool calls | Only tool result messages |
| **On-disk history** | Replaced by summary | Untouched |
| **Impact** | **Dangerous** — changes what the model sees | **Friendly** — reduces bloat without destroying conversation context |

Pruning is your friend. Compaction is the one that hurts.

## Two Compaction Paths

- **Good path (maintenance):** Context nears limit → flush fires → agent saves important context to disk → compaction summarizes → agent continues with summary + recent messages (~last 20K tokens stay intact).
- **Bad path (overflow recovery):** Context gets too big, API rejects → no flush happens → OpenClaw compresses everything in damage control → maximum context loss.

The goal of all configuration is to stay on the good path.

### What Survives Compaction

**Survives:**
- All workspace files (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`)
- Daily memory logs (when accessed via search)
- Anything written to disk before compaction (the flush)
- Roughly the last ~20,000 tokens of recent messages

**Lost:**
- Instructions only given in chat
- Preferences or decisions mentioned mid-session
- Older images
- All tool results
- Exact wording and nuance of earlier messages (summaries are lossy)

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
          "softThresholdTokens": 4000,  // How far before floor flush triggers
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      }
    }
  }
}
```

**Tuning guidance:**
- `reserveTokensFloor: 40000` is a practical starting point (default of 20K is often insufficient). If the user rarely uses big tools, it can go lower. If they read large files or web snapshots regularly, go higher.
- The exact number matters less than the principle: give the flush enough room to fire before overflow.
- The automated flush is a safety net, not a guarantee. It can be bypassed by large single-turn token jumps.

### Context Pruning

Session pruning trims old tool results in-memory to delay compaction and improve caching. The on-disk transcript is untouched.

```json5
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m"
      }
    }
  }
}
```

- Only affects tool result messages. User and assistant messages are never modified.
- `cache-ttl` mode trims tool results based on time-to-live (default 5 minutes).
- Pruning is beneficial — it reduces bloat without destroying conversation context.

### Retrieval Tracks (Advanced)

OpenClaw supports three retrieval configurations for searching memory files. If the user asks about hybrid search, extra indexed paths, or QMD, refer to `references/config-examples.md` for full configuration examples.

- **Track A (Built-in Search):** Local hybrid search (keyword + semantic). No extra installs. Recommended starting point.
- **Track A+ (Extra Paths):** Same as Track A but indexes additional Markdown files outside the workspace.
- **Track B (QMD):** Query Markdown Documents backend. For large vaults (thousands of files), past session transcripts, multiple collections. Returns snippets instead of whole files. DM-only by default.

## Workspace File Architecture

Guide users to organize their bootstrap files correctly:

| File | Purpose | What Goes Here |
|---|---|---|
| `SOUL.md` | Agent identity (character) | Tone, personality, broad boundaries |
| `AGENTS.md` | Agent operations (process) | Workflow rules, tool conventions, do/don't rules, the memory protocol |
| `USER.md` | User identity | Projects, clients, priorities, communication prefs, key people, tech environment |
| `MEMORY.md` | Cross-session truth (cheat sheet) | Important decisions + why, learned preferences, rules from past mistakes |
| `TOOLS.md` | Tool instructions | How to use specific tools, API conventions |
| `IDENTITY.md` | Extended identity | Additional identity configuration |
| `HEARTBEAT.md` | Periodic check-in rules | Heartbeat/cron behavior |
| `BOOTSTRAP.md` | Additional bootstrap config | Extra startup instructions |
| `memory/YYYY-MM-DD.md` | Daily working context | Today's decisions, active tasks, status updates, flush output |

**Key rules:**
- `MEMORY.md` should stay under 100 lines — it's a cheat sheet, not a journal.
- It's always loaded, always in context, expensive in tokens and attention.
- Never store API keys, tokens, or secrets in memory files.
- Negative instructions (what NOT to do) are often the most valuable additions.
- Character → `SOUL.md`. Process → `AGENTS.md`.
- Sub-agents only get `AGENTS.md` and `TOOLS.md` — other bootstrap files are filtered out.
- These files are prompts, not real security. For actual protection, use system controls like tool permissions, workspace isolation, and allow lists.

## The Memory Protocol

Always recommend adding this to `AGENTS.md`:

```markdown
## Memory Protocol

Before doing anything non-trivial, search memory first.

- Before answering questions about past work: search memory first
- Before starting any new task: check memory/today's date for active context
- When you learn something important: write it to the appropriate file immediately
- When corrected on a mistake: add the correction as a rule to MEMORY.md
- When a session is ending or context is large: summarize to memory/YYYY-MM-DD.md

## Retrieval Protocol

Before doing non-trivial work:
1. `memory_search` for the project/topic/user preference
2. `memory_get` the referenced file chunk if needed
3. Then proceed with the task
```

Without this, the agent answers from whatever is in context. With it, the agent looks things up first.

## Group Chat Configuration

If the agent operates in Discord/Slack group chats, recommend adding to `AGENTS.md`:

```markdown
## Group Chat Rules
- Only respond when: directly mentioned, asked a direct question, or you have genuinely useful info
- Do NOT respond to: side conversations, banter, logistics between others, greetings, link shares
- When in doubt -> respond with only: NO_REPLY
- NO_REPLY must be your ENTIRE message - nothing else
```

## Bootstrap File Limits

- Per-file limit: 20,000 characters (default)
- Combined limit: 150,000 characters across all bootstrap files (~50K tokens)
- These are character counts, not tokens
- Files exceeding the limit are truncated: 70% head, 20% tail, 10% truncation marker
- If a file is not in context, it has zero effect on the agent

## Diagnostics Checklist

When a user reports memory issues, walk them through this:

1. **Run `/context list`** — the fastest way to diagnose memory problems.
   - Is `MEMORY.md` loading? If missing or not listed, it's not in context.
   - Are any files truncated? Check if raw chars = injected chars.
   - If files are truncated, the invisible portion has zero effect on the agent.
   - Use `/context detail <file>` for deep analysis of a specific file's injection.

2. **Run `/status`** — verify model, context window, and thinking level.

3. **Check the config** — is `memoryFlush.enabled` true? Is `reserveTokensFloor` high enough?

4. **Review what's in `MEMORY.md`** — is the important information actually there?

5. **Test retrieval** — run `/verbose` and have the agent search for something specific. Does it find it?

6. **Check version** — ensure v2026.2.23 or later for compaction bug fixes.

## Troubleshooting

Common issues and fixes:

- **Preference not remembered:** Check `MEMORY.md` loading via `/context list`. Verify preference is written to file. If missing, add to `MEMORY.md` now.
- **`memory_search` disabled:** Confirm memory files exist. Check if local embedding model downloaded successfully. Run `/context list` to verify loaded files.
- **Tool results forgotten:** This indicates session pruning (temporary), not compaction. Write important tool outputs to memory. Re-run tool if critical.
- **Compaction too late:** Use `/compact` proactively before overflow. Raise `reserveTokensFloor` to trigger earlier. If stuck in overflow deadlock, use `/new` or CLI recovery.
- **Flush didn't run:** Can be bypassed by large single-turn token jumps. Raise `reserveTokensFloor` buffer. Use manual save points as backup.
- **Agent forgets tools after long sessions:** Known issue with long Discord sessions. Use `/new` to reset; proper memory files allow continuation.
- **Everything forgotten overnight:** Sessions reset daily (default 4:00 AM local time). Only bootstrap files and searchable memory carry over. This is expected behavior.

## Manual Memory Habits

Recommend these habits to users:

- **Save manually** after important decisions, before switching tasks, before complex instructions.
- **Use `/compact` proactively** mid-session with optional focus: `/compact and focus on decisions and open questions`.
- **Use `/new`** (or `/reset`) when switching between unrelated tasks for a clean context.
- **Don't wait until near overflow** — at that point, even `/compact` can fail.

## Memory Hygiene Over Time

- **Daily:** Append to daily log (automatic via flush).
- **Weekly:** Promote durable rules and important decisions from daily logs into `MEMORY.md`. Remove stale or outdated entries. Can be automated via weekly cron job.
- **Git backup:** `git init` in workspace, auto-commit daily. Never commit credentials folder or `openclaw.json` (contains API keys/tokens).

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
| `/context detail <file>` | Deep analysis of specific file injection |
| `/compact [focus]` | Manual compaction with optional focus guidance |
| `/status` | Verify model, context window, thinking level |
| `/new` or `/reset` | Fresh session with clean context |
| `/verbose` | Debug memory search results |

## Defense-in-Depth Summary

| Layer | Function | Enablement |
|---|---|---|
| Workspace files | Identity + instructions immune to compaction | Structure SOUL.md, AGENTS.md, USER.md, MEMORY.md |
| Pre-compaction flush | Automatic safety net before compression | Verify `memoryFlush.enabled: true` + tune `reserveTokensFloor` |
| Manual memory saves | Relevance-based preservation of important decisions | Habit: "save this to memory" before task switches |
| Strategic `/compact` | Clear decks before new important instructions | `/compact` before, not after, new context |
| Session pruning | Trim tool bloat to delay compaction + save caching | `contextPruning.mode: "cache-ttl"` |
| Hybrid search | Find memories even when wording differs | `query.hybrid.enabled: true` in `memorySearch` |
| Extra paths (Track A+) | Index external docs without switching backends | `memorySearch.extraPaths` for small doc sets |
| QMD (Track B) | Search entire knowledge base | `memory.backend: "qmd"` |
| Git backup | Full history, diffs, rollback for memory files | `git init` in workspace, auto-commit cron |
| Memory hygiene | Prevent bootstrap bloat and context waste | Weekly: distill daily logs into MEMORY.md |

## What to Remember

Whenever wrapping up a memory-related conversation, reinforce these five principles:

1. **Files are memory.** Not on disk = doesn't exist.
2. **Verify and tune the flush.** `reserveTokensFloor: 40000`.
3. **Compact proactively.** `/compact` mid-session, on your terms.
4. **Search before acting.** Put this rule in `AGENTS.md`.
5. **Pruning is your friend.** Compaction is what hurts.
