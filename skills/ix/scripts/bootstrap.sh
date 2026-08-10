#!/usr/bin/env bash
#
# Ix skill bootstrap — install the ix CLI, start the local backend, and map a repo.
#
# Usage:
#   bash scripts/bootstrap.sh [repo-root] [--no-map]
#
# Flags:
#   --no-map       setup only (CLI + backend); do not run `ix map`
#   --no-backend   do not start/wait for the Docker backend (CLI install only)
#
# Env overrides:
#   IX_SKIP_INSTALL=1   skip the ix CLI install step
#   IX_SKIP_BACKEND=1   same as --no-backend
#   IX_SKIP_MAP=1       same as --no-map
#
# Requires: Node.js >= 22, git, Docker (backend), ripgrep (for `ix text`, optional).
# Works on macOS, Linux, and Windows under Git Bash / MSYS2 / WSL.

set -euo pipefail

REPO="${1:-$PWD}"
if [ "${REPO}" = "--no-map" ] || [ "${REPO}" = "--no-backend" ]; then
  REPO="$PWD"
fi
DO_MAP=1
DO_BACKEND=1
for arg in "$@"; do
  case "$arg" in
    --no-map) DO_MAP=0 ;;
    --no-backend) DO_BACKEND=0 ;;
    --*) ;;
  esac
done
[ "${IX_SKIP_MAP:-0}" = "1" ] && DO_MAP=0
[ "${IX_SKIP_BACKEND:-0}" = "1" ] && DO_BACKEND=0

info() { printf '\033[1;36m[ix-skill]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ix-skill]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ix-skill]\033[0m %s\n' "$*" >&2; exit 1; }

# Detect Windows (Git Bash / MSYS2 / Cygwin).
is_windows() { [ -n "${MSYSTEM:-}" ] || [ -n "${WSL_DISTRO_NAME:-}" ] || case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

version_ge() { # version_ge <got> <want>
  printf '%s\n%s\n' "$2" "$1" | sort -V -C -r 2>/dev/null
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

info "Ix skill bootstrap — repo: $REPO"

# --- Prerequisites -----------------------------------------------------------
node_ok=0
if command_exists node; then
  node_ver="$(node --version | tr -d 'v')"
  if version_ge "$node_ver" "22"; then node_ok=1; else warn "Node $node_ver detected; Ix requires Node >= 22."; fi
else
  warn "Node.js not found; Ix requires Node >= 22 (https://nodejs.org)."
fi

command_exists git || warn "git not found; Ix uses it for workspace detection."

if command_exists rg; then
  info "ripgrep found (powers 'ix text')."
else
  warn "ripgrep not found — 'ix text' will not work. Install it (macOS: brew install ripgrep; Linux: apt/dnf install ripgrep; Windows: choco install ripgrep)."
fi

if command_exists docker; then
  if docker info >/dev/null 2>&1; then
    info "Docker daemon is running."
  else
    warn "Docker is installed but the daemon is NOT running. Start Docker Desktop / the Docker service first, then re-run this script."
    [ "$DO_BACKEND" = "1" ] && DO_BACKEND=0 && warn "Skipping backend start for now (daemon not up)."
  fi
else
  warn "Docker not found — the Ix backend needs Docker. Install Docker Desktop / Docker Engine, then re-run this script."
  DO_BACKEND=0
fi

# --- Resolve the ix CLI -------------------------------------------------------
# The Windows installer ships ix.cmd and registers ~/.ix/bin in the user PATH,
# but long-lived shells and agents spawned before the install may not see it.
# Resolve the standard install location before deciding whether to install.
if ! command_exists ix && [ -x "$HOME/.ix/bin/ix" ]; then
  export PATH="$HOME/.ix/bin:$PATH"
  info "Found ix at $HOME/.ix/bin — added to PATH for this session."
fi

# --- Install the ix CLI (only if still missing) --------------------------------
if command_exists ix; then
  info "ix CLI already installed: $(ix --version 2>/dev/null || echo present)."
elif [ "${IX_SKIP_INSTALL:-0}" = "1" ]; then
  warn "IX_SKIP_INSTALL=1 — skipping ix CLI install. 'ix' is not on PATH."
else
  info "Installing the ix CLI (official installer)…"
  if is_windows; then
    if command_exists powershell; then
      powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ix-infra.com/install.ps1 | iex"
    else
      fail "Windows detected but powershell not found. Run in PowerShell: irm https://ix-infra.com/install.ps1 | iex"
    fi
  else
    curl -fsSL https://ix-infra.com/install.sh | sh
  fi
  # A fresh install only updates the user PATH, which new processes pick up but
  # the current shell does not. Resolve the standard location explicitly.
  if ! command_exists ix && [ -x "$HOME/.ix/bin/ix" ]; then
    export PATH="$HOME/.ix/bin:$PATH"
  fi
  command_exists ix || fail "ix CLI install finished but 'ix' is still not on PATH. Restart your shell, or check ~/.ix/cli and PATH, then re-run this script."
  info "ix CLI installed."
fi
command_exists ix || fail "The ix CLI is not on PATH. Run the official installer, restart your shell, then re-run this bootstrap."

# --- Compass (visualizer UI) --------------------------------------------------
# The official installer re-extracts the CLI tarball over the ix home and wipes
# the Compass assets, which ship only via `ix upgrade`. Ensure they exist so
# `ix view` never silently breaks after an installer re-run.
ensure_compass() {
  local ix_home="${IX_HOME:-$HOME/.ix}"
  if [ -f "$ix_home/cli/compass/index.html" ]; then
    info "Compass UI present."
    return 0
  fi
  warn "Compass UI missing at $ix_home/cli/compass (a re-install likely wiped it) — running 'ix upgrade' to restore it."
  ix upgrade || warn "'ix upgrade' failed — 'ix view' will be unavailable until it is re-run."
}
if [ "${IX_SKIP_COMPASS:-0}" != "1" ]; then
  ensure_compass
fi

# Re-apply the Compass fit-view patch (F-key fit view + auto-frame on load).
# The installer wipes the Compass dir, so re-apply after every install/upgrade.
if [ "${IX_SKIP_COMPASS_PATCH:-0}" != "1" ]; then
  if bash "$(dirname "${BASH_SOURCE[0]}")/compass-patch/apply.sh" >/dev/null 2>&1; then
    info "Compass fit-view patch applied (F = fit view)."
  else
    warn "Compass fit-view patch not applied — run: bash skills/ix/scripts/compass-patch/apply.sh"
  fi
fi

# --- Backend ------------------------------------------------------------------
if [ "$DO_BACKEND" = "1" ]; then
  info "Starting the Ix backend (ArangoDB + memory layer)…"
  ix docker start || warn "`ix docker start` reported a problem — run `ix doctor` and `ix status` for details."
  for _ in $(seq 1 15); do
    if ix status >/dev/null 2>&1; then break; fi
    sleep 2
  done
  ix status || warn "Backend still not reachable. Run: ix docker start && ix doctor"
fi

# --- Map the repo -------------------------------------------------------------
if [ "$DO_MAP" = "1" ]; then
  info "Mapping $REPO — this builds the persistent graph (can take a while on large repos)…"
  ( cd "$REPO" && ix map . )
fi

info "Done. Try: ix explain <symbol>, ix trace <flow>, ix impact <symbol> --format llm"
