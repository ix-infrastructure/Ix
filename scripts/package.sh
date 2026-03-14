#!/bin/sh
set -eu

VERSION="${1:-dev}"
NODE_VERSION="22.14.0"
JDK_VERSION="21"

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

# Map arch for different download sources
case "$ARCH" in
  amd64) NODE_ARCH="x64"; ADOPTIUM_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64"; ADOPTIUM_ARCH="aarch64" ;;
esac

# Adoptium uses "mac" not "darwin"
case "$OS" in
  darwin) ADOPTIUM_OS="mac" ;;
  *)      ADOPTIUM_OS="$OS" ;;
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
# Install production-only dependencies (much smaller than full node_modules)
cd "${DIST_DIR}/cli"
npm install --omit=dev --ignore-scripts --no-audit --no-fund 2>/dev/null
cd "${ROOT_DIR}"

# Download Node.js
echo "==> Downloading Node.js ${NODE_VERSION} for ${PLATFORM}..."
NODE_ARCHIVE="node-v${NODE_VERSION}-${OS}-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
curl -fSL --progress-bar -o "${DIST_DIR}/${NODE_ARCHIVE}" "$NODE_URL"
mkdir -p "${DIST_DIR}/runtime/node"
tar -xzf "${DIST_DIR}/${NODE_ARCHIVE}" --strip-components=1 -C "${DIST_DIR}/runtime/node"
rm "${DIST_DIR}/${NODE_ARCHIVE}"

# Download Adoptium JRE
echo "==> Downloading Adoptium JRE ${JDK_VERSION} for ${PLATFORM}..."
JRE_URL="https://api.adoptium.net/v3/binary/latest/${JDK_VERSION}/ga/${ADOPTIUM_OS}/${ADOPTIUM_ARCH}/jre/hotspot/normal/eclipse?project=jdk"
curl -fSL --progress-bar -o "${DIST_DIR}/jre.tar.gz" -L "$JRE_URL"
mkdir -p "${DIST_DIR}/runtime/jre"
tar -xzf "${DIST_DIR}/jre.tar.gz" --strip-components=1 -C "${DIST_DIR}/runtime/jre"
rm "${DIST_DIR}/jre.tar.gz"
# On macOS, the JRE extracts with Contents/Home structure
if [ -d "${DIST_DIR}/runtime/jre/Contents/Home" ]; then
  mv "${DIST_DIR}/runtime/jre/Contents/Home"/* "${DIST_DIR}/runtime/jre/"
  rm -rf "${DIST_DIR}/runtime/jre/Contents"
fi

# Create wrapper script
cat > "${DIST_DIR}/ix" <<'WRAPPER'
#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="${SCRIPT_DIR}/runtime/node/bin:${SCRIPT_DIR}/runtime/jre/bin:${PATH}"
exec "${SCRIPT_DIR}/runtime/node/bin/node" "${SCRIPT_DIR}/cli/dist/cli/main.js" "$@"
WRAPPER
chmod +x "${DIST_DIR}/ix"

# Create archive
echo "==> Creating archive..."
cd "${ROOT_DIR}/dist"
tar czf "${DIST_NAME}.tar.gz" "${DIST_NAME}"
shasum -a 256 "${DIST_NAME}.tar.gz" > "${DIST_NAME}.tar.gz.sha256"

echo "==> Done: dist/${DIST_NAME}.tar.gz"
echo "    SHA256: $(cat "${DIST_NAME}.tar.gz.sha256")"
