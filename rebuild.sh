#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Shutting down..."
./shutdown.sh

echo "==> Building backend (sbt assembly)..."
sbt assembly

echo "==> Building CLI (npm run build)..."
cd ix-cli
npm run build
cd ..

echo "==> Running setup..."
./setup.sh

echo "==> Done."
