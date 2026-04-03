#!/usr/bin/env bash
# Ix Cloud — Teardown a client VM
#
# Usage:
#   ./ix-cloud/teardown.sh <client-name> [--zone us-central1-a]

set -euo pipefail

# Ensure gcloud is in PATH
for p in /usr/local/share/google-cloud-sdk/bin /opt/homebrew/share/google-cloud-sdk/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

CLIENT_NAME="${1:-}"
ZONE="us-central1-a"

if [ -z "$CLIENT_NAME" ]; then
  echo "Usage: ./ix-cloud/teardown.sh <client-name> [--zone ZONE]"
  exit 1
fi

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --zone) ZONE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

VM_NAME="ix-${CLIENT_NAME}"

echo "Tearing down VM: $VM_NAME (zone: $ZONE)"
echo ""

if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" &>/dev/null; then
  echo "VM '$VM_NAME' not found in zone $ZONE"
  exit 1
fi

read -rp "Are you sure you want to delete $VM_NAME? This destroys all data. [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

gcloud compute instances delete "$VM_NAME" --zone="$ZONE" --quiet
echo ""
echo "[ok] VM '$VM_NAME' deleted."
