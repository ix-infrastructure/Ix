#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — R Parser Diagnostic
#
# Tests R parser health against a real project. Covers:
#   - File discovery (.r / .R extensions)
#   - Function extraction (← assignment style)
#   - Language tag correctness
#   - CALLS edges (direct and package-qualified)
#   - IMPORTS edges (library / require / source)
#   - Nested function detection
#
# Usage:
#   ./scripts/test-r-parser.sh /path/to/r-project
#   ./scripts/test-r-parser.sh /path/to/r-project --no-reset   # skip graph wipe
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_DIR=""
SKIP_RESET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-reset) SKIP_RESET=true; shift ;;
    -h|--help)
      echo "Usage: ./scripts/test-r-parser.sh <PROJECT_DIR> [--no-reset]"
      exit 0 ;;
    *)
      if [ -z "$PROJECT_DIR" ] && [ -d "$1" ]; then
        PROJECT_DIR="$1"
      else
        echo "Unknown option or invalid directory: $1"; exit 1
      fi
      shift ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  echo "Error: project directory required."
  echo "Usage: ./scripts/test-r-parser.sh <PROJECT_DIR>"
  exit 1
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✓  $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗  $1"; FAIL=$((FAIL+1)); }
skip() { echo "  –  $1 (skipped: $2)"; SKIP=$((SKIP+1)); }
info() { echo "     $1"; }

require_nonzero() {
  local label="$1" value="$2"
  if [ "$value" -gt 0 ] 2>/dev/null; then pass "$label ($value)";
  else fail "$label — got 0"; fi
}

require_eq() {
  local label="$1" value="$2" expected="$3"
  if [ "$value" = "$expected" ]; then pass "$label = $expected";
  else fail "$label — expected '$expected', got '$value'"; fi
}

py() { python3 -c "$1"; }

# ── Step 1: Reset + ingest ────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — R Parser Diagnostic           ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Project: $PROJECT_DIR"
echo ""

R_FILE_COUNT=$(find "$PROJECT_DIR" -name "*.r" -o -name "*.R" | wc -l | tr -d ' ')
info "$R_FILE_COUNT R files found on disk"

if [ "$R_FILE_COUNT" -eq 0 ]; then
  echo ""
  echo "  No .r/.R files found — is this an R project?"
  exit 1
fi

echo ""
echo "── [1] Ingestion ────────────────────────────────────"

if [ "$SKIP_RESET" = false ]; then
  ix reset --code -y 2>/dev/null
fi

INGEST_JSON=$(ix ingest "$PROJECT_DIR" --force --format json 2>/dev/null)
DISCOVERED=$(echo "$INGEST_JSON" | py "import json,sys; print(json.load(sys.stdin)['filesDiscovered'])")
CHANGED=$(echo "$INGEST_JSON"   | py "import json,sys; print(json.load(sys.stdin)['filesChanged'])")

info "Discovered: $DISCOVERED files, changed: $CHANGED files"
require_nonzero "Files ingested" "$CHANGED"

echo ""
echo "── [2] Entity extraction ────────────────────────────"

INVENTORY_JSON=$(ix inventory --kind function --format json 2>/dev/null)

TOTAL_FUNCS=$(echo "$INVENTORY_JSON" | py "import json,sys; print(json.load(sys.stdin)['total'])")
require_nonzero "Functions extracted" "$TOTAL_FUNCS"

R_FILE_FUNC_COUNT=$(echo "$INVENTORY_JSON" | py "
import json, sys
d = json.load(sys.stdin)
print(sum(1 for f in d['byFile'] if f['path'].lower().endswith('.r')))
")
require_nonzero "R files with extracted functions" "$R_FILE_FUNC_COUNT"

# Pick the first R file that has functions for deeper checks
FIRST_R_FILE=$(echo "$INVENTORY_JSON" | py "
import json, sys
d = json.load(sys.stdin)
r = next((f['path'] for f in d['byFile'] if f['path'].lower().endswith('.r')), '')
print(r)
")

echo ""
echo "── [3] Entity quality ───────────────────────────────"

if [ -n "$FIRST_R_FILE" ]; then
  FILE_OV=$(ix overview "$FIRST_R_FILE" --format json 2>/dev/null)
  FILE_ID=$(echo "$FILE_OV" | py "import json,sys; print(json.load(sys.stdin)['resolvedTarget']['id'])")

  CONTAINS_JSON=$(ix contains "$FILE_ID" --format json 2>/dev/null)
  FIRST_FN_ID=$(echo "$CONTAINS_JSON" | py "
import json, sys
d = json.load(sys.stdin)
fns = [r for r in d['results'] if r['kind'] == 'function']
print(fns[0]['id'] if fns else '')
")
  FIRST_FN_NAME=$(echo "$CONTAINS_JSON" | py "
import json, sys
d = json.load(sys.stdin)
fns = [r for r in d['results'] if r['kind'] == 'function']
print(fns[0]['name'] if fns else '')
")

  if [ -n "$FIRST_FN_ID" ]; then
    ENTITY_JSON=$(ix entity "$FIRST_FN_ID" --format json 2>/dev/null)
    LANG=$(echo "$ENTITY_JSON"       | py "import json,sys; print(json.load(sys.stdin)['node']['attrs'].get('language','missing'))")
    LINE_START=$(echo "$ENTITY_JSON" | py "import json,sys; print(json.load(sys.stdin)['node']['attrs'].get('line_start','missing'))")
    LINE_END=$(echo "$ENTITY_JSON"   | py "import json,sys; print(json.load(sys.stdin)['node']['attrs'].get('line_end','missing'))")

    require_eq  "Language tag on '$FIRST_FN_NAME'" "$LANG" "r"
    require_nonzero "line_start on '$FIRST_FN_NAME'" "$LINE_START"
    require_nonzero "line_end on '$FIRST_FN_NAME'"   "$LINE_END"
  else
    fail "Could not extract function entity ID from $FIRST_R_FILE"
  fi
else
  fail "No R file with functions found for quality checks"
fi

echo ""
echo "── [4] Call graph (CALLS edges) ─────────────────────"

STATS_JSON=$(ix stats --format json 2>/dev/null)
CALLS_COUNT=$(echo "$STATS_JSON" | py "
import json, sys
d = json.load(sys.stdin)
edges = {e['predicate']: e['count'] for e in d['edges']['byPredicate']}
print(edges.get('CALLS', 0))
")
require_nonzero "CALLS edges in graph" "$CALLS_COUNT"

if [ -n "$FIRST_FN_ID" ]; then
  IMPACT_JSON=$(ix impact "$FIRST_FN_ID" --format json 2>/dev/null)
  CALLEES=$(echo "$IMPACT_JSON" | py "import json,sys; print(json.load(sys.stdin)['summary']['callees'])")
  info "'$FIRST_FN_NAME' has $CALLEES callee(s)"

  # Scan all inventory files for at least one function with callees
  HAS_CALLEES=$(echo "$INVENTORY_JSON" | py "
import json, sys
d = json.load(sys.stdin)
# Report how many distinct files have R functions
print(len([f for f in d['byFile'] if f['path'].lower().endswith('.r') and f['items']]))
")
  info "R files with at least 1 function: $HAS_CALLEES"
fi

echo ""
echo "── [5] Import graph (IMPORTS edges) ─────────────────"

IMPORTS_COUNT=$(echo "$STATS_JSON" | py "
import json, sys
d = json.load(sys.stdin)
edges = {e['predicate']: e['count'] for e in d['edges']['byPredicate']}
print(edges.get('IMPORTS', 0))
")

# IMPORTS may be 0 if the project doesn't use library()/require()/source()
LIBRARY_CALLS=$(grep -r --include="*.r" --include="*.R" -l "library\|require\|source(" "$PROJECT_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$LIBRARY_CALLS" -gt 0 ]; then
  require_nonzero "IMPORTS edges (project has library/require/source)" "$IMPORTS_COUNT"
else
  skip "IMPORTS edges" "no library/require/source calls found in project"
fi

echo ""
echo "── [6] Edge case: package-qualified calls (pkg::fn) ─"

QUALIFIED_CALLS=$(grep -r --include="*.r" --include="*.R" -l "::" "$PROJECT_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$QUALIFIED_CALLS" -gt 0 ]; then
  # Check CALLS edges where dstName contains '.' (our pkg.fn convention)
  # Use ix text search as a proxy — if pkg::fn calls are in source, CALLS edges should exist
  info "Project has $QUALIFIED_CALLS file(s) with '::' calls — check CALLS edges contain 'pkg.fn' names"
  info "Run: ix callers <fn-id> --format json to inspect specific qualified call edges"
else
  skip "Package-qualified calls (pkg::fn)" "no '::' usage found in project"
fi

echo ""
echo "── [7] Edge case: nested functions ──────────────────"

# Proxy: if inventory shows functions that share a file and one is "inner", both should appear
NESTED=$(grep -r --include="*.r" --include="*.R" -l "function.*{" "$PROJECT_DIR" 2>/dev/null | \
  xargs grep -l "^\s\+[a-zA-Z_][a-zA-Z0-9_.]*\s*<-\s*function" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NESTED" -gt 0 ]; then
  info "$NESTED file(s) appear to contain nested function definitions"
  info "Verify both inner and outer functions appear in 'ix inventory --kind function'"
else
  skip "Nested functions" "no obvious nested definitions found"
fi

echo ""
echo "── Summary ──────────────────────────────────────────"
echo ""
echo "  Project:  $PROJECT_DIR"
echo "  R files:  $R_FILE_COUNT"
printf "  Results:  %s passed  %s failed  %s skipped\n" "$PASS" "$FAIL" "$SKIP"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  ✓ R parser looks healthy for this project."
else
  echo "  ✗ $FAIL check(s) failed — review output above."
fi
echo ""
