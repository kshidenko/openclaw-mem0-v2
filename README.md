# OpenClaw Mem0 v2 — Enhanced Long-Term Memory

Enhanced memory plugin for [OpenClaw](https://openclaw.ai) based on [Mem0](https://mem0.ai). Builds on the [official Mem0 plugin](https://github.com/mem0ai/mem0/tree/main/openclaw) with additional features for power users.

> **Status:** Project is under active development. Bugs are expected - please submit bug reports.

## Attribution and Non-Affiliation Notice

This repository is an independent community project and is **not** owned by,
maintained by, or officially affiliated with OpenClaw or Mem0.

- OpenClaw project: https://openclaw.ai
- Mem0 project: https://mem0.ai
- Official Mem0 OpenClaw plugin:
  https://github.com/mem0ai/mem0/tree/main/openclaw

Full respect and credit go to the original owners and maintainers of OpenClaw
and Mem0 for their work.

This project aims to comply with applicable open-source licenses and usage
requirements. If you believe anything in this repository conflicts with
licensing or branding rules, please open an issue or security report so it can
be fixed quickly.

## Features

| Feature | Official Plugin | This Plugin |
|---------|----------------|-------------|
| memory_search, store, get, list, forget | Yes | Yes |
| memory_store_raw (verbatim, no extraction) | No | Yes |
| Auto-recall / auto-capture | Yes | Yes |
| Session + long-term scopes | Yes | Yes |
| Platform + OSS dual mode | Yes | Yes |
| Identity mapping (multi-channel) | No | Yes |
| Graph memory in OSS mode (Kuzu) | No | Yes |
| Extended extraction (infra, assistant) | No | Yes |
| Category-based search filter | No | Yes |
| "Remember" keyword override | No | Yes |
| Sleep mode (background maintenance) | No | Yes |
| Conversation log search | No | Yes |
| Daily digest generation | No | Yes |
| Group chat skip logic | No | Yes |
| Pure TypeScript (no Python) | Yes | Yes |

## Quick Install

```bash
curl -sL https://raw.githubusercontent.com/kshidenko/openclaw-mem0-v2/main/install.sh | bash
```

The interactive installer will guide you through mode selection, API keys, embedding provider, and optional features.

## Non-Interactive Install

```bash
bash install.sh \
  --mode oss \
  --api-key "$OPENAI_API_KEY" \
  --embedding ollama \
  --embedding-model nomic-embed-text:latest \
  --enable-sleep \
  --enable-graph
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mem0-memory": {
        "config": {
          "mode": "open-source",
          "userId": "default",
          "autoCapture": true,
          "autoRecall": true,
          "enableGraph": true,
          "topK": 5,
          "searchThreshold": 0.5,
          "skipGroupChats": true,
          "identityMapPath": "config/identity-map.json",
          "oss": {
            "embedder": {
              "provider": "ollama",
              "config": {
                "model": "nomic-embed-text:latest",
                "ollama_base_url": "http://localhost:11434"
              }
            },
            "llm": {
              "provider": "openai",
              "config": {
                "model": "gpt-4o-mini",
                "api_key": "${OPENAI_API_KEY}"
              }
            },
            "graphStore": {
              "provider": "kuzu",
              "config": {}
            }
          },
          "sleepMode": {
            "enabled": true,
            "logDir": "memory/logs",
            "digestDir": "memory/digests",
            "digestEnabled": true,
            "retentionDays": 365,
            "maxChunkChars": 4000
          }
        }
      }
    },
    "slots": {
      "memory": "mem0-memory"
    }
  }
}
```

## Tools

### Core Memory Tools

- **memory_search** — Semantic search with optional category filter
- **memory_store** — Store with LLM fact extraction
- **memory_store_raw** — Store verbatim text without extraction
- **memory_get** — Retrieve by ID
- **memory_list** — List all memories
- **memory_forget** — Delete by ID

### Sleep Mode Tools

- **memory_search_log** — Search through conversation history logs

### CLI

```bash
openclaw mem0 search "query"        # Search memories
openclaw mem0 stats                 # Memory statistics
openclaw mem0-sleep                 # Run sleep maintenance
openclaw mem0-sleep --dry-run       # Preview processing
openclaw mem0-sleep --date 2026-02-07  # Process specific date
```

## Identity Mapping

Map multiple channel identities to a single canonical user:

```json
// config/identity-map.json
{
  "identities": [
    {
      "canonical": "alice",
      "aliases": ["telegram:dm:123456", "discord:user_789"],
      "label": "Alice (owner)"
    }
  ]
}
```

## Sleep Mode

Background memory maintenance that runs nightly (or on-demand):

1. **Log Collection** — Cleaned conversation entries appended to daily JSONL files
2. **Analysis** — LLM processes unanalyzed logs to extract missed facts
3. **Promotion** — New facts promoted to hot memory (Mem0)
4. **Digest** — Optional daily summary in Markdown

Set up nightly cron:

```json
{
  "automation": {
    "crons": [{
      "schedule": "0 3 * * *",
      "description": "Memory maintenance",
      "agentMessage": "/mem0-sleep"
    }]
  }
}
```

## Agent Prompts

<details>
<summary>Quick Install Prompt (copy & paste to agent)</summary>

```
Read the installation skill at https://raw.githubusercontent.com/kshidenko/openclaw-mem0-v2/main/skills/mem0-install/SKILL.md and follow the instructions to install the Mem0 v2 memory plugin.
```

</details>

<details>
<summary>Usage Guide Prompt (copy & paste to agent)</summary>

```
Read the usage skill at https://raw.githubusercontent.com/kshidenko/openclaw-mem0-v2/main/skills/mem0-usage/SKILL.md to learn how to use the memory tools.
```

</details>

## Architecture

```
openclaw-mem0-v2/
├── index.ts              # Main plugin: tools, hooks, CLI, sleep mode integration
├── user-resolver.ts      # Multi-channel identity mapping
├── sleep-mode.ts         # Sleep mode: log collection, analysis, cold search, digests
├── types.ts              # Shared type definitions
├── openclaw.plugin.json  # Plugin manifest with config schema
├── package.json          # Node.js dependencies (mem0ai, @sinclair/typebox)
├── install.sh            # Interactive installer
├── skills/
│   ├── mem0-install/SKILL.md   # Agent installation skill
│   └── mem0-usage/SKILL.md     # Agent usage skill
└── config/
    └── identity-map.example.json  # Identity mapping example
```

## Credits

- [Mem0](https://mem0.ai) — Memory framework
- [Official Mem0 OpenClaw Plugin](https://github.com/mem0ai/mem0/tree/main/openclaw) — Base implementation
- [OpenClaw](https://openclaw.ai) — AI agent platform

## Community

- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)

## License

MIT
