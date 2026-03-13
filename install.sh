#!/bin/sh
set -eu

# IX Memory installer — cross-platform for macOS / Linux / WSL
# Usage: curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.sh | sh

GITHUB_ORG="ix-infrastructure"
GITHUB_REPO="IX-Memory"
DEFAULT_INSTALL_DIR="$HOME/.local/share/ix"
BIN_DIR="$HOME/.local/bin"

# ── Colour helpers (disabled when not a terminal) ──────────────────────────

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD="$(tput bold)"
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  RED="$(tput setaf 1)"
  CYAN="$(tput setaf 6)"
  RESET="$(tput sgr0)"
else
  BOLD="" GREEN="" YELLOW="" RED="" CYAN="" RESET=""
fi

info()  { printf '%s[info]%s  %s\n'  "$CYAN"   "$RESET" "$1"; }
ok()    { printf '%s[ ok ]%s  %s\n'  "$GREEN"  "$RESET" "$1"; }
warn()  { printf '%s[warn]%s  %s\n'  "$YELLOW" "$RESET" "$1"; }
err()   { printf '%s[err ]%s  %s\n'  "$RED"    "$RESET" "$1" >&2; }
die()   { err "$1"; exit 1; }

# ── Usage ──────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
${BOLD}ix install${RESET} — install IX Memory CLI

USAGE
  install.sh [OPTIONS]

OPTIONS
  --version VERSION   Install a specific version (default: latest)
  --no-modify-path    Skip automatic PATH modification
  --help              Show this help message

ENVIRONMENT
  IX_INSTALL_DIR      Override install directory
                      (default: \$HOME/.local/share/ix)

EXAMPLES
  curl -fsSL https://raw.githubusercontent.com/$GITHUB_ORG/$GITHUB_REPO/main/install.sh | sh
  ./install.sh --version 0.4.1
  IX_INSTALL_DIR=/opt/ix ./install.sh --no-modify-path
EOF
  exit 0
}

# ── Argument parsing ───────────────────────────────────────────────────────

REQUESTED_VERSION=""
MODIFY_PATH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version requires a value"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      die "Unknown option: $1 (try --help)"
      ;;
  esac
done

# ── Platform detection ─────────────────────────────────────────────────────

detect_platform() {
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"

  case "$OS_RAW" in
    Darwin)  OS="darwin" ;;
    Linux)   OS="linux"  ;;
    *)       die "Unsupported operating system: $OS_RAW (only macOS and Linux/WSL are supported)" ;;
  esac

  case "$ARCH_RAW" in
    x86_64|amd64)    ARCH="amd64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *)               die "Unsupported architecture: $ARCH_RAW (only amd64 and arm64 are supported)" ;;
  esac

  info "Detected platform: ${OS}/${ARCH}"
}

# ── Dependency checks ─────────────────────────────────────────────────────

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

check_deps() {
  require_cmd curl
  require_cmd tar
  # checksum tool checked later per-platform
}

# ── Fetch latest version from GitHub API ───────────────────────────────────

fetch_latest_version() {
  info "Fetching latest release from GitHub..."
  LATEST_URL="https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest"

  HTTP_RESPONSE="$(curl -fsSL "$LATEST_URL" 2>/dev/null)" \
    || die "Failed to fetch latest release from GitHub. Check your internet connection."

  # Extract tag_name without jq (POSIX-friendly)
  TAG="$(printf '%s' "$HTTP_RESPONSE" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$TAG" ] || die "Could not determine latest version from GitHub API response."

  # Strip leading "v" if present
  VERSION="$(printf '%s' "$TAG" | sed 's/^v//')"
  info "Latest version: ${VERSION}"
}

# ── Download & verify ──────────────────────────────────────────────────────

download_and_verify() {
  ARCHIVE_NAME="ix-${VERSION}-${OS}-${ARCH}.tar.gz"
  CHECKSUM_NAME="${ARCHIVE_NAME}.sha256"
  DOWNLOAD_BASE="https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/releases/download/v${VERSION}"

  TMPDIR_DL="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_DL"' EXIT

  ARCHIVE_PATH="${TMPDIR_DL}/${ARCHIVE_NAME}"
  CHECKSUM_PATH="${TMPDIR_DL}/${CHECKSUM_NAME}"

  info "Downloading ${ARCHIVE_NAME}..."
  curl -fSL --progress-bar -o "$ARCHIVE_PATH" "${DOWNLOAD_BASE}/${ARCHIVE_NAME}" \
    || die "Failed to download ${ARCHIVE_NAME}. Does version ${VERSION} have a release for ${OS}/${ARCH}?"

  info "Downloading checksum file..."
  curl -fsSL -o "$CHECKSUM_PATH" "${DOWNLOAD_BASE}/${CHECKSUM_NAME}" \
    || die "Failed to download checksum file ${CHECKSUM_NAME}."

  info "Verifying SHA-256 checksum..."
  verify_checksum "$ARCHIVE_PATH" "$CHECKSUM_PATH"
  ok "Checksum verified"
}

verify_checksum() {
  _file="$1"
  _checksum_file="$2"

  _expected="$(awk '{print $1}' "$_checksum_file")"
  [ -n "$_expected" ] || die "Checksum file is empty or malformed."

  case "$OS" in
    darwin)
      require_cmd shasum
      _actual="$(shasum -a 256 "$_file" | awk '{print $1}')"
      ;;
    linux)
      require_cmd sha256sum
      _actual="$(sha256sum "$_file" | awk '{print $1}')"
      ;;
  esac

  [ "$_actual" = "$_expected" ] \
    || die "Checksum mismatch!\n  Expected: ${_expected}\n  Got:      ${_actual}\nThe download may be corrupt. Please try again."
}

# ── Install ────────────────────────────────────────────────────────────────

install_binary() {
  INSTALL_DIR="${IX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  PLATFORM_DIR="ix-${VERSION}-${OS}-${ARCH}"

  info "Installing to ${INSTALL_DIR}/${PLATFORM_DIR}..."
  mkdir -p "$INSTALL_DIR"
  mkdir -p "$BIN_DIR"

  # Extract archive into install dir
  tar -xzf "$ARCHIVE_PATH" -C "$INSTALL_DIR"

  # Verify the expected binary exists
  IX_BINARY="${INSTALL_DIR}/${PLATFORM_DIR}/ix"
  [ -f "$IX_BINARY" ] || die "Expected binary not found at ${IX_BINARY} after extraction."
  chmod +x "$IX_BINARY"

  # Create/update symlink
  SYMLINK_PATH="${BIN_DIR}/ix"
  if [ -L "$SYMLINK_PATH" ] || [ -e "$SYMLINK_PATH" ]; then
    rm -f "$SYMLINK_PATH"
  fi
  ln -s "$IX_BINARY" "$SYMLINK_PATH"
  ok "Symlinked ${SYMLINK_PATH} -> ${IX_BINARY}"
}

# ── PATH modification ─────────────────────────────────────────────────────

modify_path() {
  if [ "$MODIFY_PATH" -eq 0 ]; then
    info "Skipping PATH modification (--no-modify-path)"
    return
  fi

  PATH_LINE="export PATH=\"\$HOME/.local/bin:\$PATH\""

  _modified=0

  for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC_FILE" ]; then
      if ! grep -qF '.local/bin' "$RC_FILE" 2>/dev/null; then
        printf '\n# Added by IX Memory installer\n%s\n' "$PATH_LINE" >> "$RC_FILE"
        ok "Added PATH entry to $(basename "$RC_FILE")"
        _modified=1
      fi
    else
      # Create the file if the shell is installed
      case "$RC_FILE" in
        *bashrc)
          if command -v bash >/dev/null 2>&1; then
            printf '# Added by IX Memory installer\n%s\n' "$PATH_LINE" > "$RC_FILE"
            ok "Created $(basename "$RC_FILE") with PATH entry"
            _modified=1
          fi
          ;;
        *zshrc)
          if command -v zsh >/dev/null 2>&1; then
            printf '# Added by IX Memory installer\n%s\n' "$PATH_LINE" > "$RC_FILE"
            ok "Created $(basename "$RC_FILE") with PATH entry"
            _modified=1
          fi
          ;;
      esac
    fi
  done

  if [ "$_modified" -eq 0 ]; then
    info "PATH already contains \$HOME/.local/bin — no changes needed"
  fi
}

# ── Manifest ───────────────────────────────────────────────────────────────

write_manifest() {
  INSTALL_DIR="${IX_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  MANIFEST="${INSTALL_DIR}/manifest.json"
  INSTALL_DATE="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  cat > "$MANIFEST" <<MANIFEST_EOF
{
  "version": "${VERSION}",
  "platform": "${OS}/${ARCH}",
  "install_dir": "${INSTALL_DIR}",
  "bin_symlink": "${BIN_DIR}/ix",
  "installed_at": "${INSTALL_DATE}"
}
MANIFEST_EOF

  ok "Wrote manifest to ${MANIFEST}"
}

# ── Verify ─────────────────────────────────────────────────────────────────

verify_installation() {
  # Ensure the bin dir is on PATH for this check
  export PATH="${BIN_DIR}:${PATH}"

  if command -v ix >/dev/null 2>&1; then
    INSTALLED_VERSION="$(ix --version 2>/dev/null || echo "unknown")"
    ok "Verified: ix ${INSTALLED_VERSION}"
  else
    warn "ix binary is installed but not yet on your PATH."
    warn "Restart your shell or run:  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
}

# ── Success message ────────────────────────────────────────────────────────

print_success() {
  printf '\n%s%s══════════════════════════════════════════%s\n' "$BOLD" "$GREEN" "$RESET"
  printf '%s%s  IX Memory CLI installed successfully!   %s\n' "$BOLD" "$GREEN" "$RESET"
  printf '%s%s══════════════════════════════════════════%s\n\n' "$BOLD" "$GREEN" "$RESET"

  printf '%sNext steps:%s\n' "$BOLD" "$RESET"
  printf '  1. Restart your terminal (or run: %sexport PATH="$HOME/.local/bin:$PATH"%s)\n' "$CYAN" "$RESET"
  printf '  2. Start the backend:  %six status%s\n' "$CYAN" "$RESET"
  printf '  3. Ingest your project:  %six ingest ./src --recursive%s\n' "$CYAN" "$RESET"
  printf '  4. Try it out:  %six search MyClass --kind class%s\n\n' "$CYAN" "$RESET"
  printf '  Documentation: %shttps://github.com/%s/%s#readme%s\n\n' "$CYAN" "$GITHUB_ORG" "$GITHUB_REPO" "$RESET"
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
  printf '\n%s%sIX Memory Installer%s\n\n' "$BOLD" "$CYAN" "$RESET"

  detect_platform
  check_deps

  if [ -n "$REQUESTED_VERSION" ]; then
    VERSION="$REQUESTED_VERSION"
    info "Using requested version: ${VERSION}"
  else
    fetch_latest_version
  fi

  download_and_verify
  install_binary
  modify_path
  write_manifest
  verify_installation
  print_success
}

main
