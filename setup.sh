#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# IX-Memory — Setup
#
# Starts the IX backend (ArangoDB + Memory Layer) and builds the CLI.
# This runs from the IX-Memory repo — it does NOT touch your projects.
#
# To connect a project, run: ./scripts/connect.sh ~/my-project
#
# Usage:
#   ./setup.sh                     # Start backend + build CLI + install global ix command
#   ./setup.sh --skip-backend      # Just build CLI + install global ix command
#   ./setup.sh --skip-global-ix    # Skip installing global ix command
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BACKEND=false
SKIP_GLOBAL_IX=false

ensure_local_bin_on_path() {
  local path_line='export PATH="$HOME/.local/bin:$PATH"'
  local rc_files=()

  if [ -f "$HOME/.bashrc" ]; then
    rc_files+=("$HOME/.bashrc")
  fi
  if [ -f "$HOME/.zshrc" ]; then
    rc_files+=("$HOME/.zshrc")
  fi
  if [ "${#rc_files[@]}" -eq 0 ]; then
    rc_files=("$HOME/.bashrc")
  fi

  for rc in "${rc_files[@]}"; do
    if [ ! -f "$rc" ]; then
      touch "$rc"
    fi
    if ! grep -Fq "$path_line" "$rc"; then
      echo "" >> "$rc"
      echo "# Added by IX-Memory setup" >> "$rc"
      echo "$path_line" >> "$rc"
    fi
  done
}

install_global_ix() {
  local local_bin="$HOME/.local/bin"
  local ix_shim="$local_bin/ix"
  local ix_entry="$IX_DIR/ix-cli/dist/cli/main.js"

  mkdir -p "$local_bin"

  cat > "$ix_shim" <<EOF
#!/usr/bin/env bash
exec node "$ix_entry" "\$@"
EOF
  chmod +x "$ix_shim"

  ensure_local_bin_on_path
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backend) SKIP_BACKEND=true; shift ;;
    --skip-global-ix) SKIP_GLOBAL_IX=true; shift ;;
    -h|--help)
      echo "Usage: ./setup.sh [OPTIONS]"
      echo ""
      echo "Starts the IX-Memory backend, builds the CLI, and installs an 'ix' command."
      echo ""
      echo "Options:"
      echo "  --skip-backend   Skip backend startup (if already running)"
      echo "  --skip-global-ix Skip installing ~/.local/bin/ix shim"
      echo "  -h, --help       Show this help"
      echo ""
      echo "After setup, connect a project:"
      echo "  ./scripts/connect.sh ~/my-project"
      echo ""
      echo "Individual scripts:"
      echo "  ./scripts/backend.sh        Start/stop Docker containers"
      echo "  ./scripts/build-cli.sh      Build the TypeScript CLI"
      echo "  ./scripts/connect.sh        Connect a project (MCP + CLAUDE.md + ingest)"
      echo "  ./scripts/disconnect.sh     Disconnect a project"
      echo "  ./scripts/ingest.sh         Ingest files into the graph"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run './setup.sh --help' for usage."
      exit 1
      ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       IX-Memory — Setup                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Backend ──────────────────────────────────────────────────────────

echo "── [1] Backend ────────────────────────────────────"
if [ "$SKIP_BACKEND" = true ]; then
  echo "  (skipped via --skip-backend)"
  if ! "$IX_DIR/scripts/backend.sh" check 2>/dev/null; then
    echo "  Warning: Backend is not responding."
  fi
else
  "$IX_DIR/scripts/backend.sh" up
fi

echo ""

# ── Step 2: Build CLI ────────────────────────────────────────────────────────

echo "── [2] Build CLI ──────────────────────────────────"
"$IX_DIR/scripts/build-cli.sh"

# ── Step 3: Install Global ix Command ───────────────────────────────────────

echo ""
echo "── [3] Global ix command ──────────────────────────"
if [ "$SKIP_GLOBAL_IX" = true ]; then
  echo "  (skipped via --skip-global-ix)"
else
  install_global_ix
  echo "  [ok] Installed: ~/.local/bin/ix"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       IX backend is ready!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Backend:  http://localhost:8090"
echo "  ArangoDB: http://localhost:8529"
echo ""
echo "  CLI:      ix status"
echo "            (open a new shell, or run: export PATH=\"\$HOME/.local/bin:\$PATH\")"
echo ""
echo "  Next: connect a project to IX:"
echo "    ./scripts/connect.sh ~/my-project"
echo ""
echo "  Or with a specific IDE:"
echo "    ./scripts/connect.sh ~/my-project --cursor"
echo ""
