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
        "reserveTokensFloor": 80000,

        // Pre-compaction flush: agent saves context to disk before compression
        "memoryFlush": {
          "enabled": true,                    // MUST be true for memory safety
          "softThresholdTokens": 8000,        // Trigger flush this many tokens before floor
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
      },

      // --- Sandbox ---
      // Sandbox mode for agent shell execution
      "sandbox": {
        "mode": "off"         // "off" disables sandboxing (use with allowlist security instead)
      }
    },

    // --- Per-Agent Overrides (via agents.list[N]) ---
    // agents.list is an indexed array. Index 0 is the built-in "main" agent.
    // Custom agents get indices 1, 2, 3... in registration order.
    // Set via CLI: openclaw config set 'agents.list[N].key' 'value'
    "list": [
      // Index 0: built-in main agent (typically disabled)
      {
        "default": false,
        "heartbeat": { "every": "0m" }
      },
      // Index 1: first registered agent
      {
        "default": true,
        "heartbeat": { "every": "0m" },
        "subagents": {
          "model": "anthropic/claude-sonnet-4-6"  // Sub-agent model override
        }
      },
      // Index 2, 3...: subsequent agents
      {
        "heartbeat": { "every": "0m" }
      }
    ]
  },

  // ============================================================
  // Gateway — HTTP server settings
  // ============================================================
  "gateway": {
    "mode": "local",          // Gateway mode
    "port": 18789,            // HTTP port
    "bind": "lan",            // "local" | "lan" | "wan"
    "controlUi": {
      "allowedOrigins": ["*"] // CORS origins for control UI
    },
    "auth": {
      "mode": "token",        // "token" or "none"
      "token": ""             // Bearer token (set via OPENCLAW_GATEWAY_TOKEN env var)
    }
  },

  // ============================================================
  // Tools — Script execution security
  // ============================================================
  "tools": {
    "exec": {
      "security": "allowlist",    // "allowlist" = only safeBins allowed, "ask" = prompt user
      "ask": "on-miss",           // What to do when command not in allowlist
      "safeBins": [               // Allowed command patterns
        "node scripts/*",
        "cat memory/*",
        "ls memory/",
        "echo *"
      ],
      "safeBinProfiles": {        // Per-command constraints
        "node scripts/*": {
          "minPositional": 1,
          "maxPositional": 10,
          "deniedFlags": ["-e", "--eval", "--input-type", "-p", "--print", "-c", "--check"]
        },
        "cat memory/*": { "minPositional": 1, "maxPositional": 5 },
        "ls memory/":   { "minPositional": 0, "maxPositional": 2 },
        "echo *":       { "minPositional": 0, "maxPositional": 10 }
      }
    },
    "web": {
      "search": { "enabled": false },  // Disable web search tool
      "fetch":  { "enabled": true }     // Enable/disable web fetch tool
    }
  },

  // ============================================================
  // Skills — Bundled skill control
  // ============================================================
  "skills": {
    "allowBundled": []        // Empty array disables all bundled skills
  },

  // ============================================================
  // Browser — Browser tool control
  // ============================================================
  "browser": {
    "enabled": false          // Disable browser tool
  },

  // ============================================================
  // Model Providers — Custom provider registration
  // ============================================================
  "models": {
    "providers": {
      // Example: Ollama Cloud provider
      // "ollama": {
      //   "baseUrl": "https://ollama.com",
      //   "api": "ollama",
      //   "apiKey": "...",
      //   "models": [{ "id": "deepseek-v3.1:671b-cloud", "name": "DeepSeek V3.1 Cloud" }]
      // }
    }
  },

  // ============================================================
  // Channels — Messaging platform integrations
  // ============================================================
  "channels": {
    "telegram": {
      "enabled": false,
      "groupPolicy": "open"
    }
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
| `reserveTokensFloor` | number | 20000 | Tokens reserved for flush + summary. Recommended: 80000 for large-context models |
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
| `mode` | string | `"local"` | Gateway mode |
| `port` | number | 18789 | HTTP listen port |
| `bind` | string | `"lan"` | Network bind: `local`, `lan`, `wan` |
| `controlUi.allowedOrigins` | string[] | — | CORS allowed origins for control UI |
| `auth.mode` | string | `"none"` | Auth mode: `"token"` or `"none"` |
| `auth.token` | string | — | Bearer auth token (prefer env var) |

### tools.exec

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `security` | string | — | `"allowlist"` = only safeBins allowed |
| `ask` | string | — | `"on-miss"` = prompt when command not in allowlist |
| `safeBins` | string[] | — | Allowed command patterns (e.g., `"node scripts/*"`) |
| `safeBinProfiles` | object | — | Per-command constraints (positional args, denied flags) |
| `safeBinProfiles.<cmd>.minPositional` | number | — | Minimum positional arguments |
| `safeBinProfiles.<cmd>.maxPositional` | number | — | Maximum positional arguments |
| `safeBinProfiles.<cmd>.deniedFlags` | string[] | — | Flags the agent cannot use (e.g., `--eval`) |

### tools.web

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `search.enabled` | boolean | true | Enable/disable web search tool |
| `fetch.enabled` | boolean | true | Enable/disable web fetch tool |

### skills

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowBundled` | string[] | (all) | List of allowed bundled skills. Empty array `[]` disables all |

### browser

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | true | Enable/disable browser tool |

### agents.defaults.sandbox

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mode` | string | — | Sandbox mode. `"off"` disables sandboxing |

### agents.list[N] (per-agent overrides)

Per-agent config uses indexed array access. Index 0 = built-in "main" agent, 1+ = custom agents in registration order.

| Setting | Type | Description |
|---------|------|-------------|
| `agents.list[N].default` | boolean | Whether this agent is the default |
| `agents.list[N].heartbeat` | object | Heartbeat config, e.g., `{"every":"30m"}`. `"0m"` disables |
| `agents.list[N].model` | string | Model override for this agent |
| `agents.list[N].subagents.model` | string | Model for sub-agents spawned by this agent |

Set via CLI:
```bash
openclaw config set 'agents.list[1].heartbeat' '{"every":"30m"}' --strict-json
openclaw config set 'agents.list[1].subagents.model' 'anthropic/claude-sonnet-4-6'
```

### models.providers

Register custom model providers:

| Setting | Type | Description |
|---------|------|-------------|
| `models.providers.<name>.baseUrl` | string | Provider API base URL |
| `models.providers.<name>.api` | string | API type (e.g., `"ollama"`, `"openai"`) |
| `models.providers.<name>.apiKey` | string | API key for authentication |
| `models.providers.<name>.models` | array | Available models (`[{id, name}]`) |

Set via CLI:
```bash
openclaw config set 'models.providers.ollama' '{"baseUrl":"https://ollama.com","api":"ollama","apiKey":"...","models":[{"id":"deepseek-v3.1:671b-cloud","name":"DeepSeek V3.1 Cloud"}]}' --strict-json
```

### channels

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `channels.telegram.enabled` | boolean | false | Enable Telegram integration |
| `channels.telegram.groupPolicy` | string | — | Group join policy (`"open"`, etc.) |

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
        "reserveTokensFloor": 80000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 8000
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
