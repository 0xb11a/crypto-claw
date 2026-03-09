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
          "softThresholdTokens": 4000
        }
      },
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
          "softThresholdTokens": 4000
        }
      },
      "memory": {
        "search": {
          "enabled": true,
          "hybrid": true,
          "embeddingModel": "local",
          "extraPaths": [
            "/path/to/project/docs",
            "/path/to/notes"
          ]
        }
      },
      "cacheTTL": 300
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
          "softThresholdTokens": 4000
        }
      },
      "memory": {
        "backend": "qmd",
        "qmd": {
          "paths": [
            "/path/to/obsidian/vault",
            "/path/to/project/docs"
          ],
          "indexSessions": true
        }
      },
      "cacheTTL": 300
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

## Bootstrap File Limits

Default limits (adjustable in config):

| Setting | Default | Notes |
|---|---|---|
| Per-file character limit | 20,000 | Files larger than this are truncated |
| Combined character limit | 150,000 | Across all bootstrap files |
| Truncation split | 70/20/10 | 70% head, 20% tail, 10% marker |

~150K characters ≈ 37-38K tokens

---

## AGENTS.md Memory Protocol Template

Add this block to your `AGENTS.md`:

```markdown
## Memory Protocol

Before doing anything non-trivial, search memory first.

1. Use `memory_search` with relevant keywords to find past context
2. Use `memory_get` to read specific dated memory files
3. After important decisions or task completions, save key points to memory
4. Never assume — always check notes before acting

## Memory Save Triggers

Write to daily memory log (`memory/YYYY-MM-DD.md`) when:
- An important decision is made
- A task is completed
- A user preference is discovered
- A rule or convention is established

Promote to `MEMORY.md` only items that should be true across every future session.
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
