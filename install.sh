#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ix — Standalone Installer
#
# Installs everything needed to run Ix without cloning the repo:
#   1. Docker (checks / prompts)
#   2. Backend (ArangoDB + Memory Layer via Docker)
#   3. ix CLI
#   4. Claude Code hooks (if Claude Code is installed)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/install.sh | bash
#
# Options (env vars):
#   IX_VERSION=0.2.0          Override version (default: latest)
#   IX_SKIP_BACKEND=1         Skip Docker backend setup
#   IX_SKIP_HOOKS=1           Skip Claude Code hook installation
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────

GITHUB_ORG="ix-infrastructure"
GITHUB_REPO="Ix"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main"
IX_HOME="${IX_HOME:-$HOME/.ix}"
IX_BIN="$HOME/.local/bin"
IX_DATA="$IX_HOME/data"
COMPOSE_DIR="$IX_HOME/backend"

HEALTH_URL="http://localhost:8090/v1/health"
ARANGO_URL="http://localhost:8529/_api/version"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { printf "  \033[32m[ok]\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m[!!]\033[0m %s\n" "$*" >&2; }
err()   { printf "  \033[31m[error]\033[0m %s\n" "$*" >&2; exit 1; }
step()  { printf "\n── %s ──\n" "$*"; }

# ── Resolve version ─────────────────────────────────────────────────────────

resolve_version() {
  if [ -n "${IX_VERSION:-}" ]; then
    echo "$IX_VERSION"
    return
  fi

  # Try GitHub API for latest release
  if command -v curl >/dev/null 2>&1; then
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"v\(.*\)".*/\1/' || true)
    if [ -n "$latest" ]; then
      echo "$latest"
      return
    fi
  fi

  # Fallback
  echo "0.1.0"
}

# ── Detect platform ─────────────────────────────────────────────────────────

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *)      err "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             err "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# ── PATH helper ──────────────────────────────────────────────────────────────

ensure_path() {
  local path_line='export PATH="$HOME/.local/bin:$PATH"'
  local rc_files=()

  [ -f "$HOME/.zshrc" ]  && rc_files+=("$HOME/.zshrc")
  [ -f "$HOME/.bashrc" ] && rc_files+=("$HOME/.bashrc")
  [ "${#rc_files[@]}" -eq 0 ] && rc_files=("$HOME/.zshrc")

  for rc in "${rc_files[@]}"; do
    [ -f "$rc" ] || touch "$rc"
    if ! grep -Fq '.local/bin' "$rc" 2>/dev/null; then
      printf '\n# Added by Ix installer\n%s\n' "$path_line" >> "$rc"
    fi
  done
}

# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — Install                ║"
echo "╚══════════════════════════════════════════╝"
echo ""

VERSION=$(resolve_version)
PLATFORM=$(detect_platform)
echo "  Version:  $VERSION"
echo "  Platform: $PLATFORM"

# ── Step 1: Check / Install Docker ───────────────────────────────────────────

step "1. Docker"

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_BACKEND=1)"
else
  if command -v docker >/dev/null 2>&1; then
    info "Docker is installed"
  else
    echo ""
    echo "  Docker is required to run the IX backend (ArangoDB + Memory Layer)."
    echo ""
    case "$(uname -s)" in
      Darwin)
        echo "  Install Docker Desktop for macOS:"
        echo "    https://docs.docker.com/desktop/install/mac-install/"
        echo ""
        echo "  Or via Homebrew:"
        echo "    brew install --cask docker"
        ;;
      Linux)
        echo "  Install Docker Engine:"
        echo "    https://docs.docker.com/engine/install/"
        echo ""
        echo "  Quick install:"
        echo "    curl -fsSL https://get.docker.com | sh"
        ;;
    esac
    echo ""
    err "Install Docker and re-run this installer."
  fi

  # Check Docker is running
  if ! docker info >/dev/null 2>&1; then
    echo ""
    echo "  Docker is installed but not running."
    case "$(uname -s)" in
      Darwin)
        echo "  Trying to start Docker Desktop..."
        if [ -d "/Applications/Docker.app" ]; then
          open -a Docker
          echo "  Waiting for Docker to start (this can take 30-60 seconds)..."
          for i in $(seq 1 30); do
            if docker info >/dev/null 2>&1; then break; fi
            printf "."
            sleep 2
          done
          echo ""
        fi
        ;;
    esac

    if ! docker info >/dev/null 2>&1; then
      err "Docker is not running. Start Docker and re-run this installer."
    fi
  fi
  info "Docker is running"
fi

# ── Step 2: Start Backend ────────────────────────────────────────────────────

step "2. Backend (ArangoDB + Memory Layer)"

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_BACKEND=1)"
else
  # Check if already running and healthy
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1 && curl -sf "$ARANGO_URL" >/dev/null 2>&1; then
    info "Backend is already running and healthy"
  else
    # Kill any stale process on 8090 that isn't Docker
    stale_pid=$(lsof -ti :8090 2>/dev/null || true)
    if [ -n "$stale_pid" ]; then
      # Check if it's a Docker process — if not, kill it
      stale_cmd=$(ps -p "$stale_pid" -o comm= 2>/dev/null || true)
      if [ "$stale_cmd" != "com.docker.ba" ] && [ "$stale_cmd" != "docker" ]; then
        warn "Killing stale process on port 8090 (PID $stale_pid: $stale_cmd)"
        kill "$stale_pid" 2>/dev/null || true
        sleep 1
      fi
    fi

    mkdir -p "$COMPOSE_DIR"

    # Download docker-compose.yml
    curl -fsSL "${GITHUB_RAW}/docker-compose.standalone.yml" -o "$COMPOSE_DIR/docker-compose.yml"
    info "Downloaded docker-compose.yml → $COMPOSE_DIR"

    # Start services
    echo "  Starting backend services (this may take a minute on first run)..."
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d --pull always 2>&1 | sed 's/^/  /'

    # Wait for health
    echo "  Waiting for services to become healthy..."
    for i in $(seq 1 30); do
      if curl -sf "$HEALTH_URL" >/dev/null 2>&1 && curl -sf "$ARANGO_URL" >/dev/null 2>&1; then
        break
      fi
      printf "."
      sleep 2
    done
    echo ""

    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      info "Backend is ready"
    else
      warn "Backend may still be starting — check: docker compose -f $COMPOSE_DIR/docker-compose.yml logs"
    fi
  fi

  echo "  Memory Layer: http://localhost:8090"
  echo "  ArangoDB:     http://localhost:8529"
fi

# ── Step 3: Install ix CLI ───────────────────────────────────────────────────

step "3. ix CLI"

TARBALL_NAME="ix-${VERSION}-${PLATFORM}.tar.gz"
TARBALL_URL="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${VERSION}/${TARBALL_NAME}"
INSTALL_DIR="$IX_HOME/cli"

# Check if already installed at correct version
if [ -x "$IX_BIN/ix" ]; then
  existing_version=$("$IX_BIN/ix" --version 2>/dev/null || echo "unknown")
  if [ "$existing_version" = "$VERSION" ]; then
    info "ix CLI v${VERSION} is already installed"
  else
    echo "  Upgrading ix CLI from $existing_version to $VERSION..."
    rm -rf "$INSTALL_DIR"
  fi
fi

if [ ! -x "$IX_BIN/ix" ] || [ "$("$IX_BIN/ix" --version 2>/dev/null || echo "")" != "$VERSION" ]; then
  mkdir -p "$INSTALL_DIR" "$IX_BIN"

  echo "  Downloading ix CLI v${VERSION} for ${PLATFORM}..."
  if ! curl -fsSL "$TARBALL_URL" -o "/tmp/${TARBALL_NAME}" 2>/dev/null; then
    echo ""
    warn "Could not download pre-built CLI from:"
    warn "  $TARBALL_URL"
    echo ""
    echo "  This likely means the release asset hasn't been uploaded yet."
    echo "  You can build from source instead:"
    echo ""
    echo "    git clone https://github.com/${GITHUB_ORG}/${GITHUB_REPO}.git"
    echo "    cd ${GITHUB_REPO} && ./setup.sh"
    echo ""
    err "CLI download failed. See above for alternatives."
  fi

  # Extract
  tar -xzf "/tmp/${TARBALL_NAME}" -C "$INSTALL_DIR" --strip-components=1
  rm -f "/tmp/${TARBALL_NAME}"
  info "Extracted CLI → $INSTALL_DIR"

  # Create shim
  cat > "$IX_BIN/ix" <<SHIM
#!/usr/bin/env bash
exec "$INSTALL_DIR/ix" "\$@"
SHIM
  chmod +x "$IX_BIN/ix"

  ensure_path
  info "Installed: ~/.local/bin/ix"
fi

# ── Step 4: Claude Code Hooks ────────────────────────────────────────────────

step "4. Claude Code Plugin"

if [ "${IX_SKIP_HOOKS:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_HOOKS=1)"
elif ! command -v claude >/dev/null 2>&1; then
  echo "  (skipped — claude CLI not found)"
  echo "  Install Claude Code and re-run, or install hooks manually:"
  echo "    curl -fsSL ${GITHUB_RAW}/ix-plugin/install.sh | bash"
else
  # Download and run the hook installer
  curl -fsSL "${GITHUB_RAW}/ix-plugin/install.sh" | bash
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix is ready!                ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Backend:  http://localhost:8090"
echo "  ArangoDB: http://localhost:8529"
echo "  CLI:      ix status"
echo ""
echo "  Open a new shell (or run: export PATH=\"\$HOME/.local/bin:\$PATH\")"
echo ""
echo "  Connect a project:"
echo "    cd ~/my-project && ix init"
echo "    ix ingest ./src --recursive"
echo ""
echo "  To uninstall:"
echo "    curl -fsSL ${GITHUB_RAW}/uninstall.sh | bash"
echo ""
