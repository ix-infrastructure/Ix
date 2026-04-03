#!/usr/bin/env bash
# Ix Cloud — VM Startup Script (MVP)
#
# Runs automatically when a GCP VM boots.
# Installs Docker, starts ArangoDB + Memory Layer, exposes port 8090 directly.
#
# Metadata inputs (set by provision.sh):
#   client-name — identifier for this client instance

set -euo pipefail
exec > /var/log/ix-cloud-startup.log 2>&1

echo "=== Ix Cloud startup — $(date) ==="

CLIENT_NAME=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/client-name" || echo "unknown")

echo "Client: $CLIENT_NAME"

# -- 1. Install Docker --

if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "[ok] Docker installed"
else
  echo "[ok] Docker already installed"
fi

# -- 2. Set up Ix backend --

IX_DIR="/opt/ix"
mkdir -p "$IX_DIR"

# Memory Layer listens on 0.0.0.0 so it's reachable from outside the VM
cat > "$IX_DIR/docker-compose.yml" <<'COMPOSE'
services:
  arangodb:
    image: arangodb:3.12
    networks:
      - backend
    environment:
      ARANGO_NO_AUTH: "1"
    volumes:
      - arangodb-data:/var/lib/arangodb3
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8529/_api/version || exit 1"]
      interval: 5s
      timeout: 5s
      start_period: 60s
      retries: 15
    restart: unless-stopped

  memory-layer:
    image: ghcr.io/ix-infrastructure/ix-memory-layer:latest
    networks:
      - backend
    ports:
      - "0.0.0.0:8090:8090"
    environment:
      ARANGO_HOST: arangodb
      ARANGO_PORT: "8529"
      ARANGO_DATABASE: ix_memory
      ARANGO_USER: root
      ARANGO_PASSWORD: ""
      PORT: "8090"
    depends_on:
      arangodb:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8090/v1/health"]
      interval: 10s
      timeout: 3s
      start_period: 15s
      retries: 5
    restart: unless-stopped

volumes:
  arangodb-data:

networks:
  backend:
COMPOSE

echo "Starting Ix backend..."
cd "$IX_DIR"
docker compose up -d --pull always

# Wait for healthy
echo "Waiting for backend to become healthy..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8090/v1/health >/dev/null 2>&1; then
    echo "[ok] Backend is healthy"
    break
  fi
  sleep 2
done

EXTERNAL_IP=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" || echo "")

echo ""
echo "=== Ix Cloud ready ==="
echo "  Client:   $CLIENT_NAME"
echo "  Endpoint: http://$EXTERNAL_IP:8090"
echo "  Health:   curl -s http://$EXTERNAL_IP:8090/v1/health"
