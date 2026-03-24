# Ingestion Performance Fix

## Context

`core-ingestion/src/index.ts` on this branch added chunk extraction (`ParsedChunk`) which is
great, but introduced 3 regressions vs the fast baseline. Fix all three.

## Change Tracking

This section is the handoff record for follow-up review and bug fixing.

### Files changed

- `core-ingestion/src/index.ts`
  Restored a module-level tree-sitter query cache, replaced `source.split('\n')`
  with a character-scan line counter, and moved per-definition chunk hash work
  into a post-match pass using a `pendingChunks` buffer. Also added one explicit
  `(s: string)` type annotation in existing import parsing code so the package
  still builds under the current TypeScript settings.
- `docs/plans/ingestion-perf-fix.md`
  Added this change-tracking section and will keep verification notes here.

### Verification notes

- `core-ingestion`: `npm run build` passed on 2026-03-22
- `ix map` cold-ingest check: not run; skipped because `ix reset --code -y`
  mutates indexed state and was not necessary to complete the code change

---

## Fix 1 — Restore the per-process query cache (CRITICAL)

**File:** `core-ingestion/src/index.ts`

**Problem:** `parseFile()` currently calls `new Parser.Query(grammar, queries)` on every
invocation. Compiling a tree-sitter query (S-expression → automata) is expensive. With
100 TypeScript files, it compiles the same TS query 100 times.

**Fix:** Add a module-level query cache (already existed in the baseline) and use it inside
`parseFile()`.

Add this block near the existing `_parser` singleton (around line 180):

```typescript
// Per-process cache for compiled tree-sitter queries, keyed by language.
// Avoids recompiling the same query string for every file of the same language.
const _queryCache = new Map<SupportedLanguages | 'tsx', { grammar: any; query: any }>();

function getCachedQuery(language: SupportedLanguages | 'tsx', grammar: any, querySource: string): any {
  const cached = _queryCache.get(language);
  if (cached && cached.grammar === grammar) return cached.query;
  const query = new Parser.Query(grammar, querySource);
  _queryCache.set(language, { grammar, query });
  return query;
}
```

Then inside `parseFile()`, replace:
```typescript
const query = new Parser.Query(grammar, queries);
```
with:
```typescript
const cacheKey = isTsx ? 'tsx' as const : language;
const query = getCachedQuery(cacheKey, grammar, queries);
```

---

## Fix 2 — Replace `source.split('\n')` with a char scan

**File:** `core-ingestion/src/index.ts`

**Problem:** `const lines = source.split('\n')` allocates a full string array only used for
`lines.length` and `lines.length` in the `file_body` fallback chunk. Wasteful on large files.

**Fix:** Replace the split with a char scan for the line count, and keep a separate
`sourceLineCount` variable. Use it wherever `lines.length` is currently referenced.

Replace:
```typescript
const lines = source.split('\n');
```
with:
```typescript
let sourceLineCount = 1;
for (let i = 0; i < source.length; i++) { if (source.charCodeAt(i) === 10) sourceLineCount++; }
```

Then replace every reference to `lines.length` with `sourceLineCount`.

---

## Fix 3 — Move chunk SHA-256 hashing out of the hot definition loop

**File:** `core-ingestion/src/index.ts`

**Problem:** Inside the first-pass definition loop, every definition does:
```typescript
const chunkText = source.slice(startByte, endByte);
const contentHash = crypto.createHash('sha256').update(chunkText).digest('hex').slice(0, 16);
```
This runs a full SHA-256 for every function/class/method at parse time. For a file with
20 definitions that's 20 crypto operations, plus the `source.slice()` allocations.

**Fix:** Keep the chunk data (startByte, endByte) in a temporary structure during the loop,
then compute all content hashes in a single pass after the loop completes. This doesn't
change output — just batches the hashing after the tree-sitter work is done so the two
phases don't interleave.

Concretely: collect `{ name, kind, lineStart, lineEnd, startByte, endByte, language, container }`
into a `pendingChunks` array during the loop, then after the loop iterate `pendingChunks`
to compute `contentHash` and push into `chunks[]`. The `file_body` fallback should also
keep its hash computation (it's only one hash for the whole file when no chunks exist).

---

## Do NOT change

- The `ParsedChunk` interface and its fields — keep as-is.
- The chunk ops in `patch-builder.ts` (`CONTAINS_CHUNK`, `DEFINES`, `NEXT` edges) — keep as-is.
- The `buildPatchWithResolution` function — keep as-is.
- `resolveEdges` in `index.ts` — keep as-is.
- The `_parser` singleton — keep as-is.
- All query string constants in `queries.ts` — keep as-is.

---

## Verification

After the changes, run:

```bash
cd core-ingestion && npm run build
ix reset --code -y && IX_DEBUG=1 ix map
```

Expected: parse phase timing should drop from ~9s to ~2-3s for 200 files. The
`Source hash lookup: 0 known hashes` line confirms a clean cold ingest.
The map output should still show chunk-based regions (the visual output should be unchanged).
