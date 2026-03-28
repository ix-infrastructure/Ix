#!/usr/bin/env bash
# Config Security Policy Checks
#
# Enforces deployment safety invariants for Docker Compose files:
#   - If auth is disabled (ARANGO_NO_AUTH), all ports must bind to 127.0.0.1
#   - If database password is empty, all ports must bind to 127.0.0.1
#   - No port bindings to 0.0.0.0 in compose files
#
# Exit 0 = all checks pass, Exit 1 = policy violation found.

set -euo pipefail

ERRORS=0
CHECKED=0

err()  { printf "  \033[31m[FAIL]\033[0m %s\n" "$*" >&2; ERRORS=$((ERRORS + 1)); }
ok()   { printf "  \033[32m[PASS]\033[0m %s\n" "$*"; }
info() { printf "  \033[36m[INFO]\033[0m %s\n" "$*"; }

# Find all docker-compose files
COMPOSE_FILES=$(find . -maxdepth 3 -name 'docker-compose*.yml' -o -name 'docker-compose*.yaml' | grep -v node_modules | grep -v '.git/' | sort)

if [ -z "$COMPOSE_FILES" ]; then
  info "No docker-compose files found — skipping"
  exit 0
fi

for file in $COMPOSE_FILES; do
  info "Checking $file"
  CHECKED=$((CHECKED + 1))

  # Check for auth-disabled patterns
  has_no_auth=false
  has_empty_password=false

  if grep -qE 'ARANGO_NO_AUTH.*["\x27]?1["\x27]?' "$file" 2>/dev/null; then
    has_no_auth=true
  fi

  if grep -qE 'ARANGO_PASSWORD:\s*["\x27]{2}' "$file" 2>/dev/null || \
     grep -qE 'ARANGO_PASSWORD:\s*$' "$file" 2>/dev/null; then
    has_empty_password=true
  fi

  # Extract port bindings (lines matching "- <host>:<container>" pattern)
  # Valid: "127.0.0.1:8529:8529"  Invalid: "0.0.0.0:8529:8529" or "8529:8529"
  port_lines=$(grep -nE '^\s*-\s*["\x27]?[0-9]' "$file" 2>/dev/null || true)

  if [ -n "$port_lines" ]; then
    # Check for 0.0.0.0 bindings (always bad in compose files)
    if echo "$port_lines" | grep -qE '0\.0\.0\.0:'; then
      err "$file: port binding to 0.0.0.0 — must use 127.0.0.1 for local-only services"
    fi

    # Check for unqualified port bindings (e.g., "8529:8529" without IP)
    # These bind to all interfaces by default
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # Strip grep line number prefix, leading whitespace, dash, and quotes
      port_val=$(echo "$line" | sed "s/^[0-9]*://; s/^[[:space:]]*-[[:space:]]*//; s/[\"']//g")
      # If it's just port:port (no IP prefix), it binds to all interfaces
      if echo "$port_val" | grep -qE '^[0-9]+:[0-9]+$'; then
        if [ "$has_no_auth" = true ] || [ "$has_empty_password" = true ]; then
          err "$file: unqualified port binding '$port_val' with auth disabled — must prefix with 127.0.0.1:"
        fi
      fi
    done <<< "$port_lines"
  fi

  # If auth is disabled, verify ALL port bindings are localhost-only
  if [ "$has_no_auth" = true ] || [ "$has_empty_password" = true ]; then
    reason=""
    [ "$has_no_auth" = true ] && reason="ARANGO_NO_AUTH=1"
    [ "$has_empty_password" = true ] && reason="${reason:+$reason, }empty ARANGO_PASSWORD"

    # Check that every port binding starts with 127.0.0.1
    non_local=$(echo "$port_lines" | grep -vE '127\.0\.0\.1:' | grep -vE '^\s*$' || true)
    if [ -z "$non_local" ]; then
      ok "$file: auth relaxed ($reason) but all ports bound to 127.0.0.1"
    fi
  else
    ok "$file: auth configuration looks safe"
  fi
done

echo ""
info "Checked $CHECKED compose file(s)"

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  err "Found $ERRORS policy violation(s)"
  exit 1
fi

ok "All config security checks passed"
exit 0
