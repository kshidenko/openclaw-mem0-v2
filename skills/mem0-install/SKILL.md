---
name: mem0-install
description: Install the OpenClaw Mem0 v2 enhanced memory plugin
version: 2.0.0
metadata:
  openclaw:
    requires:
      config: ["plugins"]
---

# Install OpenClaw Mem0 v2 (Enhanced Memory)

## What This Does

Installs the enhanced Mem0 memory plugin for OpenClaw with:
- 6 memory tools (search, store, store_raw, get, list, forget)
- Auto-recall and auto-capture
- Multi-channel identity mapping
- Graph memory support
- Extended fact extraction (infrastructure, assistant behavior)
- Sleep mode (background memory maintenance)

## Installation Methods

### Method A: One-liner (recommended)

Run the install script directly:

```bash
curl -sL https://raw.githubusercontent.com/kshidenko/openclaw-mem0-v2/main/install.sh | bash
```

The script will:
1. Auto-clone the repo to /tmp
2. Guide through configuration interactively
3. Copy files to ~/.openclaw/extensions/mem0-memory/
4. Install npm dependencies
5. Patch openclaw.json
6. Restart the gateway

### Method B: Non-interactive (for agents)

Clone and run with all arguments pre-set:

```bash
git clone https://github.com/kshidenko/openclaw-mem0-v2.git /tmp/openclaw-mem0-v2
cd /tmp/openclaw-mem0-v2
bash install.sh \
  --mode oss \
  --api-key "$OPENAI_API_KEY" \
  --embedding ollama \
  --embedding-model nomic-embed-text:latest \
  --enable-sleep \
  --user-id default
```

### Method C: Manual

1. Clone: `git clone https://github.com/kshidenko/openclaw-mem0-v2.git /tmp/openclaw-mem0-v2`
2. Copy files: `cp -r /tmp/openclaw-mem0-v2/{index.ts,user-resolver.ts,sleep-mode.ts,types.ts,openclaw.plugin.json,package.json} ~/.openclaw/extensions/mem0-memory/`
3. Install deps: `cd ~/.openclaw/extensions/mem0-memory && npm install`
4. Add plugin config to `~/.openclaw/openclaw.json` (see Configuration below)
5. Restart: `openclaw gateway restart`

## Configuration

Add to `openclaw.json` under `plugins.entries`:

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
          "enableGraph": false,
          "topK": 5,
          "searchThreshold": 0.5,
          "skipGroupChats": true,
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
            }
          },
          "sleepMode": {
            "enabled": true,
            "logDir": "memory/logs",
            "digestDir": "memory/digests",
            "digestEnabled": true
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

## Verification

After installation, run:
```bash
openclaw doctor
openclaw mem0 stats
```
