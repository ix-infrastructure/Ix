#!/usr/bin/env bash
# ix-smoke-test.sh
#
# Smoke test for Ix-Memory fixes:
# - Claim lifecycle: old claims retired (deletedRev set) when new ones added
# - Search indexes: name + provenance + claims (statement/value)
# - Diff works on the correct entity and shows content change
#
# Assumptions:
# - Run from repo root (IX-Memory)
# - docker + docker compose available
# - sbt available
# - node + npm available
# - backend listens on http://localhost:8090, arango on http://localhost:8529
#
# Notes:
# - This script starts memory-layer in the background and cleans up on exit.
# - It uses python3 for JSON assertions (no jq needed).


set -euo pipefail

# Enable verbose tracing by setting IX_TRACE=1
if [[ "${IX_TRACE:-0}" == "1" ]]; then
  set -x
fi

on_err() {
  local exit_code=$?
  echo "" >&2
  echo "ERROR: script failed (exit=${exit_code}) at line ${BASH_LINENO[0]}: ${BASH_COMMAND}" >&2
  # Print last 120 lines of the most relevant logs if they exist
  [[ -f "${NPM_LOG:-}" ]] && { echo "--- tail ${NPM_LOG} ---" >&2; tail -n 120 "${NPM_LOG}" >&2 || true; }
  [[ -f "${ML_LOG:-}" ]] && { echo "--- tail ${ML_LOG} ---" >&2; tail -n 120 "${ML_LOG}" >&2 || true; }
  exit "${exit_code}"
}
trap on_err ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ---------- helpers ----------
log() { printf "\n\033[1m[%s]\033[0m %s\n" "$(date +%H:%M:%S)" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

wait_http_ok() {
  local url="$1"
  local tries="${2:-60}"
  local sleep_s="${3:-1}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

# Wait for a TCP port to open (no curl dependency)
wait_tcp_open() {
  local host="$1"
  local port="$2"
  local tries="${3:-60}"
  local sleep_s="${4:-1}"
  for _ in $(seq 1 "$tries"); do
    # bash built-in TCP check (no curl dependency)
    if (exec 3<>"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      exec 3>&- 3<&- || true
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

py_assert() {
  # usage: py_assert '<python expr>' '<json file>'
  local expr="$1"
  local file="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys
path = sys.argv[1]
expr = sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
# Make "data" available to expression
SAFE_BUILTINS = {
    "isinstance": isinstance,
    "len": len,
    "any": any,
    "all": all,
    "min": min,
    "max": max,
    "sum": sum,
    "sorted": sorted,
    "dict": dict,
    "list": list,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
}
ok = eval(expr, {"__builtins__": SAFE_BUILTINS}, {"data": data})
if not ok:
    raise SystemExit(f"Assertion failed: {expr}\nData: {json.dumps(data, indent=2)[:4000]}")
PY
}

# ---------- preflight ----------
log "Preflight checks"
require docker
require curl
require npm
require node
require sbt
require python3

# ---------- cleanup trap ----------
ML_PID=""
TMPDIR=""
STARTED_COMPOSE=0
cleanup() {
  set +e
  if [[ -n "${ML_PID}" ]]; then
    log "Stopping memory-layer (pid=${ML_PID})"
    kill "${ML_PID}" >/dev/null 2>&1 || true
    wait "${ML_PID}" >/dev/null 2>&1 || true
  fi
  # Only stop arango if we started it
  if [[ "${STARTED_COMPOSE}" == "1" ]]; then
    if [[ -x "./dev.sh" ]]; then
      log "Stopping ArangoDB via dev.sh"
      ./dev.sh down >/dev/null 2>&1 || true
    else
      log "Stopping docker compose stack"
      docker compose down >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "${TMPDIR}" && -d "${TMPDIR}" ]]; then
    log "Removing temp dir ${TMPDIR}"
    rm -rf "${TMPDIR}" || true
  fi
}
trap cleanup EXIT

# ---------- build ix CLI (local entrypoint; no global npm link) ----------
log "Building ix CLI"
[[ -d "ix-cli" ]] || die "Expected ./ix-cli directory at repo root"
NPM_LOG="/tmp/ix-smoke-npm.$(date +%s).log"
log "npm logs: ${NPM_LOG}"
pushd ix-cli >/dev/null
# Don't hide npm errors; write full output to log
npm install >"${NPM_LOG}" 2>&1
npm run build >>"${NPM_LOG}" 2>&1
# Show a short tail so failures are easier to spot in CI logs
{ echo "--- npm tail ---"; tail -n 40 "${NPM_LOG}"; } >/dev/null || true

# Run the CLI from the locally built entrypoint to avoid relying on global npm commands
IX_ENTRY="${REPO_ROOT}/ix-cli/dist/cli/main.js"
[[ -f "${IX_ENTRY}" ]] || { echo "--- npm tail ---" >&2; tail -n 120 "${NPM_LOG}" >&2 || true; die "Expected CLI entrypoint not found: ${IX_ENTRY}. Did TypeScript build output change?"; }

# Use a bash array so we can call the command safely
IX_CMD=(node "${IX_ENTRY}")

log "ix CLI ready (local): node ${IX_ENTRY}"
"${IX_CMD[@]}" --help >/dev/null || die "ix --help failed"
popd >/dev/null

# ---------- start arango ----------
log "Starting ArangoDB"
# Always start ArangoDB in detached mode so this script never blocks.
# dev.sh may run docker compose in the foreground, so avoid calling it here.
docker compose up -d arangodb >/dev/null
STARTED_COMPOSE=1

log "Waiting for ArangoDB on http://localhost:8529/_api/version"
wait_http_ok "http://localhost:8529/_api/version" 60 1 || die "ArangoDB did not become healthy"

# ---------- start memory-layer ----------
log "Starting memory-layer (sbt memoryLayer/run) in background"
ML_LOG="/tmp/ix-memory-layer.$(date +%s).log"
# Run from repo root to ensure multi-project build works
# Use nohup-style background with PID capture
( sbt -no-colors 'memoryLayer/run' ) >"${ML_LOG}" 2>&1 &
ML_PID=$!

log "memory-layer pid=${ML_PID} log=${ML_LOG}"
log "Waiting for memory-layer to open TCP port 8090"
wait_tcp_open "localhost" 8090 90 1 || {
  tail -n 120 "${ML_LOG}" >&2 || true
  die "memory-layer did not open port 8090"
}

# ---------- create test project ----------
TMPDIR="$(mktemp -d /tmp/ix-small-test.XXXXXX)"
log "Creating test project at ${TMPDIR}"

cat >"${TMPDIR}/a.md" <<'EOF'
# hello
EOF
cat >"${TMPDIR}/b.ts" <<'EOF'
console.log("x")
EOF
cat >"${TMPDIR}/c.json" <<'EOF'
{"k": 1}
EOF

# ---------- init ----------
log "Running ix init inside temp project"
pushd "${TMPDIR}" >/dev/null
"${IX_CMD[@]}" init >/dev/null || die "ix init failed"

# ---------- ingest #1 ----------
log "Ingest #1 (temp dir: ${TMPDIR})"
ING1_JSON="${TMPDIR}/ingest1.json"
"${IX_CMD[@]}" ingest "${TMPDIR}" --recursive --format json > "${ING1_JSON}" || {
  tail -n 120 "${ML_LOG}" >&2 || true
  die "ix ingest #1 failed"
}

# Basic sanity: processed 3 files
py_assert 'isinstance(data, dict) and data.get("filesProcessed", 0) >= 3' "${ING1_JSON}"

# Search "hello" -> should return doc entity
S_HELLO_1="${TMPDIR}/search_hello_1.json"
"${IX_CMD[@]}" search "hello" --format json > "${S_HELLO_1}"
py_assert 'isinstance(data, list) and len(data) >= 1' "${S_HELLO_1}"
py_assert 'any(x.get("kind")=="doc" and x.get("id") for x in data)' "${S_HELLO_1}"

DOC_ID="$(python3 - <<PY
import json
d=json.load(open("${S_HELLO_1}","r"))
for x in d:
    if x.get("kind")=="doc":
        print(x["id"])
        break
PY
)"
[[ -n "${DOC_ID}" ]] || die "Could not find doc id from search hello"

log "Doc entity id: ${DOC_ID}"

# Search by full path should work after the SEARCH fix is implemented
S_PATH_1="${TMPDIR}/search_path_1.json"
"${IX_CMD[@]}" search "${TMPDIR}/a.md" --format json > "${S_PATH_1}" || true

# Soft assertion: if patched search is expected, enforce it. If you want this script
# to pass on older builds, set REQUIRE_PATH_SEARCH=0.
REQUIRE_PATH_SEARCH="${REQUIRE_PATH_SEARCH:-1}"
if [[ "${REQUIRE_PATH_SEARCH}" == "1" ]]; then
  py_assert 'isinstance(data, list) and len(data) >= 1' "${S_PATH_1}"
fi

# Claims search should work after SEARCH fix: statement ("language") and/or value ("markdown")
REQUIRE_CLAIM_SEARCH="${REQUIRE_CLAIM_SEARCH:-1}"
S_LANG_1="${TMPDIR}/search_language_1.json"
"${IX_CMD[@]}" search "language" --format json > "${S_LANG_1}" || true
if [[ "${REQUIRE_CLAIM_SEARCH}" == "1" ]]; then
  py_assert 'isinstance(data, list) and len(data) >= 1' "${S_LANG_1}"
fi

# ---------- modify content + ingest #2 ----------
log "Modifying a.md and ingest #2"
echo "zzzxqv123" >> "${TMPDIR}/a.md"

ING2_JSON="${TMPDIR}/ingest2.json"
"${IX_CMD[@]}" ingest "${TMPDIR}" --recursive --format json > "${ING2_JSON}" || {
  tail -n 120 "${ML_LOG}" >&2 || true
  die "ix ingest #2 failed"
}
py_assert 'isinstance(data, dict) and data.get("filesProcessed", 0) >= 1' "${ING2_JSON}"

# Search for new content should work after SEARCH fix (claim/value/attrs indexing)
REQUIRE_CONTENT_SEARCH="${REQUIRE_CONTENT_SEARCH:-1}"
S_ZZZ="${TMPDIR}/search_zzz.json"
"${IX_CMD[@]}" search "zzzxqv123" --format json > "${S_ZZZ}" || true
if [[ "${REQUIRE_CONTENT_SEARCH}" == "1" ]]; then
  py_assert 'isinstance(data, list) and any(x.get("id")== "'"${DOC_ID}"'" for x in data)' "${S_ZZZ}"
fi

# ---------- diff ----------
log "Diff doc entity rev3 -> rev4 should show attrs.content changed"
DIFF_JSON="${TMPDIR}/diff_3_4.json"
"${IX_CMD[@]}" diff 3 4 --entity "${DOC_ID}" --format json > "${DIFF_JSON}" || die "ix diff failed"

py_assert 'isinstance(data, dict) and data.get("fromRev")==3 and data.get("toRev")==4' "${DIFF_JSON}"
py_assert 'isinstance(data.get("changes"), list) and len(data["changes"])>=1' "${DIFF_JSON}"
py_assert 'any(ch.get("entityId")== "'"${DOC_ID}"'" and ch.get("changeType")=="modified" for ch in data["changes"])' "${DIFF_JSON}"
py_assert 'any(ch.get("atFromRev",{}).get("attrs",{}).get("content","") == "" and ch.get("atToRev",{}).get("attrs",{}).get("content","") == "zzzxqv123" for ch in data["changes"])' "${DIFF_JSON}"

# ---------- entity + claim lifecycle check (best-effort) ----------
# If ix entity includes claims, verify old content claim is retired (deletedRev set) and only one active content claim remains.
log "Checking claim lifecycle via ix entity (best-effort; depends on entity response including claims)"
ENTITY_JSON="${TMPDIR}/entity_doc.json"
"${IX_CMD[@]}" entity "${DOC_ID}" --format json > "${ENTITY_JSON}" || die "ix entity failed"

# If entity response includes a "claims" list, enforce lifecycle.
python3 - <<PY
import json, sys
d=json.load(open("${ENTITY_JSON}","r"))
claims=d.get("claims")
if not isinstance(claims, list):
    print("NOTE: entity response has no 'claims' array; skipping claim lifecycle assertion.")
    sys.exit(0)

content_claims=[c for c in claims if c.get("statement")=="content"]
active=[c for c in content_claims if c.get("deletedRev") in (None, "null") and c.get("status","").lower()=="active"]
if len(active)!=1:
    raise SystemExit(f"Expected exactly 1 active 'content' claim; got {len(active)}\n{content_claims}")

if str(active[0].get("value","")).strip('"') != "zzzxqv123":
    raise SystemExit(f"Active content claim value not zzzxqv123: {active[0]}")

older=[c for c in content_claims if c.get("createdRev")==3]
if older:
    if older[0].get("deletedRev") not in (4, "4"):
        raise SystemExit(f"Expected rev3 content claim deletedRev=4; got {older[0]}")
print("Claim lifecycle assertion passed via ix entity.")
PY

popd >/dev/null

log "✅ Smoke test PASSED"
log "Temp project: ${TMPDIR}"
log "memory-layer log: ${ML_LOG}"
log "Tip: set REQUIRE_PATH_SEARCH=0 / REQUIRE_CLAIM_SEARCH=0 / REQUIRE_CONTENT_SEARCH=0 to relax expectations."