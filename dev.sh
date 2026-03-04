#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-up}" in
  up)
    if ! command -v docker &> /dev/null; then
      echo "Error: Docker is not installed."
      exit 1
    fi
    if ! docker info &> /dev/null 2>&1; then
      echo "Error: Docker is not running."
      exit 1
    fi

    echo "Starting ArangoDB..."
    docker compose up -d arangodb

    echo "Waiting for ArangoDB..."
    for i in $(seq 1 20); do
      if curl -sf http://localhost:8529/_api/version > /dev/null 2>&1; then
        echo "ArangoDB is ready at http://localhost:8529"
        break
      fi
      sleep 1
    done

    echo ""
    echo "Starting Memory Layer via sbt..."
    ARANGO_HOST=localhost \
    ARANGO_PORT=8529 \
    ARANGO_DATABASE=ix_memory \
    ARANGO_USER=root \
    ARANGO_PASSWORD="" \
    PORT=8090 \
    sbt "memoryLayer/run"
    ;;
  stop)
    docker compose stop arangodb
    echo "ArangoDB stopped."
    ;;
  *)
    echo "Usage: ./dev.sh [up|stop]"
    echo ""
    echo "  up    Start ArangoDB in Docker + Memory Layer via sbt (default)"
    echo "  stop  Stop ArangoDB container"
    exit 1
    ;;
esac
