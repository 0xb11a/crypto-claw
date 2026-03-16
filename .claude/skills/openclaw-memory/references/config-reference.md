# openclaw.json Configuration Reference

The gateway configuration file lives at `~/.openclaw/.openclaw/openclaw.json`. It uses JSON5 format (comments allowed).

## Full Annotated Example

```json5
{
  // ============================================================
  // Agent Defaults — apply to all agents unless overridden
  // ============================================================
  "agents": {
    "defaults": {
      // --- Compaction ---
      // Controls when and how conversation history gets compressed
      "compaction": {
        // How many tokens to reserve for flush + compaction summary
        // Higher = flush fires earlier = more safety margin
        // With 200K window: flush fires at 200,000 - 40,000 - 4,000 = 156K tokens
        "reserveTokensFloor": 40000,

        // Pre-compaction flush: agent saves context to disk before compression
        "memoryFlush": {
          "enabled": true,                    // MUST be true for memory safety
          "softThresholdTokens": 4000,        // Trigger flush this many tokens before floor
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      },

      // --- Context Pruning ---
      // Trims old tool results in-memory to delay compaction
      // On-disk transcript is untouched
      "contextPruning": {
        "mode": "cache-ttl",    // Trim based on time-to-live
        "ttl": "5m"             // Tool results older than 5 min eligible for pruning
      },

      // --- Memory Search ---
      // Enables memory_search and memory_get tools for the agent
      "memorySearch": {
        "enabled": true,
        "provider": "local",     // "local" = built-in hybrid search, "qmd" = QMD backend
        "local": {
          // Embedding model for semantic search (auto-downloaded on first use)
          "modelPath": "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"
        },
        "query": {
          "hybrid": {
            "enabled": true,      // Combine keyword + semantic search
            "vectorWeight": 0.7,  // Weight for semantic similarity
            "textWeight": 0.3     // Weight for keyword matching
          }
        },
        "cache": {
          "enabled": true         // Cache search results for performance
        }
        // Optional: index additional markdown files outside workspace
        // "extraPaths": [
        //   "~/Documents/notes/**/*.md",
        //   "~/Documents/specs/**/*.md"
        // ]
      }
    },

    // --- Per-Agent Overrides ---
    // Override any default for a specific agent
    "overrides": {
      "primary": {
        "compaction": {
          "reserveTokensFloor": 50000     // Primary may need more headroom for large tool outputs
        }
      },
      "worker": {
        "compaction": {
          "reserveTokensFloor": 30000     // Worker has smaller context needs
        }
      }
    }
  },

  // ============================================================
  // Gateway — HTTP server settings
  // ============================================================
  "gateway": {
    "port": 18789,            // HTTP port
    "bind": "lan",            // "local" | "lan" | "wan"
    "token": ""               // Bearer token for auth (set via OPENCLAW_GATEWAY_TOKEN env var)
  },

  // ============================================================
  // Memory Backend (Advanced) — only needed for QMD
  // ============================================================
  // "memory": {
  //   "backend": "qmd",
  //   "qmd": {
  //     "searchMode": "search",
  //     "includeDefaultMemory": true,
  //     "sessions": { "enabled": true },
  //     "paths": [
  //       { "name": "docs", "path": "~/Documents/project-docs", "pattern": "**/*.md" }
  //     ]
  //   }
  // }
}
```

## Section Details

### compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `reserveTokensFloor` | number | 20000 | Tokens reserved for flush + summary. Recommended: 40000 |
| `memoryFlush.enabled` | boolean | false | Enable pre-compaction flush. **Set to true.** |
| `memoryFlush.softThresholdTokens` | number | 4000 | How far before floor to trigger flush |
| `memoryFlush.systemPrompt` | string | — | System message sent when flush triggers |
| `memoryFlush.prompt` | string | — | User message sent when flush triggers |

### contextPruning

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mode` | string | — | `"cache-ttl"` — prune tool results by age |
| `ttl` | string | `"5m"` | Time-to-live for tool results in context |

### memorySearch

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | false | Enable `memory_search` / `memory_get` tools |
| `provider` | string | `"local"` | `"local"` for built-in, `"qmd"` for QMD backend |
| `local.modelPath` | string | — | HuggingFace embedding model path |
| `query.hybrid.enabled` | boolean | false | Enable hybrid (keyword + semantic) search |
| `query.hybrid.vectorWeight` | number | 0.7 | Semantic similarity weight |
| `query.hybrid.textWeight` | number | 0.3 | Keyword match weight |
| `cache.enabled` | boolean | true | Cache search results |
| `extraPaths` | string[] | — | Additional markdown directories to index |

### gateway

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `port` | number | 18789 | HTTP listen port |
| `bind` | string | `"lan"` | Network bind: `local`, `lan`, `wan` |
| `token` | string | — | Bearer auth token (prefer env var) |

### memory (QMD backend)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `backend` | string | `"local"` | `"local"` or `"qmd"` |
| `qmd.searchMode` | string | `"search"` | QMD query mode |
| `qmd.includeDefaultMemory` | boolean | true | Also search default workspace memory |
| `qmd.sessions.enabled` | boolean | false | Index past session transcripts |
| `qmd.paths` | array | — | Additional paths to index (name, path, pattern) |

## Bootstrap File Limits

Configurable per-agent if needed:

| Setting | Default | Description |
|---------|---------|-------------|
| Per-file character limit | 20,000 | Files larger than this are truncated |
| Combined character limit | 150,000 | Across all bootstrap files (~50K tokens) |
| Truncation split | 70/20/10 | 70% head, 20% tail, 10% marker |

## Minimal Recommended Config

If you change nothing else, at least set these:

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
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m"
      }
    }
  }
}
```
