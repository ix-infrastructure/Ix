#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# IX-Memory — Backend Setup
#
# Starts ArangoDB + Memory Layer via Docker Compose.
#
# Usage:
#   ./scripts/backend.sh              # Start backend (default)
#   ./scripts/backend.sh up           # Start backend
#   ./scripts/backend.sh down         # Stop backend
#   ./scripts/backend.sh status       # Show service status
#   ./scripts/backend.sh logs         # Tail service logs
#   ./scripts/backend.sh clean        # Stop + remove data volumes
#   ./scripts/backend.sh rebuild      # Rebuild image and restart services
#   ./scripts/backend.sh check        # Just check if backend is healthy
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$IX_DIR"

# On Windows/MINGW, Docker (a Windows binary) receives paths via MINGW's
# auto-conversion, which turns /c/Users/foo into C:\Users\foo — the drive
# letter colon then breaks Docker's source:target:options mount syntax.
# Prefixing with an extra / (//c/Users/foo) suppresses MINGW conversion so
# the path reaches Docker Desktop as-is, which it maps correctly.
if [[ "$(uname -s)" =~ MINGW|MSYS|CYGWIN ]]; then
  export DOCKER_HOME="/${HOME}"
else
  export DOCKER_HOME="${HOME}"
fi

HEALTH_URL="http://localhost:8090/v1/health"
ARANGO_URL="http://localhost:8529/_api/version"

# ── Helpers ──────────────────────────────────────────────────────────────────

ensure_docker() {
  if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed."
    echo "  Install: https://docs.docker.com/get-docker/"
    exit 1
  fi

  if docker info &> /dev/null 2>&1; then
    echo "[ok] Docker is running"
    return 0
  fi

  # Docker is installed but not running — try to start it
  echo "Docker is not running. Attempting to start..."

  if [ "$(uname)" = "Darwin" ]; then
    # macOS: try Docker Desktop
    if [ -d "/Applications/Docker.app" ]; then
      open -a Docker
      echo "  Launched Docker Desktop, waiting for it to start..."
    elif command -v colima &> /dev/null; then
      colima start
      echo "  Started Colima..."
    else
      echo "Error: Cannot find Docker Desktop or Colima to start."
      echo "  Start Docker manually and try again."
      exit 1
    fi
  elif [ "$(uname)" = "Linux" ]; then
    # Linux: try systemctl
    if command -v systemctl &> /dev/null; then
      echo "  Running: sudo systemctl start docker"
      sudo systemctl start docker
    else
      echo "Error: Cannot auto-start Docker on this system."
      echo "  Start Docker manually and try again."
      exit 1
    fi
  else
    echo "Error: Cannot auto-start Docker on this platform."
    echo "  Start Docker manually and try again."
    exit 1
  fi

  # Wait for Docker to be ready
  for i in $(seq 1 30); do
    if docker info &> /dev/null 2>&1; then
      echo "[ok] Docker is now running"
      return 0
    fi
    printf "."
    sleep 2
  done

  echo ""
  echo "Error: Docker did not start within 60 seconds."
  echo "  Start Docker manually and try again."
  exit 1
}

wait_for_health() {
  echo "Waiting for services to become healthy..."
  for i in $(seq 1 30); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
      echo ""
      echo "[ok] Backend is ready!"
      echo "  Memory Layer: http://localhost:8090"
      echo "  ArangoDB:     http://localhost:8529"
      return 0
    fi
    printf "."
    sleep 2
  done
  echo ""
  echo "[!!] Health check timed out after 60 seconds."
  echo "  Check logs: ./scripts/backend.sh logs"
  return 1
}

is_healthy() {
  curl -sf "$HEALTH_URL" > /dev/null 2>&1 && curl -sf "$ARANGO_URL" > /dev/null 2>&1
}

containers_running() {
  # Check if both containers are running via docker compose
  local running
  running=$(docker compose ps --status running --format json 2>/dev/null | wc -l)
  [ "$running" -ge 2 ]
}

# ── Commands ─────────────────────────────────────────────────────────────────

case "${1:-up}" in
  up)
    # If backend is already healthy, skip everything
    if is_healthy; then
      echo "[ok] Backend is already running and healthy"
      echo "  Memory Layer: http://localhost:8090"
      echo "  ArangoDB:     http://localhost:8529"
      exit 0
    fi

    ensure_docker

    # If containers are running but not healthy, restart them
    if containers_running; then
      echo "Containers are running but not healthy — restarting..."
      docker compose restart
    else
      echo "Starting backend services..."
      docker compose up -d --build
    fi

    wait_for_health
    ;;
  down)
    docker compose down
    echo "[ok] Backend stopped."
    ;;
  status)
    docker compose ps
    echo ""
    if is_healthy; then
      echo "[ok] Backend is healthy"
    else
      echo "[!!] Backend is not responding"
    fi
    ;;
  logs)
    docker compose logs -f
    ;;
  clean)
    docker compose down -v
    echo "[ok] Backend stopped and data volumes removed."
    ;;
  rebuild)
    ensure_docker
    echo "Rebuilding and starting backend..."
    docker compose up -d --build
    wait_for_health
    ;;
  check)
    if is_healthy; then
      echo "[ok] Backend is healthy at $HEALTH_URL"
      exit 0
    else
      echo "[!!] Backend is not responding at $HEALTH_URL"
      exit 1
    fi
    ;;
  *)
    echo "Usage: ./scripts/backend.sh [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  up        Build containers (if needed) and start services (default)"
    echo "  down      Stop all services"
    echo "  status    Show service status and health"
    echo "  logs      Tail service logs"
    echo "  clean     Stop services and remove data volumes"
    echo "  rebuild   Rebuild the memory-layer image and restart services"
    echo "  check     Check if backend is healthy (exit 0/1)"
    exit 1
    ;;
esac
