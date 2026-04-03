#!/usr/bin/env bash
# Ix Cloud — Provision a client VM on GCP (MVP)
#
# Usage:
#   ./ix-cloud/provision.sh <client-name> [--zone us-central1-a] [--machine-type e2-medium]
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Compute Engine API enabled
#   - Firewall rule 'allow-ix-http' exists:
#       gcloud compute firewall-rules create allow-ix-http \
#         --allow=tcp:8090 --target-tags=ix-cloud --direction=INGRESS

set -euo pipefail

# Ensure gcloud is in PATH (Homebrew installs to /usr/local/share/google-cloud-sdk/bin)
for p in /usr/local/share/google-cloud-sdk/bin /opt/homebrew/share/google-cloud-sdk/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# -- Parse args --

CLIENT_NAME="${1:-}"
ZONE="us-central1-a"
MACHINE_TYPE="e2-medium"
DISK_SIZE="20GB"

if [ -z "$CLIENT_NAME" ]; then
  echo "Usage: ./ix-cloud/provision.sh <client-name> [--zone ZONE] [--machine-type TYPE]"
  echo ""
  echo "Examples:"
  echo "  ./ix-cloud/provision.sh acme-corp"
  echo "  ./ix-cloud/provision.sh acme-corp --zone us-east1-b --machine-type e2-small"
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="$2"; shift 2 ;;
    --machine-type) MACHINE_TYPE="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

VM_NAME="ix-${CLIENT_NAME}"

# -- Preflight checks --

if ! command -v gcloud &>/dev/null; then
  echo "Error: gcloud CLI not found."
  echo "  Install: brew install google-cloud-sdk"
  exit 1
fi

PROJECT=$(gcloud config get-value project 2>/dev/null)
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "Error: No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "╔══════════════════════════════════════════╗"
echo "║       Ix Cloud — Provision               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Client:       $CLIENT_NAME"
echo "  VM:           $VM_NAME"
echo "  Project:      $PROJECT"
echo "  Zone:         $ZONE"
echo "  Machine:      $MACHINE_TYPE"
echo ""

# Check if VM already exists
if gcloud compute instances describe "$VM_NAME" --zone="$ZONE" &>/dev/null; then
  echo "Error: VM '$VM_NAME' already exists in zone $ZONE"
  echo "  To re-provision, first run: ./ix-cloud/teardown.sh $CLIENT_NAME --zone $ZONE"
  exit 1
fi

# -- Create VM --

echo "Creating VM..."
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size="$DISK_SIZE" \
  --tags=ix-cloud \
  --metadata="client-name=$CLIENT_NAME" \
  --metadata-from-file="startup-script=$SCRIPT_DIR/startup-script.sh" \
  --scopes=default \
  --quiet

echo "[ok] VM created"

# -- Get external IP --

EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

echo "  External IP:  $EXTERNAL_IP"

# -- Wait for backend to be ready --

echo ""
echo "Waiting for Ix backend to start (takes 2-3 min on first boot)..."
for i in $(seq 1 90); do
  if curl -sf --connect-timeout 3 "http://$EXTERNAL_IP:8090/v1/health" >/dev/null 2>&1; then
    echo ""
    echo "[ok] Backend is healthy!"
    break
  fi
  printf "."
  sleep 4
done

# Final health check
if ! curl -sf --connect-timeout 3 "http://$EXTERNAL_IP:8090/v1/health" >/dev/null 2>&1; then
  echo ""
  echo "[!!] Backend not yet responding — it may still be starting."
  echo "  Check logs: gcloud compute ssh $VM_NAME --zone=$ZONE -- cat /var/log/ix-cloud-startup.log"
  echo ""
fi

# -- Print connection details --

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Client Ready                        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Client:    $CLIENT_NAME"
echo "  Endpoint:  http://$EXTERNAL_IP:8090"
echo "  VM:        $VM_NAME ($ZONE)"
echo ""
echo "  Test it:"
echo "    curl -s http://$EXTERNAL_IP:8090/v1/health"
echo ""
echo "  Point your ix CLI at it:"
echo "    Edit ~/.ix/config.yaml → set endpoint: http://$EXTERNAL_IP:8090"
echo "    Then: ix stats"
echo ""
echo "  SSH into the VM:"
echo "    gcloud compute ssh $VM_NAME --zone=$ZONE"
echo ""
echo "  Tear down:"
echo "    ./ix-cloud/teardown.sh $CLIENT_NAME"
echo ""
