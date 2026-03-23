#!/bin/sh
# Ix — Standalone Installer
#
# Installs everything needed to run Ix without cloning the repo:
#   1. Docker (checks / prompts)
#   2. Backend (ArangoDB + Memory Layer via Docker)
#   3. ix CLI
#   4. Claude Code hooks (if Claude Code is installed)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/install.sh | sh
#
# Options (env vars):
#   IX_VERSION=0.2.0          Override version (default: latest)
#   IX_SKIP_BACKEND=1         Skip Docker backend setup
#   IX_SKIP_HOOKS=1           Skip Claude Code hook installation

set -eu

# -- Config --

GITHUB_ORG="ix-infrastructure"
GITHUB_REPO="Ix"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main"

IX_HOME="${IX_HOME:-$HOME/.ix}"
COMPOSE_DIR="$IX_HOME/backend"

HEALTH_URL="http://localhost:8090/v1/health"
ARANGO_URL="http://localhost:8529/_api/version"

# Pick a bin dir that's already in PATH and writable
pick_bin_dir() {
  if [ -w "/usr/local/bin" ] || [ -w "/usr/local" ]; then
    echo "/usr/local/bin"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  echo "$HOME/.local/bin"
}

IX_BIN="$(pick_bin_dir)"

# -- Helpers --

info()  { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*" >&2; }
err()   { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# Simple progress spinner
spin() {
  _msg="$1"; shift
  printf "  %s " "$_msg"
  "$@" >/dev/null 2>&1 &
  _pid=$!
  while kill -0 "$_pid" 2>/dev/null; do
    printf "."
    sleep 1
  done
  wait "$_pid"
  _rc=$?
  echo ""
  return $_rc
}

ensure_path() {
  if [ "$IX_BIN" = "/usr/local/bin" ]; then return; fi

  _path_line='export PATH="$HOME/.local/bin:$PATH"'
  _added=false

  for _rc_file in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$_rc_file" ]; then
      if ! grep -Fq '.local/bin' "$_rc_file" 2>/dev/null; then
        printf '\n# Added by Ix installer\n%s\n' "$_path_line" >> "$_rc_file"
        _added=true
      fi
    fi
  done

  if [ "$_added" = false ] && [ ! -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ]; then
    printf '# Added by Ix installer\n%s\n' "$_path_line" >> "$HOME/.profile"
  fi
}

# -- Resolve version --

resolve_version() {
  if [ -n "${IX_VERSION:-}" ]; then
    echo "$IX_VERSION"
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    _latest=$(curl -fsSL "https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"v\(.*\)".*/\1/' || true)
    if [ -n "$_latest" ]; then
      echo "$_latest"
      return
    fi
  fi

  echo "0.1.0"
}

# -- Detect platform --

detect_platform() {
  _os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  _arch="$(uname -m)"

  case "$_os" in
    darwin) _os="darwin" ;;
    linux)  _os="linux" ;;
    *)      err "Unsupported OS: $_os" ;;
  esac

  case "$_arch" in
    x86_64|amd64) _arch="amd64" ;;
    arm64|aarch64) _arch="arm64" ;;
    *)             err "Unsupported architecture: $_arch" ;;
  esac

  echo "${_os}-${_arch}"
}

# ==============================================================================
#  MAIN
# ==============================================================================

echo ""
echo "  Ix — Install"
echo ""

VERSION=$(resolve_version)
PLATFORM=$(detect_platform)
echo "  Version:  $VERSION"
echo "  Platform: $PLATFORM"
echo ""

# -- Step 1: Check Docker --

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  : # skip
else
  if ! command -v docker >/dev/null 2>&1; then
    echo ""
    echo "  Docker is required to run the Ix backend."
    echo ""
    case "$(uname -s)" in
      Darwin)
        echo "  Install: https://docs.docker.com/desktop/install/mac-install/"
        echo "  Or:      brew install --cask docker"
        ;;
      Linux)
        echo "  Install: https://docs.docker.com/engine/install/"
        echo "  Or:      curl -fsSL https://get.docker.com | sh"
        ;;
    esac
    echo ""
    err "Install Docker and re-run this installer."
  fi

  if ! docker info >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin)
        if [ -d "/Applications/Docker.app" ]; then
          open -a Docker
          printf "  Waiting for Docker to start "
          _i=0
          while [ "$_i" -lt 30 ]; do
            if docker info >/dev/null 2>&1; then break; fi
            printf "."
            sleep 2
            _i=$((_i + 1))
          done
          echo ""
        fi
        ;;
    esac

    if ! docker info >/dev/null 2>&1; then
      err "Docker is not running. Start Docker and re-run this installer."
    fi
  fi
  info "Docker"
fi

# -- Step 2: Start Backend --

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  : # skip
else
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1 && curl -sf "$ARANGO_URL" >/dev/null 2>&1; then
    info "Backend (already running)"
  else
    _stale_pid=$(lsof -ti :8090 2>/dev/null || true)
    if [ -n "$_stale_pid" ]; then
      _stale_cmd=$(ps -p "$_stale_pid" -o comm= 2>/dev/null || true)
      if [ "$_stale_cmd" != "com.docker.ba" ] && [ "$_stale_cmd" != "docker" ]; then
        kill "$_stale_pid" 2>/dev/null || true
        sleep 1
      fi
    fi

    mkdir -p "$COMPOSE_DIR"
    curl -fsSL "${GITHUB_RAW}/docker-compose.standalone.yml" -o "$COMPOSE_DIR/docker-compose.yml"

    # Pull and start with suppressed output
    if ! spin "Pulling backend images" docker compose -f "$COMPOSE_DIR/docker-compose.yml" pull; then
      warn "Image pull had issues, attempting to start anyway"
    fi

    docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d >/dev/null 2>&1

    # Wait for health
    printf "  Waiting for backend "
    _i=0
    while [ "$_i" -lt 30 ]; do
      if curl -sf "$HEALTH_URL" >/dev/null 2>&1 && curl -sf "$ARANGO_URL" >/dev/null 2>&1; then
        break
      fi
      printf "."
      sleep 2
      _i=$((_i + 1))
    done
    echo ""

    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      info "Backend"
    else
      warn "Backend may still be starting — run: ix docker logs"
    fi
  fi
fi

# -- Step 3: Install ix CLI --

TARBALL_NAME="ix-${VERSION}-${PLATFORM}.tar.gz"
TARBALL_URL="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${VERSION}/${TARBALL_NAME}"
INSTALL_DIR="$IX_HOME/cli"

# Remove stale ix from other locations
for _old_ix in "$HOME/.local/bin/ix" "/usr/local/bin/ix"; do
  if [ "$_old_ix" != "$IX_BIN/ix" ] && [ -f "$_old_ix" ]; then
    rm -f "$_old_ix" 2>/dev/null || true
  fi
done

_need_install=true
if [ -x "$IX_BIN/ix" ]; then
  _existing=$("$IX_BIN/ix" --version 2>/dev/null || echo "unknown")
  if [ "$_existing" = "$VERSION" ]; then
    info "CLI v${VERSION} (already installed)"
    _need_install=false
  else
    rm -rf "$INSTALL_DIR"
  fi
fi

if [ "$_need_install" = true ]; then
  mkdir -p "$INSTALL_DIR"

  TMP_DIR=$(mktemp -d)
  TMP_FILE="$TMP_DIR/${TARBALL_NAME}"

  if ! spin "Downloading CLI v${VERSION}" curl -fsSL "$TARBALL_URL" -o "$TMP_FILE"; then
    rm -rf "$TMP_DIR"
    echo ""
    warn "Could not download CLI from: $TARBALL_URL"
    echo ""
    echo "  Build from source instead:"
    echo "    git clone https://github.com/${GITHUB_ORG}/${GITHUB_REPO}.git"
    echo "    cd ${GITHUB_REPO} && ./setup.sh"
    echo ""
    err "CLI download failed."
  fi

  tar -xzf "$TMP_FILE" -C "$INSTALL_DIR" --strip-components=1
  rm -rf "$TMP_DIR"

  cat > "$IX_BIN/ix" <<SHIM
#!/bin/sh
exec "$INSTALL_DIR/ix" "\$@"
SHIM
  chmod +x "$IX_BIN/ix"

  ensure_path

  info "CLI v${VERSION}"
fi

# -- Step 4: Claude Code Hooks --

if [ "${IX_SKIP_HOOKS:-}" = "1" ]; then
  : # skip
elif ! command -v claude >/dev/null 2>&1; then
  : # skip — claude not installed
else
  curl -fsSL "${GITHUB_RAW}/ix-plugin/install.sh" | sh 2>/dev/null
  info "Claude Code plugin"
fi

# -- Done --

echo ""

# Verify CLI works
if command -v ix >/dev/null 2>&1; then
  _cli_ver=$(ix --version 2>/dev/null || echo "unknown")
  info "ix v${_cli_ver} is ready"
elif [ -x "$IX_BIN/ix" ]; then
  _cli_ver=$("$IX_BIN/ix" --version 2>/dev/null || echo "unknown")
  info "ix v${_cli_ver} installed at $IX_BIN/ix"
  if [ "$IX_BIN" != "/usr/local/bin" ]; then
    echo "  Open a new terminal for 'ix' to be in your PATH"
  fi
fi

echo ""
echo "  Get started:"
echo "    cd ~/my-project && ix map ./src"
echo ""
