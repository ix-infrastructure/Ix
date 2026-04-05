#!/bin/sh
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

set -eu

# -- Config --

GITHUB_ORG="ix-infrastructure"
GITHUB_REPO="Ix"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_ORG}/${GITHUB_REPO}/main"

IX_HOME="${IX_HOME:-$HOME/.ix}"
COMPOSE_DIR="$IX_HOME/backend"

HEALTH_URL="http://localhost:8090/v1/health"
ARANGO_URL="http://localhost:8529/_api/version"

NODE_MIN_MAJOR=18

# -- Windows / POSIX docker compose wrapper --

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    IX_HOST_MOUNT_ROOT="$(cygpath -m "$HOME")"
    export IX_HOST_MOUNT_ROOT
    export IX_CONTAINER_MOUNT_ROOT="${HOME}"
    dc() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker compose "$@"; }
    ;;
  *)
    export IX_HOST_MOUNT_ROOT="${HOME}"
    export IX_CONTAINER_MOUNT_ROOT="${HOME}"
    dc() { docker compose "$@"; }
    ;;
esac
# -- Helpers --

info()  { printf "  \033[32m[ok]\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m[!!]\033[0m %s\n" "$*" >&2; }
err()   { printf "  \033[31m[error]\033[0m %s\n" "$*" >&2; exit 1; }
step()  { printf "\n-- %s --\n" "$*"; }

# -- Download helpers (curl or wget) --
#
# _fetch URL         — write response to stdout
# _download URL FILE — write response to FILE

if command -v curl >/dev/null 2>&1; then
  _fetch()    { curl -fsSL "$1"; }
  _download() { curl -fL --progress-bar "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  _fetch()    { wget -qO- "$1"; }
  _download() { wget --show-progress -qO "$2" "$1" 2>&1 || wget -O "$2" "$1"; }
else
  err "curl or wget is required but neither was found.
  Install one first and re-run:
    apt-get install -y curl    # Debian/Ubuntu
    apk add curl               # Alpine
    dnf install -y curl        # Fedora/RHEL"
fi

# Pick a bin dir that is already in PATH and writable
pick_bin_dir() {
  if [ -w "/usr/local/bin" ] || [ -w "/usr/local" ]; then
    echo "/usr/local/bin"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  echo "$HOME/.local/bin"
}

IX_BIN="$(pick_bin_dir)"

ensure_path() {
  # Only needed when using ~/.local/bin
  if [ "$IX_BIN" = "/usr/local/bin" ]; then return; fi

  # Single quotes intentional: $HOME/$PATH must expand at shell startup, not install time
  # shellcheck disable=SC2016
  path_line='export PATH="$HOME/.local/bin:$PATH"'
  added=0

  # Update any rc files that already exist
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if ! grep -Fq '.local/bin' "$rc" 2>/dev/null; then
      printf '\n# Added by Ix installer\n%s\n' "$path_line" >> "$rc"
    fi
    added=1
  done

  # No rc files found — fall back to ~/.profile (POSIX login shell)
  if [ "$added" = "0" ]; then
    touch "$HOME/.profile"
    if ! grep -Fq '.local/bin' "$HOME/.profile" 2>/dev/null; then
      printf '\n# Added by Ix installer\n%s\n' "$path_line" >> "$HOME/.profile"
    fi
    echo "  Note: ~/.local/bin added to PATH in ~/.profile"
  fi

  echo "  Run this to use ix now (or open a new terminal):"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
}

# -- Resolve version --

resolve_version() {
  if [ -n "${IX_VERSION:-}" ]; then
    echo "$IX_VERSION"
    return
  fi

  latest=$(_fetch "https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' || true)
  if [ -n "$latest" ]; then
    echo "$latest"
    return
  fi

  echo "0.1.0"
}

# -- Detect platform --

detect_platform() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin)
      os="darwin"
      # uname lies under Rosetta — detect real hardware
      real_arm="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"
      if [ "$real_arm" = "1" ]; then
        arch="arm64"
      fi
      ;;
    linux)  os="linux" ;;
    mingw*|msys*|cygwin*) os="windows" ;;
    *)      err "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             err "Unsupported architecture: $arch. Supported: x86_64, arm64" ;;
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

# -- Step 0: System prerequisites --

step "0. System prerequisites (git, Homebrew)"

# Homebrew — macOS package manager (used to install Node, Docker, git)
case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "  Installing Homebrew (macOS package manager)..."
      /bin/bash -c "$(_fetch https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/null
      # Add brew to PATH for this session (Apple Silicon vs Intel)
      if [ -x "/opt/homebrew/bin/brew" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -x "/usr/local/bin/brew" ]; then
        eval "$(/usr/local/bin/brew shellenv)"
      fi
      if command -v brew >/dev/null 2>&1; then
        info "Homebrew installed"
      else
        warn "Homebrew installed but not in PATH yet — open a new terminal after install"
      fi
    else
      info "Homebrew is available"
    fi
    ;;
esac

# git — required by ix CLI
if ! command -v git >/dev/null 2>&1; then
  echo "  Installing git..."
  case "$(uname -s)" in
    Darwin)
      if command -v xcode-select >/dev/null 2>&1; then
        echo "  Installing Xcode Command Line Tools (includes git)..."
        echo "  A dialog may appear — click Install and wait."
        xcode-select --install 2>/dev/null || true
        printf "  Waiting for git..."
        i=0
        while [ "$i" -lt 120 ]; do
          if command -v git >/dev/null 2>&1; then break; fi
          printf "."
          sleep 2
          i=$((i + 1))
        done
        echo ""
      fi
      if ! command -v git >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
        brew install git < /dev/null
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq < /dev/null && sudo apt-get install -y git < /dev/null
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y git < /dev/null
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y git < /dev/null
      elif command -v apk >/dev/null 2>&1; then
        sudo apk add git < /dev/null
      fi
      ;;
  esac
  if ! command -v git >/dev/null 2>&1; then
    err "git is required. Install it manually: https://git-scm.com/downloads"
  fi
  info "git installed"
else
  info "git is available"
fi

# ripgrep — used by "ix text" for fast codebase search
if ! command -v rg >/dev/null 2>&1; then
  echo "  Installing ripgrep..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install ripgrep < /dev/null 2>/dev/null
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y ripgrep < /dev/null 2>/dev/null
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y ripgrep < /dev/null 2>/dev/null
      elif command -v apk >/dev/null 2>&1; then
        sudo apk add ripgrep < /dev/null 2>/dev/null
      fi
      ;;
  esac
  if command -v rg >/dev/null 2>&1; then
    info "ripgrep installed"
  else
    warn "ripgrep not installed — 'ix text' will not be available"
  fi
else
  info "ripgrep is available"
fi

# -- Step 1: Check / Install Node.js --

step "1. Node.js (runtime)"

node_version_major() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_or_upgrade_node() {
  action="$1"  # "Installing" or "Upgrading"
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
        node_pkg=$(mktemp /tmp/node-XXXXXX.pkg)
        node_arch="$(uname -m)"
        node_ver=$(_fetch "https://nodejs.org/dist/index.json" \
          | sed -n 's/.*"version":"v\([^"]*\)".*"lts":[^f].*/\1/p' \
          | head -1 || true)
        if [ -z "$node_ver" ]; then node_ver="22.14.0"; fi
        if [ "$node_arch" = "arm64" ]; then
          _download "https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-darwin-arm64.pkg" "$node_pkg"
        else
          _download "https://nodejs.org/dist/v${node_ver}/node-v${node_ver}-darwin-x64.pkg" "$node_pkg"
        fi
        sudo installer -pkg "$node_pkg" -target / < /dev/null
        rm -f "$node_pkg"
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (apt)..."
        _fetch https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs < /dev/null
      elif command -v dnf >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (dnf)..."
        _fetch https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs < /dev/null
      elif command -v yum >/dev/null 2>&1; then
        echo "  ${action} Node.js via NodeSource (yum)..."
        _fetch https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo yum install -y nodejs < /dev/null
      elif command -v apk >/dev/null 2>&1; then
        echo "  ${action} Node.js via apk..."
        sudo apk add --update nodejs npm < /dev/null
      else
        err "No supported package manager found (apt, dnf, yum, apk).
  Install Node.js ${NODE_MIN_MAJOR}+ manually, then re-run:
    https://nodejs.org/en/download/"
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
        _bindir="$(dirname "$p")"
        export PATH="$_bindir:$PATH"
        break
      fi
    done
  fi
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js installation failed. Install Node.js ${NODE_MIN_MAJOR}+ manually: https://nodejs.org/"
  fi
  info "Node.js $(node -v) installed"
fi

# -- Step 2: Check / Install Docker + Docker Compose --

step "2. Docker + Docker Compose"

install_docker() {
  case "$(uname -s)" in
    Darwin)
      # Detect real hardware — uname lies under Rosetta (reports x86_64 on ARM)
      real_arch="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"
      if [ "$real_arch" = "1" ]; then
        arch_suffix="arm64"
      else
        arch_suffix="amd64"
      fi

      echo "  Installing Docker Desktop for macOS ($arch_suffix)..."
      echo "  (this downloads ~700MB — may take a few minutes)"
      echo ""

      # Remove any existing Docker binaries from previous installs
      for f in /usr/local/bin/docker /usr/local/bin/docker-compose \
               /usr/local/bin/docker-credential-desktop \
               /usr/local/bin/docker-credential-ecr-login \
               /usr/local/bin/docker-credential-osxkeychain \
               /usr/local/bin/com.docker.cli \
               /usr/local/bin/kubectl.docker /usr/local/bin/hub-tool \
               /usr/local/bin/docker-index /usr/local/bin/hyperkit; do
        if [ -e "$f" ] || [ -L "$f" ]; then
          rm -f "$f" 2>/dev/null || sudo rm -f "$f" 2>/dev/null || true
        fi
      done
      brew uninstall --cask docker 2>/dev/null || true

      dmg=$(mktemp /tmp/docker-XXXXXX.dmg)
      echo "  Downloading Docker Desktop..."
      _download "https://desktop.docker.com/mac/main/${arch_suffix}/Docker.dmg" "$dmg"
      echo "  Mounting installer..."
      hdiutil attach "$dmg" -quiet -nobrowse -mountpoint /Volumes/Docker < /dev/null
      echo "  Copying to /Applications (may require your password)..."
      sudo rm -rf /Applications/Docker.app 2>/dev/null || true
      sudo cp -R /Volumes/Docker/Docker.app /Applications/ < /dev/null &
      CP_PID=$!
      while kill -0 "$CP_PID" 2>/dev/null; do
        printf "."
        sleep 1
      done
      wait "$CP_PID" || true
      echo " done"
      hdiutil detach /Volumes/Docker -quiet
      rm -f "$dmg"
      info "Docker Desktop installed"
      ;;
    Linux)
      echo "  Installing Docker Engine via get.docker.com..."
      _fetch https://get.docker.com | sh < /dev/null
      if ! id -nG "$USER" 2>/dev/null | grep -qw docker; then
        echo "  Adding $USER to the docker group..."
        sudo usermod -aG docker "$USER" < /dev/null 2>/dev/null || true
      fi
      if command -v systemctl >/dev/null 2>&1; then
        sudo systemctl start docker < /dev/null 2>/dev/null || true
        sudo systemctl enable docker < /dev/null 2>/dev/null || true
      fi
      if ! docker compose version >/dev/null 2>&1; then
        echo "  Installing Docker Compose plugin..."
        compose_arch="x86_64"
        if [ "$(uname -m)" = "aarch64" ]; then compose_arch="aarch64"; fi
        compose_url="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${compose_arch}"
        sudo mkdir -p /usr/local/lib/docker/cli-plugins
        sudo _download "$compose_url" /usr/local/lib/docker/cli-plugins/docker-compose
        sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo ""
      echo "  Docker Desktop is required on Windows."
      echo "  Download and install from:"
      echo "    https://docs.docker.com/desktop/install/windows-install/"
      echo ""
      echo "  After installing, restart your terminal and re-run this installer."
      echo ""
      echo "  To install the CLI only (no backend):"
      echo "    IX_SKIP_BACKEND=1 sh install.sh"
      err "Automatic Docker install is not supported on Windows."
      ;;
    *)
      err "Unsupported OS. Install Docker manually: https://docs.docker.com/engine/install/"
      ;;
  esac
}

wait_for_docker_daemon() {
  max_wait="$1"
  printf "  Waiting for Docker daemon..."
  i=0
  while [ "$i" -lt "$max_wait" ]; do
    if docker info < /dev/null >/dev/null 2>&1; then
      echo ""
      return 0
    fi
    printf "."
    sleep 2
    i=$((i + 1))
  done
  echo ""
  return 1
}

start_docker_daemon() {
  case "$(uname -s)" in
    Darwin)
      if [ -d "/Applications/Docker.app" ]; then
        echo "  Starting Docker Desktop..."
        open -g -a Docker
        osascript -e 'tell application "Docker" to activate' 2>/dev/null || true
        if ! wait_for_docker_daemon 15; then
          echo ""
          echo "  ┌─────────────────────────────────────────────────────────────┐"
          echo "  │  Docker Desktop needs you to complete setup in its window.  │"
          echo "  │                                                             │"
          echo "  │  1. Accept the Docker Desktop license agreement             │"
          echo "  │  2. Skip or complete sign-in (sign-in is optional)          │"
          echo "  │  3. Wait for the engine to finish starting                  │"
          echo "  │     (whale icon in menu bar stops animating)                │"
          echo "  │                                                             │"
          echo "  │  This installer will continue automatically once ready.     │"
          echo "  └─────────────────────────────────────────────────────────────┘"
          echo ""
          if ! wait_for_docker_daemon 150; then
            return 1
          fi
        fi
      fi
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        echo "  Starting Docker daemon..."
        sudo systemctl start docker < /dev/null 2>/dev/null || true
        sleep 2
      fi
      if ! docker info < /dev/null >/dev/null 2>&1; then
        if sudo docker info < /dev/null >/dev/null 2>&1; then
          echo "  Docker requires sudo (group not yet active). Using sudo for this session."
          dc() { sudo docker compose "$@"; }
        fi
      fi
      ;;
  esac
}

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_BACKEND=1)"
else
  if ! command -v docker >/dev/null 2>&1; then
    install_docker
    hash -r 2>/dev/null || true
    # On macOS, Docker Desktop creates CLI symlinks only on first launch.
    # Start it now so `docker` becomes available.
    if [ -d "/Applications/Docker.app" ] && ! command -v docker >/dev/null 2>&1; then
      echo "  Launching Docker Desktop to set up CLI tools..."
      open -g -a Docker
      osascript -e 'tell application "Docker" to activate' 2>/dev/null || true
      printf "  Waiting for docker CLI..."
      i=0
      while [ "$i" -lt 30 ]; do
        hash -r 2>/dev/null || true
        if command -v docker >/dev/null 2>&1; then break; fi
        printf "."
        sleep 2
        i=$((i + 1))
      done
      echo ""
    fi
    if ! command -v docker >/dev/null 2>&1; then
      for p in /usr/local/bin /opt/homebrew/bin; do
        if [ -x "$p/docker" ]; then
          export PATH="$p:$PATH"
          break
        fi
      done
    fi
    if ! command -v docker >/dev/null 2>&1; then
      err "Docker installation failed. Install manually: https://docs.docker.com/engine/install/"
    fi
    info "Docker installed"
  else
    info "Docker is installed"
  fi

  if ! docker info < /dev/null >/dev/null 2>&1; then
    start_docker_daemon
    if ! docker info < /dev/null >/dev/null 2>&1 && ! sudo docker info < /dev/null >/dev/null 2>&1; then
      echo ""
      echo "  Could not start Docker automatically."
      echo "  To install the CLI only (no backend):"
      echo "    IX_SKIP_BACKEND=1 sh install.sh"
      err "Docker daemon is not running. Start it and re-run."
    fi
  fi
  info "Docker daemon is running"

  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 is required. Update Docker or install the compose plugin."
  fi
  info "Docker Compose $(docker compose version --short 2>/dev/null || echo 'v2') is available"
fi

# -- Step 3: Start Backend --

step "3. Backend (ArangoDB + Memory Layer)"

if [ "${IX_SKIP_BACKEND:-}" = "1" ]; then
  echo "  (skipped via IX_SKIP_BACKEND=1)"
else
  if _fetch "$HEALTH_URL" >/dev/null 2>&1 && _fetch "$ARANGO_URL" >/dev/null 2>&1; then
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

    _download "${GITHUB_RAW}/docker-compose.standalone.yml" "$COMPOSE_DIR/docker-compose.yml"
    info "Downloaded docker-compose.yml"

    # Pull images first so we catch rate limits / auth errors clearly
    echo "  Pulling Docker images (this may take a few minutes on first run)..."
    PULL_LOG=$(mktemp /tmp/ix-pull-XXXXXX.log)
    dc -f "$COMPOSE_DIR/docker-compose.yml" pull < /dev/null >"$PULL_LOG" 2>&1 &
    PULL_PID=$!
    while kill -0 "$PULL_PID" 2>/dev/null; do
      printf "."
      sleep 2
    done
    echo ""
    if ! wait "$PULL_PID"; then
      echo ""
      if grep -qi "toomanyrequests\|rate limit\|429\|unauthorized\|denied" "$PULL_LOG" 2>/dev/null; then
        echo "  ┌─────────────────────────────────────────────────────────────┐"
        echo "  │  Docker image pull was rate-limited or denied.              │"
        echo "  │                                                             │"
        echo "  │  Docker Hub limits unauthenticated pulls to 100 per 6hrs.  │"
        echo "  │  Sign in to Docker Hub (free account) to raise the limit:  │"
        echo "  │                                                             │"
        echo "  │    docker login                                             │"
        echo "  │                                                             │"
        echo "  │  Then re-run this installer.                                │"
        echo "  └─────────────────────────────────────────────────────────────┘"
      else
        echo "  Image pull failed. Error output:"
        head -20 "$PULL_LOG"
        echo ""
        echo "  If Docker just started, it may need a moment — try again."
      fi
      rm -f "$PULL_LOG"
      err "Failed to pull Docker images."
    fi
    rm -f "$PULL_LOG"
    info "Docker images pulled"

    # Start services
    printf "  Starting backend services..."
    START_LOG=$(mktemp /tmp/ix-start-XXXXXX.log)
    if ! dc -f "$COMPOSE_DIR/docker-compose.yml" up -d < /dev/null >"$START_LOG" 2>&1; then
      echo ""
      echo "  Failed to start backend. Error output:"
      head -20 "$START_LOG"
      rm -f "$START_LOG"
      err "docker compose up failed."
    fi
    rm -f "$START_LOG"
    echo " started"

    printf "  Waiting for services to become healthy..."
    i=0
    while [ "$i" -lt 45 ]; do
      if _fetch "$HEALTH_URL" >/dev/null 2>&1 && _fetch "$ARANGO_URL" >/dev/null 2>&1; then
        break
      fi
      printf "."
      sleep 2
      i=$((i + 1))
    done
    echo ""

    if _fetch "$HEALTH_URL" >/dev/null 2>&1; then
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
# On Windows, avoid invoking the shim (calls cmd.exe, hangs in sh subshell)
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
  echo "  URL: $TARBALL_URL"
  if ! _download "$TARBALL_URL" "$TMP_FILE" 2>/dev/null; then
    rm -rf "$TMP_DIR"
    echo ""
    warn "Could not download pre-built CLI from:"
    warn "  $TARBALL_URL"
    echo ""
    echo "  This likely means the release asset has not been uploaded yet."
    echo "  Check available releases at:"
    echo "    https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases"
    echo ""
    echo "  Or build from source:"
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

  # Create wrapper shim in bin dir
  if [ "$PLATFORM" = "windows-amd64" ]; then
    IX_JS="$INSTALL_DIR/ix-${VERSION}-windows-amd64/cli/dist/cli/main.js"
    cat > "$IX_BIN/ix" <<SHIM
#!/bin/sh
exec node "$IX_JS" "\$@"
SHIM
  else
    cat > "$IX_BIN/ix" <<SHIM
#!/bin/sh
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
  warn "ix not found in PATH — something may have gone wrong"
fi

echo ""
echo "  Connect a project:"
echo "    cd ~/my-project && ix map ."
echo ""
echo "  To uninstall:"
echo "    curl -fsSL https://ix-infra.com/uninstall.sh | sh"
echo ""
