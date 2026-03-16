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

