# OpenClaw Memory Configuration Examples

## Table of Contents
1. Track A: Built-in Search (Recommended Starting Point)
2. Track A+: Built-in Search with Extra Paths
3. Track B: QMD Backend
4. Minimal Config (Just the Flush)

---

## 1. Track A: Built-in Search

Complete config for most users. No extra installs needed.

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "reserveTokensFloor": 40000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      },
      "memorySearch": {
        "enabled": true,
        "provider": "local",
        "local": {
          "modelPath": "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"
        },
        "query": {
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3
          }
        },
        "cache": {
          "enabled": true
        }
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m"
      }
    }
  }
}
```

**Flush trigger point calculation:**
- Context window (200,000) - reserveTokensFloor (40,000) - softThresholdTokens (4,000) = **156,000 tokens**
- At 156K tokens used, the flush fires automatically

---

## 2. Track A+: Extra Indexed Paths

Same as Track A but with additional directories indexed for search.

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "reserveTokensFloor": 40000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      },
      "memorySearch": {
        "enabled": true,
        "provider": "local",
        "extraPaths": [
          "~/Documents/Obsidian/ProjectNotes/**/*.md",
          "~/Documents/specs/**/*.md"
        ]
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m"
      }
    }
  }
}
```

---

## 3. Track B: QMD Backend

For users with thousands of files (Obsidian vaults, large doc collections).

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "reserveTokensFloor": 40000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m"
      }
    }
  },
  "memory": {
    "backend": "qmd",
    "qmd": {
      "searchMode": "search",
      "includeDefaultMemory": true,
      "sessions": {
        "enabled": true
      },
      "paths": [
        { "name": "obsidian", "path": "~/Documents/Obsidian", "pattern": "**/*.md" },
        { "name": "docs", "path": "~/Documents/project-docs", "pattern": "**/*.md" }
      ]
    }
  }
}
```

**Notes:**
- QMD is DM-only by default. Check scope config for group chat support.
- QMD returns snippets not whole files, keeping context smaller.
- Starts with fast keyword search; switch to semantic if wording differs.

---

## 4. Minimal Config (Just the Flush)

If you change nothing else, at least enable and tune the flush:

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "reserveTokensFloor": 40000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000
        }
      }
    }
  }
}
```

---

## Context Pruning

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

- `mode: "cache-ttl"` trims tool results based on time-to-live
- `ttl: "5m"` means tool results older than 5 minutes are eligible for pruning
- Only affects tool result messages; user and assistant messages are never modified

---

## Bootstrap File Limits

Default limits (adjustable in config):

| Setting | Default | Notes |
|---|---|---|
| Per-file character limit | 20,000 | Files larger than this are truncated |
| Combined character limit | 150,000 | Across all bootstrap files (~50K tokens) |
| Truncation split | 70/20/10 | 70% head, 20% tail, 10% marker |

---

## AGENTS.md Memory Protocol Template

Add this block to your `AGENTS.md`:

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

## Memory Save Triggers

Write to daily memory log (`memory/YYYY-MM-DD.md`) when:
- An important decision is made
- A task is completed
- A user preference is discovered
- A rule or convention is established

Promote to `MEMORY.md` only items that should be true across every future session.
```

---

## Group Chat Rules Template (for Discord/Slack)

Add to `AGENTS.md` if the agent operates in group chats:

```markdown
## Group Chat Rules
- Only respond when: directly mentioned, asked a direct question, or you have genuinely useful info
- Do NOT respond to: side conversations, banter, logistics between others, greetings, link shares
- When in doubt -> respond with only: NO_REPLY
- NO_REPLY must be your ENTIRE message - nothing else
```

---

## .gitignore Template for Workspace

```gitignore
# Never commit credentials
credentials/
openclaw.json

# Optional: ignore session transcripts if large
sessions/
```
