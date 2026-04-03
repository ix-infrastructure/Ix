#!/usr/bin/env bash
# Ix Cloud — List all client VMs
#
# Usage:
#   ./ix-cloud/list.sh

set -euo pipefail

# Ensure gcloud is in PATH
for p in /usr/local/share/google-cloud-sdk/bin /opt/homebrew/share/google-cloud-sdk/bin; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

echo "Ix Cloud Instances"
echo "─────────────────────────────────────────────────────────────────"

gcloud compute instances list \
  --filter="tags.items=ix-cloud" \
  --format="table(name, zone.basename(), status, networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP, metadata.items[0].value:label=CLIENT)"

echo ""
echo "Total: $(gcloud compute instances list --filter='tags.items=ix-cloud' --format='value(name)' | wc -l | tr -d ' ') instance(s)"
