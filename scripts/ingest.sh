#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Ingest Codebase
#
# Ingests source files into the IX knowledge graph. Parses code into entities
# (classes, functions, imports, config keys) and builds the versioned graph.
#
# Usage:
#   ./scripts/ingest.sh                          # Auto-detect src/ in current dir
#   ./scripts/ingest.sh ./src                    # Ingest specific directory
#   ./scripts/ingest.sh ./src/auth.py            # Ingest single file
#   ./scripts/ingest.sh ~/my-project/src         # Ingest from another project
#   ./scripts/ingest.sh --no-recursive ./src     # Don't recurse into subdirs
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"
IX_CMD="npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts"

# ── Parse arguments ──────────────────────────────────────────────────────────

INGEST_PATH=""
RECURSIVE="--recursive"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-recursive) RECURSIVE=""; shift ;;
    -h|--help)
      echo "Usage: ./scripts/ingest.sh [PATH] [OPTIONS]"
      echo ""
      echo "Arguments:"
      echo "  PATH             File or directory to ingest (default: auto-detect)"
      echo ""
      echo "Options:"
      echo "  --no-recursive   Don't recurse into subdirectories"
      echo "  -h, --help       Show this help"
      echo ""
      echo "Supported file types:"
      echo "  .py              Python (tree-sitter / regex parser)"
      echo "  .ts, .tsx        TypeScript (regex parser)"
      echo "  .json, .yaml     Config files (key extraction)"
      echo "  .yml, .toml      Config files (key extraction)"
      echo "  .md              Markdown (heading hierarchy)"
      echo ""
      echo "What this does:"
      echo "  1. Reads source files and computes SHA-256 hashes"
      echo "  2. Skips files that haven't changed since last ingestion"
      echo "  3. Parses entities (classes, functions, imports, config keys)"
      echo "  4. Builds graph patches with deterministic UUIDs"
      echo "  5. Commits patches atomically to ArangoDB"
      exit 0
      ;;
    *)
      INGEST_PATH="$1"
      shift
      ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -d "$CLI_DIR/dist" ] || [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "Error: CLI is not built. Run first:"
  echo "  ./scripts/build-cli.sh"
  exit 1
fi

if ! curl -sf http://localhost:8090/v1/health > /dev/null 2>&1; then
  echo "Error: Backend is not running. Start it first:"
  echo "  ./scripts/backend.sh up"
  exit 1
fi

# ── Auto-detect path ─────────────────────────────────────────────────────────

if [ -z "$INGEST_PATH" ]; then
  if [ -d "./src" ]; then
    INGEST_PATH="./src"
    echo "Auto-detected: ./src"
  elif [ -d "./lib" ]; then
    INGEST_PATH="./lib"
    echo "Auto-detected: ./lib"
  elif [ -d "./app" ]; then
    INGEST_PATH="./app"
    echo "Auto-detected: ./app"
  else
    INGEST_PATH="."
    echo "No src/lib/app directory found — ingesting current directory"
  fi
fi

# Resolve to absolute path
INGEST_PATH="$(cd "$INGEST_PATH" 2>/dev/null && pwd || echo "$INGEST_PATH")"

# ── Ingest ───────────────────────────────────────────────────────────────────

echo "Ingesting: $INGEST_PATH"
echo ""

$IX_CMD ingest "$INGEST_PATH" $RECURSIVE

echo ""
echo "[ok] Ingestion complete"
