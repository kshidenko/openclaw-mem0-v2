#!/usr/bin/env bash
# ============================================================================
# openclaw-mem0-v2 — interactive installer
#
# Installs the enhanced mem0-memory plugin (v2) into OpenClaw.
# Pure TypeScript — no Python required.
#
# Usage (one-liner — no git clone needed):
#   curl -sL https://raw.githubusercontent.com/kshidenko/openclaw-mem0-v2/main/install.sh | bash
#
# Usage (from cloned repo):
#   cd ~/Projects/openclaw-mem0-v2 && bash install.sh
#
# Usage (non-interactive / CI):
#   bash install.sh \
#     --mode platform --api-key m0-xxx \
#     --enable-sleep --enable-graph
#
# What it does:
#   0. Auto-clones the repo if not running from inside it
#   1. Copies plugin files to ~/.openclaw/extensions/mem0-memory/
#   2. Runs npm install for dependencies
#   3. Guides through mode selection (platform vs open-source)
#   4. Configures embedding, LLM, graph, sleep mode
#   5. Patches openclaw.json to enable the plugin
#   6. Restarts the OpenClaw gateway
#   7. Runs openclaw doctor to verify
# ============================================================================

set -euo pipefail

GITHUB_REPO="https://github.com/kshidenko/openclaw-mem0-v2.git"
CLONE_DIR="/tmp/openclaw-mem0-v2"

# --- Auto-clone: if not running from inside the repo, fetch it first --------
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -z "$_script_dir" ] || [ ! -f "$_script_dir/openclaw.plugin.json" ]; then
    echo ""
    echo "  Repo not found locally — cloning from GitHub..."
    if [ -d "$CLONE_DIR/.git" ]; then
        echo "  Updating existing clone at $CLONE_DIR"
        (cd "$CLONE_DIR" && git pull --quiet)
    else
        rm -rf "$CLONE_DIR"
        git clone --quiet "$GITHUB_REPO" "$CLONE_DIR"
    fi
    echo "  Done: $CLONE_DIR"
    echo ""
    exec bash "$CLONE_DIR/install.sh" "$@"
fi

# --- Colors -----------------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[X]${NC} $1"; }
step()  { echo -e "\n${CYAN}${BOLD}--- $1 ---${NC}"; }

# --- Auto-detect OpenClaw home ----------------------------------------------
detect_openclaw_home() {
    if [ -n "${OPENCLAW_HOME:-}" ] && [ -d "$OPENCLAW_HOME" ]; then
        echo "$OPENCLAW_HOME"
        return
    fi
    if command -v openclaw &>/dev/null; then
        local cli_home
        cli_home="$(openclaw config get home 2>/dev/null || true)"
        if [ -n "$cli_home" ] && [ -d "$cli_home" ]; then
            echo "$cli_home"
            return
        fi
    fi
    local candidates=(
        "$HOME/.openclaw"
        "$HOME/Library/Application Support/openclaw"
        "$HOME/.config/openclaw"
    )
    for dir in "${candidates[@]}"; do
        if [ -f "$dir/openclaw.json" ]; then
            echo "$dir"
            return
        fi
    done
    echo "$HOME/.openclaw"
}

OPENCLAW_HOME="$(detect_openclaw_home)"
REPO_DIR="$_script_dir"
PLUGIN_DIR="$OPENCLAW_HOME/extensions/mem0-memory"
CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"

# Verify OpenClaw is actually there
if [ ! -f "$CONFIG_FILE" ]; then
    warn "openclaw.json not found at $OPENCLAW_HOME"
    echo -n "  Enter OpenClaw home directory (or press Enter for $OPENCLAW_HOME): "
    read -r CUSTOM_HOME
    if [ -n "$CUSTOM_HOME" ]; then
        OPENCLAW_HOME="$CUSTOM_HOME"
        PLUGIN_DIR="$OPENCLAW_HOME/extensions/mem0-memory"
        CONFIG_FILE="$OPENCLAW_HOME/openclaw.json"
    fi
fi

# --- Parse CLI arguments (non-interactive mode) -----------------------------
ARG_MODE=""
ARG_API_KEY=""
ARG_ENABLE_GRAPH=""
ARG_ENABLE_SLEEP=""
ARG_EMBEDDING=""
ARG_EMBEDDING_MODEL=""
ARG_OLLAMA_URL=""
ARG_SKIP_RESTART=""
ARG_USER_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)            ARG_MODE="$2";             shift 2 ;;
        --api-key)         ARG_API_KEY="$2";          shift 2 ;;
        --enable-graph)    ARG_ENABLE_GRAPH="1";      shift   ;;
        --enable-sleep)    ARG_ENABLE_SLEEP="1";      shift   ;;
        --embedding)       ARG_EMBEDDING="$2";        shift 2 ;;
        --embedding-model) ARG_EMBEDDING_MODEL="$2";  shift 2 ;;
        --ollama-url)      ARG_OLLAMA_URL="$2";       shift 2 ;;
        --user-id)         ARG_USER_ID="$2";          shift 2 ;;
        --skip-restart)    ARG_SKIP_RESTART="1";      shift   ;;
        -h|--help)
            echo "Usage: bash install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --mode MODE          Mode: platform or oss (open-source)"
            echo "  --api-key KEY        Mem0 API key (platform mode) or OpenAI key (OSS mode)"
            echo "  --embedding PROVIDER Embedding: ollama, openai, huggingface (OSS mode)"
            echo "  --embedding-model M  Embedding model name (OSS mode)"
            echo "  --ollama-url URL     Ollama base URL (default: http://localhost:11434)"
            echo "  --user-id ID         Default user ID (default: default)"
            echo "  --enable-graph       Enable graph memory"
            echo "  --enable-sleep       Enable sleep mode (background memory maintenance)"
            echo "  --skip-restart       Don't restart the gateway after install"
            echo "  -h, --help           Show this help"
            exit 0
            ;;
        *) error "Unknown option: $1"; exit 1 ;;
    esac
done

# --- Banner -----------------------------------------------------------------
echo ""
echo -e "${CYAN}"
echo '    ___  ____  _____ _   _  _____ _       _____      __'
echo '   / _ \|  _ \| ____| \ | |/ ____| |     / _ \ \    / /'
echo '  | | | | |_) |  _| |  \| | |    | |    | |_| |\ \/ / '
echo '  | |_| |  __/| |___| |\  | |____| |___ |  _  | \  /  '
echo '   \___/|_|   |_____|_| \_|\_____|_____|_| |_|  \/   '
echo ''
echo '             +===============================+'
echo '             |  m e m 0  v 2  E N H A N C E D |'
echo '             |  long-term memory plugin        |'
echo '             +===============================+'
echo -e "${NC}"
echo -e "  Repo:        ${DIM}$REPO_DIR${NC}"
echo -e "  Plugin dir:  ${DIM}$PLUGIN_DIR${NC}"
echo -e "  OpenClaw:    ${DIM}$OPENCLAW_HOME${NC}"
echo ""

# ============================================================================
# STEP 1: Copy plugin files
# ============================================================================
step "Step 1/6: Copying plugin files"

mkdir -p "$PLUGIN_DIR"

PLUGIN_FILES=(
    index.ts
    user-resolver.ts
    sleep-mode.ts
    types.ts
    openclaw.plugin.json
    package.json
)

for f in "${PLUGIN_FILES[@]}"; do
    if [ -f "$REPO_DIR/$f" ]; then
        cp "$REPO_DIR/$f" "$PLUGIN_DIR/$f"
    fi
done

# Copy config examples
mkdir -p "$PLUGIN_DIR/config"
if [ -d "$REPO_DIR/config" ]; then
    cp -r "$REPO_DIR/config/"* "$PLUGIN_DIR/config/" 2>/dev/null || true
fi

info "Plugin files copied to $PLUGIN_DIR"

# ============================================================================
# STEP 2: Install npm dependencies
# ============================================================================
step "Step 2/6: Installing dependencies"

if command -v npm &>/dev/null; then
    (cd "$PLUGIN_DIR" && npm install --production --quiet 2>&1) || {
        error "npm install failed"
        exit 1
    }
    info "npm dependencies installed"
else
    error "npm not found! Node.js is required."
    echo "  Install: https://nodejs.org/"
    exit 1
fi

# ============================================================================
# STEP 3: Interactive configuration
# ============================================================================
step "Step 3/6: Configuration"

# --- Mode selection ---
MODE="$ARG_MODE"
if [ -z "$MODE" ]; then
    echo ""
    echo -e "  ${BOLD}Select mode:${NC}"
    echo ""
    echo "    1) Platform (Mem0 cloud — requires Mem0 API key from app.mem0.ai)"
    echo "    2) Open-Source (self-hosted — uses local/API LLM + vector store)"
    echo ""
    while true; do
        echo -n "  Choose [1/2] (default: 2): "
        read -r MODE_CHOICE
        MODE_CHOICE="${MODE_CHOICE:-2}"
        case "$MODE_CHOICE" in
            1) MODE="platform"; break ;;
            2) MODE="oss"; break ;;
            *) error "Please enter 1 or 2" ;;
        esac
    done
fi
info "Mode: $MODE"

# --- API key ---
API_KEY="$ARG_API_KEY"
if [ "$MODE" = "platform" ] && [ -z "$API_KEY" ]; then
    echo ""
    echo -e "  ${BOLD}Mem0 API key${NC} (get one at: https://app.mem0.ai)"
    echo -n "  API key: "
    read -rs API_KEY
    echo ""
fi

# --- OSS mode: embedding + LLM config ---
EMBEDDING_PROVIDER=""
EMBEDDING_MODEL=""
OLLAMA_URL=""
LLM_PROVIDER=""
LLM_MODEL=""

if [ "$MODE" = "oss" ]; then
    # Embedding provider
    EMBEDDING_PROVIDER="$ARG_EMBEDDING"
    if [ -z "$EMBEDDING_PROVIDER" ]; then
        echo ""
        echo -e "  ${BOLD}Embedding provider:${NC}"
        echo ""
        echo "    1) Ollama (local, free, requires Ollama)"
        echo "    2) OpenAI (API, ~\$0.02/1M tokens)"
        echo ""
        while true; do
            echo -n "  Choose [1/2] (default: 1): "
            read -r EMB_CHOICE
            EMB_CHOICE="${EMB_CHOICE:-1}"
            case "$EMB_CHOICE" in
                1) EMBEDDING_PROVIDER="ollama"; break ;;
                2) EMBEDDING_PROVIDER="openai"; break ;;
                *) error "Please enter 1 or 2" ;;
            esac
        done
    fi
    info "Embedding: $EMBEDDING_PROVIDER"

    # Embedding model
    EMBEDDING_MODEL="$ARG_EMBEDDING_MODEL"
    if [ -z "$EMBEDDING_MODEL" ]; then
        if [ "$EMBEDDING_PROVIDER" = "ollama" ]; then
            EMBEDDING_MODEL="nomic-embed-text:latest"
        else
            EMBEDDING_MODEL="text-embedding-3-small"
        fi
        echo -n "  Embedding model (default: $EMBEDDING_MODEL): "
        read -r CUSTOM_MODEL
        if [ -n "$CUSTOM_MODEL" ]; then
            EMBEDDING_MODEL="$CUSTOM_MODEL"
        fi
    fi
    info "Embedding model: $EMBEDDING_MODEL"

    # Ollama URL
    if [ "$EMBEDDING_PROVIDER" = "ollama" ]; then
        OLLAMA_URL="${ARG_OLLAMA_URL:-http://localhost:11434}"
        echo -n "  Ollama URL (default: $OLLAMA_URL): "
        read -r CUSTOM_URL
        if [ -n "$CUSTOM_URL" ]; then
            OLLAMA_URL="$CUSTOM_URL"
        fi
        info "Ollama URL: $OLLAMA_URL"
    fi

    # LLM for fact extraction
    if [ -z "$API_KEY" ]; then
        echo ""
        echo -e "  ${BOLD}LLM API key${NC} (for fact extraction — OpenAI or compatible)"
        echo -n "  API key: "
        read -rs API_KEY
        echo ""
    fi
    LLM_PROVIDER="openai"
    LLM_MODEL="gpt-4o-mini"
    echo -n "  LLM model (default: $LLM_MODEL): "
    read -r CUSTOM_LLM
    if [ -n "$CUSTOM_LLM" ]; then
        LLM_MODEL="$CUSTOM_LLM"
    fi
    info "LLM: $LLM_MODEL"
fi

# --- User ID ---
USER_ID="${ARG_USER_ID:-default}"
echo -n "  Default user ID (default: $USER_ID): "
read -r CUSTOM_UID
if [ -n "$CUSTOM_UID" ]; then
    USER_ID="$CUSTOM_UID"
fi

# --- Graph memory ---
ENABLE_GRAPH="${ARG_ENABLE_GRAPH:-}"
if [ -z "$ENABLE_GRAPH" ]; then
    echo -n "  Enable graph memory? [y/N]: "
    read -r GRAPH_CHOICE
    if [[ "$GRAPH_CHOICE" =~ ^[Yy]$ ]]; then
        ENABLE_GRAPH="1"
    fi
fi

# --- Sleep mode ---
ENABLE_SLEEP="${ARG_ENABLE_SLEEP:-}"
if [ -z "$ENABLE_SLEEP" ]; then
    echo -n "  Enable sleep mode (background memory maintenance)? [Y/n]: "
    read -r SLEEP_CHOICE
    if [[ ! "$SLEEP_CHOICE" =~ ^[Nn]$ ]]; then
        ENABLE_SLEEP="1"
    fi
fi

# ============================================================================
# STEP 4: Generate plugin config in openclaw.json
# ============================================================================
step "Step 4/6: Configuring OpenClaw"

# Build the plugin config as JSON using node
PLUGIN_CONFIG=$(node -e "
const cfg = {
  mode: '${MODE}',
  userId: '${USER_ID}',
  autoCapture: true,
  autoRecall: true,
  enableGraph: ${ENABLE_GRAPH:+true}${ENABLE_GRAPH:-false},
  topK: 5,
  searchThreshold: 0.5,
  skipGroupChats: true,
};

if ('${MODE}' === 'platform') {
  cfg.apiKey = '\${MEM0_API_KEY}';
}

if ('${MODE}' === 'oss') {
  cfg.oss = {};
  if ('${EMBEDDING_PROVIDER}' === 'ollama') {
    cfg.oss.embedder = {
      provider: 'ollama',
      config: {
        model: '${EMBEDDING_MODEL}',
        ollama_base_url: '${OLLAMA_URL}'
      }
    };
  } else if ('${EMBEDDING_PROVIDER}' === 'openai') {
    cfg.oss.embedder = {
      provider: 'openai',
      config: {
        model: '${EMBEDDING_MODEL}',
        api_key: '\\\${OPENAI_API_KEY}'
      }
    };
  }
  if ('${LLM_PROVIDER}') {
    cfg.oss.llm = {
      provider: '${LLM_PROVIDER}',
      config: {
        model: '${LLM_MODEL}',
        api_key: '\\\${OPENAI_API_KEY}'
      }
    };
  }
  if (${ENABLE_GRAPH:+true}${ENABLE_GRAPH:-false}) {
    cfg.oss.graphStore = {
      provider: 'kuzu',
      config: {}
    };
  }
}

if (${ENABLE_SLEEP:+true}${ENABLE_SLEEP:-false}) {
  cfg.sleepMode = {
    enabled: true,
    logDir: 'memory/logs',
    digestDir: 'memory/digests',
    digestEnabled: true,
    retentionDays: 365,
    maxChunkChars: 4000
  };
}

console.log(JSON.stringify(cfg, null, 2));
")

# Patch openclaw.json
if [ -f "$CONFIG_FILE" ]; then
    node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf-8'));

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};

config.plugins.entries['mem0-memory'] = {
  config: ${PLUGIN_CONFIG}
};

// Ensure memory slot points to our plugin
if (!config.plugins.slots) config.plugins.slots = {};
config.plugins.slots.memory = 'mem0-memory';

fs.writeFileSync('${CONFIG_FILE}', JSON.stringify(config, null, 2) + '\n');
"
    info "openclaw.json updated"
else
    warn "openclaw.json not found — skipping config patch"
    echo "  You'll need to manually add the plugin config"
fi

# Set env vars hint
if [ "$MODE" = "platform" ]; then
    echo ""
    echo -e "  ${YELLOW}Set your Mem0 API key:${NC}"
    echo -e "  export MEM0_API_KEY=\"your-key-here\""
elif [ -n "$API_KEY" ]; then
    echo ""
    echo -e "  ${YELLOW}Set your OpenAI API key:${NC}"
    echo -e "  export OPENAI_API_KEY=\"your-key-here\""
fi

# ============================================================================
# STEP 5: Create memory directories
# ============================================================================
step "Step 5/6: Creating directories"

mkdir -p "$PLUGIN_DIR/memory/data"
mkdir -p "$PLUGIN_DIR/memory/logs"
mkdir -p "$PLUGIN_DIR/memory/digests"

info "Memory directories created"

# ============================================================================
# STEP 6: Restart gateway
# ============================================================================
step "Step 6/6: Restarting OpenClaw gateway"

if [ -n "$ARG_SKIP_RESTART" ]; then
    warn "Skipping gateway restart (--skip-restart)"
else
    if command -v openclaw &>/dev/null; then
        openclaw gateway restart 2>/dev/null && info "Gateway restarted" || warn "Gateway restart failed"
    else
        # Try launchctl on macOS
        if [ "$(uname)" = "Darwin" ]; then
            PLIST_LABEL="ai.openclaw.gateway"
            if launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
                launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null \
                    && info "Gateway restarted via launchctl" \
                    || warn "launchctl restart failed"
            else
                warn "Gateway service not found — restart manually"
            fi
        else
            warn "Could not auto-restart gateway — restart manually"
        fi
    fi
fi

# ============================================================================
# Done
# ============================================================================
echo ""
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo ""
echo "  Plugin: mem0-memory (Enhanced v2)"
echo "  Mode:   $MODE"
echo "  Graph:  ${ENABLE_GRAPH:+enabled}${ENABLE_GRAPH:-disabled}"
echo "  Sleep:  ${ENABLE_SLEEP:+enabled}${ENABLE_SLEEP:-disabled}"
echo ""
if [ -n "${ENABLE_SLEEP:-}" ]; then
    echo -e "  ${DIM}To run sleep maintenance manually: openclaw mem0-sleep${NC}"
    echo -e "  ${DIM}To set up nightly cron, add to openclaw.json:${NC}"
    echo -e '  ${DIM}  "automation": { "crons": [{ "schedule": "0 3 * * *", "agentMessage": "/mem0-sleep" }] }${NC}'
    echo ""
fi
echo -e "  Verify: ${CYAN}openclaw doctor${NC}"
echo ""
