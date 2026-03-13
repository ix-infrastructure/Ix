#!/bin/sh
set -eu

VERSION="${1:-dev}"

# Detect OS
case "$(uname -s)" in
  Linux*)  OS="linux"  ;;
  Darwin*) OS="darwin" ;;
  *)       OS="unknown" ;;
esac

# Detect architecture
case "$(uname -m)" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)       ARCH="$(uname -m)" ;;
esac

PLATFORM="${OS}-${ARCH}"
DIST_NAME="ix-${VERSION}-${PLATFORM}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist/${DIST_NAME}"

echo "==> Building ix ${VERSION} for ${PLATFORM}"

# Build fat JAR
echo "==> Building server JAR..."
cd "$ROOT_DIR"
sbt "memoryLayer/assembly"

# Build CLI
echo "==> Building CLI..."
cd "${ROOT_DIR}/ix-cli"
npm run build
cd "$ROOT_DIR"

# Create dist directory structure
echo "==> Assembling distribution..."
rm -rf "$DIST_DIR"
mkdir -p "${DIST_DIR}/server"
mkdir -p "${DIST_DIR}/cli"

# Copy artifacts
cp "${ROOT_DIR}/memory-layer/target/scala-2.13/ix-memory-layer.jar" "${DIST_DIR}/server/"
cp -r "${ROOT_DIR}/ix-cli/dist" "${DIST_DIR}/cli/"
cp "${ROOT_DIR}/ix-cli/package.json" "${DIST_DIR}/cli/"

# Create wrapper script
cat > "${DIST_DIR}/ix" <<'WRAPPER'
#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/cli/dist/cli/main.js" "$@"
WRAPPER
chmod +x "${DIST_DIR}/ix"

# Create archive
echo "==> Creating archive..."
cd "${ROOT_DIR}/dist"
tar czf "${DIST_NAME}.tar.gz" "${DIST_NAME}"
shasum -a 256 "${DIST_NAME}.tar.gz" > "${DIST_NAME}.tar.gz.sha256"

echo "==> Done: dist/${DIST_NAME}.tar.gz"
echo "    SHA256: $(cat "${DIST_NAME}.tar.gz.sha256")"
