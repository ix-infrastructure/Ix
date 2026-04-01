#!/usr/bin/env bash
# Ix — Standalone Installer
#
# Installs everything needed to run Ix without cloning the repo:
#   1. Node.js (checks / installs / upgrades)
#   2. Docker (checks / prompts)
#   3. Backend (ArangoDB + Memory Layer via Docker)
#   4. ix CLI
#
# Usage:
#   curl -fsSL https://ix-infra.com/install.sh | sh
#
# Options (env vars):
#   IX_VERSION=0.2.0          Override version (default: latest)
#   IX_SKIP_BACKEND=1         Skip Docker backend setup

set -euo pipefail

# -- Config --

GITHUB_ORG="ix-infrastructure"
GITHUB_REPO="Ix"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main"

IX_HOME="${IX_HOME:-$HOME/.ix}"
IX_DATA="$IX_HOME/data"
COMPOSE_DIR="$IX_HOME/backend"

HEALTH_URL="http://localhost:8090/v1/health"
ARANGO_URL="http://localhost:8529/_api/version"

NODE_MIN_MAJOR=18

if [[ "$(uname -s)" =~ MINGW|MSYS|CYGWIN ]]; then
  export IX_HOST_MOUNT_ROOT="$(cygpath -m "$HOME")"
  export IX_CONTAINER_MOUNT_ROOT="${HOME}"
  dc() {
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker compose "$@"
  }
else
  export IX_HOST_MOUNT_ROOT="${HOME}"
  export IX_CONTAINER_MOUNT_ROOT="${HOME}"
  dc() { docker compose "$@"; }
fi

# Pick a bin dir that's already in PATH and writable
pick_bin_dir() {
  # Prefer /usr/local/bin (already in PATH everywhere)
  if [ -w "/usr/local/bin" ] || [ -w "/usr/local" ]; then
    echo "/usr/local/bin"
    return
  fi
  # Fallback to ~/.local/bin
  mkdir -p "$HOME/.local/bin"
  echo "$HOME/.local/bin"
}

IX_BIN="$(pick_bin_dir)"

# -- Helpers --

info()  { printf "  \033[32m[ok]\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m[!!]\033[0m %s\n" "$*" >&2; }
err()   { printf "  \033[31m[error]\033[0m %s\n" "$*" >&2; exit 1; }
step()  { printf "\n-- %s --\n" "$*"; }

ensure_path() {
  # Only needed if using ~/.local/bin
  if [ "$IX_BIN" = "/usr/local/bin" ]; then return; fi

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

# -- Resolve version --

resolve_version() {
  if [ -n "${IX_VERSION:-}" ]; then
    echo "$IX_VERSION"
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    local latest
    latest=$(curl -fsSL "https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' || true)
    if [ -n "$latest" ]; then
      echo "$latest"
      return
    fi
  fi

  echo "0.1.0"
}

# -- Detect platform --

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    mingw*|msys*|cygwin*) os="windows" ;;
    *)      err "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             err "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# ==============================================================================
#  MAIN
# ==============================================================================

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — Install                ║"
echo "╚══════════════════════════════════════════╝"
echo ""

VERSION=$(resolve_version)
PLATFORM=$(detect_platform)
echo "  Version:  $VERSION"
echo "  Platform: $PLATFORM"

# -- Step 1: Check / Install Node.js --

step "1. Node.js (runtime)"

node_version_major() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_or_upgrade_node() {
  local action="$1"  # "Installing" or "Upgrading"
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        echo "  ${action} Node.js via Homebrew..."
        if [ "$action" = "Upgrading" ]; then
          brew upgrade node < /dev/null 2>/dev/null || brew install node < /dev/null
        else
          brew install node < /dev/null 2>/dev/null || true
        fi
        # Handle "installed but not linked" — common when a previous version left stale symlinks
        if ! command -v node >/dev/null 2>&1; then
          echo "  Linking Node.js..."
          if ! brew link --overwrite node < /dev/null 2>/dev/null; then
            # Fix ownership on dirs Homebrew needs to symlink into
            for dir in /usr/local/include/node /usr/local/lib/node_modules /usr/local/share/doc/node; do
              if [ -d "$dir" ] && [ ! -w "$dir" ]; then
                sudo chown -R "$(whoami)" "$dir" < /dev/null 2>/dev/null || true
              fi
            done
            brew link --overwrite node < /dev/null 2>/dev/null || true
          fi
        fi
      else
        echo "  ${action} Node.js via official installer..."
        local node_pkg arch node_ver
        node_pkg=$(mktemp /tmp/node-XXXXXX.pkg)
        arch="$(uname -m)"
        # Resolve latest LTS version dynamically
        node_ver=$(curl -fsSL "https://nodejs.org/dist/index.json" \
          | sed -n 's/.*"version":"v\([^"]*\)".*"lts":[^f].*/\1/p' \
          | head -1)
        if [ -z "$node_ver" ]; then node_ver="22.14.0"; fi
        if [ "$arch" = "arm64" ]; then
          curl -fsSL "https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-darwin-arm64.pkg" -o "$node_pkg"
        else
          curl -fsSL "https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-darwin-x64.pkg" -o "$node_pkg"
        fi
        sudo installer -pkg "$node_pkg" -target / < /dev/null
        rm -f "$node_pkg"
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (apt)..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - < /dev/null
        sudo apt-get install -y nodejs < /dev/null
      elif command -v dnf >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (dnf)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - < /dev/null
        sudo dnf install -y nodejs < /dev/null
      elif command -v yum >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (yum)..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - < /dev/null
        sudo yum install -y nodejs < /dev/null
      elif command -v apk >/dev/null 2>&1; then
        echo "  ${action} Node.js via apk..."
        sudo apk add --update nodejs npm < /dev/null
      else
        err "Could not detect a supported package manager (apt, dnf, yum, apk). Install Node.js ${NODE_MIN_MAJOR}+ manually: https://nodejs.org/"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo ""
      echo "  Node.js ${NODE_MIN_MAJOR}+ is required."
      echo "  Download from: https://nodejs.org/"
      echo ""
      err "Install Node.js and re-run this installer."
      ;;
    *)
      err "Unsupported OS. Install Node.js ${NODE_MIN_MAJOR}+ manually: https://nodejs.org/"
      ;;
  esac
}

if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node_version_major)
  if [ "$CURRENT_NODE" -ge "$NODE_MIN_MAJOR" ]; then
    info "Node.js $(node -v) is installed (>= ${NODE_MIN_MAJOR} required)"
  else
    warn "Node.js $(node -v) is too old (>= ${NODE_MIN_MAJOR} required)"
    install_or_upgrade_node "Upgrading"
    # Re-check after upgrade
    if ! command -v node >/dev/null 2>&1; then
      err "Node.js upgrade failed. Install Node.js ${NODE_MIN_MAJOR}+ manually: https://nodejs.org/"
    fi
    CURRENT_NODE=$(node_version_major)
    if [ "$CURRENT_NODE" -lt "$NODE_MIN_MAJOR" ]; then
      err "Node.js upgrade resulted in $(node -v), still below ${NODE_MIN_MAJOR}. Install manually: https://nodejs.org/"
    fi
    info "Node.js upgraded to $(node -v)"
  fi
else
  install_or_upgrade_node "Installing"
  # Rehash PATH — brew/apt may have just added node
  hash -r 2>/dev/null || true
  if ! command -v node >/dev/null 2>&1; then
    # Try common install locations
    for p in /usr/local/bin/node /opt/homebrew/bin/node; do
      if [ -x "$p" ]; then
        export PATH="$(dirname "$p"):$PATH"
        break
      fi
    done
  fi
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js installation failed. Install Node.js ${NODE_MIN_MAJOR}+ manually: https://nodejs.org/"
  fi
  info "Node.js $(node -v) installed"
fi

# -- Step 2: Check / Install Docker --

step "2. Docker"

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
      MINGW*|MSYS*|CYGWIN*)
        echo "  Install Docker Desktop for Windows:"
        echo "    https://docs.docker.com/desktop/install/windows-install/"
        ;;
    esac
    echo ""
    err "Install Docker and re-run this installer."
  fi

  if ! docker info < /dev/null >/dev/null 2>&1; then
    echo ""
    echo "  Docker is installed but not running."
    case "$(uname -s)" in
      Darwin)
        echo "  Trying to start Docker Desktop..."
        if [ -d "/Applications/Docker.app" ]; then
          open -a Docker
          echo "  Waiting for Docker to start (this can take 30-60 seconds)..."
          for i in $(seq 1 30); do
            if docker info < /dev/null >/dev/null 2>&1; then break; fi
            printf "."
            sleep 2
          done
          echo ""
        fi
        ;;
    esac

    if ! docker info < /dev/null >/dev/null 2>&1; then
      err "Docker is not running. Start Docker and re-run this installer."
    fi
  fi
  info "Docker is running"
fi

# -- Step 3: Start Backend --

step "3. Backend (ArangoDB + Memory Layer)"

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_BACKEND=1)"
else
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1 && curl -sf "$ARANGO_URL" >/dev/null 2>&1; then
    info "Backend is already running and healthy"
  else
    if command -v lsof >/dev/null 2>&1; then
      stale_pid=$(lsof -ti :8090 2>/dev/null || true)
      if [ -n "$stale_pid" ]; then
        stale_cmd=$(ps -p "$stale_pid" -o comm= 2>/dev/null || true)
        if [ "$stale_cmd" != "com.docker.ba" ] && [ "$stale_cmd" != "docker" ]; then
          warn "Killing stale process on port 8090 (PID $stale_pid: $stale_cmd)"
          kill "$stale_pid" 2>/dev/null || true
          sleep 1
        fi
      fi
    fi

    mkdir -p "$COMPOSE_DIR"

    curl -fsSL "${GITHUB_RAW}/docker-compose.standalone.yml" -o "$COMPOSE_DIR/docker-compose.yml"
    info "Downloaded docker-compose.yml"

    printf "  Starting backend services (this may take a minute on first run)..."
    dc -f "$COMPOSE_DIR/docker-compose.yml" up -d --pull always < /dev/null >/dev/null 2>&1 &
    DOCKER_PID=$!
    while kill -0 "$DOCKER_PID" 2>/dev/null; do
      printf "."
      sleep 1
    done
    wait "$DOCKER_PID" || true
    echo ""

    printf "  Waiting for services to become healthy..."
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

# -- Step 4: Install ix CLI --

step "4. ix CLI"

if [ "$PLATFORM" = "windows-amd64" ]; then
  TARBALL_NAME="ix-${VERSION}-${PLATFORM}.zip"
else
  TARBALL_NAME="ix-${VERSION}-${PLATFORM}.tar.gz"
fi
TARBALL_URL="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${VERSION}/${TARBALL_NAME}"
INSTALL_DIR="$IX_HOME/cli"

# Remove any stale ix from other locations
for old_ix in "$HOME/.local/bin/ix" "/usr/local/bin/ix"; do
  if [ "$old_ix" != "$IX_BIN/ix" ] && [ -f "$old_ix" ]; then
    rm -f "$old_ix" 2>/dev/null || true
  fi
done

# Check if already installed at correct version
# On Windows, avoid invoking the shim (calls cmd.exe, hangs in bash subshell)
check_installed_version() {
  if [ "$PLATFORM" = "windows-amd64" ]; then
    if [ -d "$INSTALL_DIR/ix-${VERSION}-windows-amd64" ]; then
      echo "$VERSION"
    else
      echo "unknown"
    fi
  else
    "$IX_BIN/ix" --version 2>/dev/null || echo "unknown"
  fi
}

if [ -x "$IX_BIN/ix" ]; then
  existing_version=$(check_installed_version)
  if [ "$existing_version" = "$VERSION" ]; then
    info "ix CLI v${VERSION} is already installed"
  else
    echo "  Upgrading ix CLI from $existing_version to $VERSION..."
    rm -rf "$INSTALL_DIR"
  fi
fi

if [ ! -x "$IX_BIN/ix" ] || [ "$(check_installed_version)" != "$VERSION" ]; then
  mkdir -p "$INSTALL_DIR"

  TMP_DIR=$(mktemp -d)
  TMP_FILE="$TMP_DIR/${TARBALL_NAME}"

  echo "  Downloading ix CLI v${VERSION} for ${PLATFORM}..."
  if ! curl -fsSL "$TARBALL_URL" -o "$TMP_FILE" 2>/dev/null; then
    rm -rf "$TMP_DIR"
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
  if [ "$PLATFORM" = "windows-amd64" ]; then
    unzip -q "$TMP_FILE" -d "$INSTALL_DIR"
  else
    tar -xzf "$TMP_FILE" -C "$INSTALL_DIR" --strip-components=1
  fi
  rm -rf "$TMP_DIR"
  info "Extracted CLI"

  # Create wrapper in bin dir
  if [ "$PLATFORM" = "windows-amd64" ]; then
    IX_JS="$INSTALL_DIR/ix-${VERSION}-windows-amd64/cli/dist/cli/main.js"
    cat > "$IX_BIN/ix" <<SHIM
#!/usr/bin/env bash
exec node "$IX_JS" "\$@"
SHIM
  else
    cat > "$IX_BIN/ix" <<SHIM
#!/usr/bin/env bash
exec "$INSTALL_DIR/ix" "\$@"
SHIM
  fi
  chmod +x "$IX_BIN/ix"

  ensure_path

  info "Installed: $IX_BIN/ix"
fi

# -- Done --

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix is ready!                ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Backend:  http://localhost:8090"
echo "  ArangoDB: http://localhost:8529"
echo ""

# Verify CLI works
if [ "$PLATFORM" = "windows-amd64" ]; then
  if [ -x "$IX_BIN/ix" ]; then
    info "ix CLI v${VERSION} installed at $IX_BIN/ix"
    echo "  Run 'ix --version' in a new terminal to verify"
  fi
elif command -v ix >/dev/null 2>&1; then
  CLI_VERSION=$(ix --version 2>/dev/null || echo "unknown")
  info "ix CLI v${CLI_VERSION} is working"
elif [ -x "$IX_BIN/ix" ]; then
  CLI_VERSION=$("$IX_BIN/ix" --version 2>/dev/null || echo "unknown")
  info "ix CLI v${CLI_VERSION} installed at $IX_BIN/ix"
  if [ "$IX_BIN" != "/usr/local/bin" ]; then
    echo "  Open a new terminal for 'ix' to be in your PATH"
  fi
else
  warn "ix not found"
fi

echo ""
echo "  Connect a project:"
echo "    cd ~/my-project && ix map ."
echo ""
echo "  To uninstall:"
echo "    curl -fsSL https://ix-infra.com/uninstall.sh | sh"
echo ""
