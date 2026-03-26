#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

check_docker() {
  if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed."
    exit 1
  fi
  if ! docker info &> /dev/null 2>&1; then
    echo "Error: Docker is not running."
    exit 1
  fi
}

wait_for_health() {
  echo "Waiting for services to become healthy..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:8090/v1/health > /dev/null 2>&1; then
      echo ""
      echo "Ix backend is ready!"
      echo "  Memory Layer: http://localhost:8090"
      echo "  ArangoDB:     http://localhost:8529"
      return 0
    fi
    printf "."
    sleep 2
  done
  echo ""
  echo "Warning: Health check timed out. Check 'docker compose logs' for details."
  return 1
}

case "${1:-up}" in
  up)
    check_docker
    echo "Starting Ix backend..."
    docker compose up -d --build
    wait_for_health
    ;;
  down)
    docker compose down
    echo "Ix backend stopped."
    ;;
  logs)
    docker compose logs -f
    ;;
  clean)
    docker compose down -v
    echo "Ix backend stopped and data volumes removed."
    ;;
  rebuild)
    check_docker
    echo "Rebuilding and starting Ix backend..."
    docker compose up -d --build
    wait_for_health
    ;;
  status)
    docker compose ps
    ;;
  *)
    echo "Usage: ./stack.sh [up|down|logs|clean|rebuild|status]"
    echo ""
    echo "  up       Build containers (if needed) and start all services (default)"
    echo "  down     Stop all services"
    echo "  logs     Tail service logs"
    echo "  clean    Stop all services and remove data volumes"
    echo "  rebuild  Rebuild the memory-layer image and restart services"
    echo "  status   Show service status"
    exit 1
    ;;
esac
