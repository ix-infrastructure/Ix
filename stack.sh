#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

JAR_PATH="memory-layer/target/scala-2.13/ix-memory-layer.jar"

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

build_jar() {
  local force="${1:-false}"
  if [ "$force" = "true" ] || [ ! -f "$JAR_PATH" ]; then
    echo "Building Memory Layer JAR..."
    sbt "memoryLayer/assembly" 2>&1 | tail -5
  else
    echo "JAR already exists, skipping build. Use 'rebuild' to force."
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
    build_jar
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
  rebuild)
    check_docker
    build_jar true
    echo "Rebuilding and starting Ix backend..."
    docker compose up -d --build
    wait_for_health
    ;;
  status)
    docker compose ps
    ;;
  *)
    echo "Usage: ./stack.sh [up|down|logs|rebuild|status]"
    echo ""
    echo "  up       Build JAR (if needed) and start all services (default)"
    echo "  down     Stop all services"
    echo "  logs     Tail service logs"
    echo "  rebuild  Force rebuild JAR and restart services"
    echo "  status   Show service status"
    exit 1
    ;;
esac
