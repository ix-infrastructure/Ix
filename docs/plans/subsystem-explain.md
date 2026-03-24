# `ix subsystems <target> --explain`

**Date:** 2026-03-22

---

## Overview

`ix explain` produces a narrative breakdown of an individual symbol (function, class, file).
`ix subsystems <target> --explain` does the same thing one level up — for an architectural
region produced by `ix map`.

The goal is to answer: *"What is this subsystem, what does it contain, how healthy is it, and
why does it matter?"* — in plain English, with enough structural context that a developer new
to the codebase can orient themselves immediately.

---

## Reality Check

The basic shape of this plan is correct, but the current codebase has two gaps the original
draft did not account for:

1. The existing scoped subsystem payload is sufficient for most of `--explain`, but it does
   **not** currently expose enough revision metadata to support a reliable
   `"health score may be stale"` note.
2. Large-repo ingestion is currently fragile for architectural reasons that are adjacent to
   this feature work: the ingest path materializes too much in memory, queries too much state
   up front, and emits oversized patch payloads for non-code files.

This document now covers both:
- the concrete changes required for `ix subsystems <target> --explain`
- the concrete changes required to stop ingestion from failing on large repositories

---

## Change Tracking

### Files changed

- `docs/plans/subsystem-explain.md`
  Expanded the plan so it reflects the current subsystem APIs and the large-repo ingestion
  failure modes discovered during code review.

### Verification notes

- Doc-only update; no code or tests run in this pass.

---

## CLI Interface

```
ix subsystems <target> --explain
ix subsystems <target> --explain --format json
ix subsystems <target> --explain --pick <n>
```

`--explain` is a new flag on the existing `subsystems` command, layered on top of the current
target-scoping behaviour.  It is mutually exclusive with `--list`.

**Examples:**

```
ix subsystems api --explain
ix subsystems "Ingestion Layer" --explain
ix subsystems auth --explain --pick 2
ix subsystems auth --explain --format json
```

`--pick` resolves ambiguous matches the same way it does today.

---

## Data Sources

Two existing server calls are combined — no new endpoints required.

| Data | Source |
|---|---|
| Region label, level, parent, children, files, confidence, dominant signals, cross-cutting flag | `GET /v1/subsystems/map?target=…` → `ScopedSubsystemResult` |
| Health score, chunk density, smell rate, smell files, total chunks | `GET /v1/subsystems` → `SubsystemScore[]`, filtered to the resolved region id |

If the health score has not yet been computed for the region (e.g. `ix map` was run but
`ix subsystems` has not been run since), the Health section is omitted and a note is printed:
`Run 'ix subsystems' to compute health scores.`

### Current Data Contract Gap

The current score payload is enough to render Health, but not enough to prove staleness.

Today:
- `GET /v1/subsystems/map` returns scoped region structure without score metadata.
- `GET /v1/subsystems` returns health scores without a `map_rev` or score revision field.

That means this note from the original draft is **not implementable as written**:

`Health score may be stale — run 'ix subsystems' to refresh.`

To support that note cleanly, one of these must change:

1. Add `map_rev` to each stored subsystem score result.
2. Add score `created_rev` or score computation revision to the list response.
3. Remove the stale-health note from v1 and only keep the `"Run 'ix subsystems' to compute health scores."` note when the score is missing.

Recommended v1 choice:
- Keep the feature server-light.
- Do **not** add a stale-health note yet.
- Only add it after score revision metadata is exposed.

---

## Output Sections

### Text Format

```
Explanation
  `Ingestion Layer` serves as a subsystem spanning 34 files. It groups components
  responsible for parsing source files and committing patches to the graph. It sits
  inside the Core System and is well-defined with import coupling as its primary
  structural signal.

Context
  Level:       subsystem (level 2)
  Parent:      Core System (system)
  Files:       34
  Children:    4 modules
  Confidence:  Well-defined (88%)
  Signals:     import coupling · path proximity

Composition
  ● MODULE  File Parser              Well-defined 91%   12 files
  ● MODULE  Patch Builder            Well-defined 84%    9 files
  ● MODULE  Bulk Writer              Moderate     66%    8 files
  ● MODULE  Ingestion Loader         Fuzzy        44%    5 files
  3 well-defined · 1 moderate · 0 fuzzy · 0 cross-cutting

Health
  Score:          ████░  0.74
  Chunk density:  5.1 chunks/file
  Smell rate:     6%  (2 files flagged)
  Status:         Good — rich structure, low smell coverage

Why it matters
  Ingestion Layer is the primary entry path for all source data into the graph.
  Its high chunk density indicates thorough code coverage in the knowledge graph.
  2 files have active smell claims — run `ix smells` to review.
  Run `ix impact "Ingestion Layer"` to see what depends on this subsystem.
```

### JSON Format

`--format json` returns a single object:

```json
{
  "resolvedTarget": {
    "id": "uuid",
    "label": "Ingestion Layer",
    "level": 2,
    "label_kind": "subsystem"
  },
  "explanation": "...",
  "context": {
    "level": 2,
    "label_kind": "subsystem",
    "parent": { "id": "uuid", "label": "Core System", "label_kind": "system" },
    "file_count": 34,
    "child_count": 4,
    "confidence": 0.88,
    "dominant_signals": ["import coupling", "path proximity"],
    "is_cross_cutting": false
  },
  "composition": {
    "children": [
      { "label": "File Parser", "level": 1, "label_kind": "module", "file_count": 12, "confidence": 0.91, "is_cross_cutting": false }
    ],
    "summary": { "well_defined": 3, "moderate": 1, "fuzzy": 0, "cross_cutting": 0 }
  },
  "health": {
    "score": 0.74,
    "chunk_density": 5.1,
    "smell_rate": 0.06,
    "smell_files": 2,
    "total_chunks": 173,
    "status": "good"
  },
  "whyItMatters": "...",
  "notes": []
}
```

`health` is `null` if no score has been computed yet.

---

## Section Definitions

### Explanation

One to two sentence prose summary synthesised from the region label, level, parent name,
dominant signals, file count, and cross-cutting flag.  No LLM — constructed from templates,
the same way `ix explain`'s `describeRoleLocal` and `synthesizeSystemRole` work.

Template inputs:

| Signal | Mapped meaning |
|---|---|
| `level === 3` | "system" — top-level architectural boundary |
| `level === 2` | "subsystem" — a bounded functional area |
| `level === 1` | "module" — a focused implementation cluster |
| `is_cross_cutting` | adds "…and is cross-cutting — it spans multiple subsystems" |
| `dominant_signals` | "Its primary structural signal is import coupling" |
| `parent.label` | "It sits inside the `<parent>` system" |
| `confidence ≥ 0.75` | "well-defined" |
| `confidence ≥ 0.50` | "moderately defined" |
| `confidence < 0.50` | "loosely defined" |

### Context

Tabular structural facts — mirrors the `ix explain` Context section:

```
Level:       subsystem (level 2)
Parent:      Core System (system)
Files:       34
Children:    4 modules
Confidence:  Well-defined (88%)
Signals:     import coupling · path proximity
```

Omit `Children` line when there are none (leaf modules).
Omit `Parent` line for top-level systems with no parent.

### Composition

Renders the immediate child regions as a mini tree, sorted by file count descending
(same comparator as `renderScopedTreeNode`).  Capped at 10 children; if more exist,
append `  … N more. Use 'ix subsystems <target>' for the full tree.`

Followed by the existing well-defined / moderate / fuzzy / cross-cutting tally from
`ScopedSubsystemResult.summary`.

Omit the entire section for leaf regions (no children).

### Health

Uses the `SubsystemScore` for the resolved region id.

```
Score:          ████░  0.74      (healthBar using 5-block scale, same as --list)
Chunk density:  5.1 chunks/file
Smell rate:     6%  (2 files flagged)
Status:         <status phrase>
```

**Status phrases** (derived from score thresholds):

| Score | Status phrase |
|---|---|
| ≥ 0.80 | `Healthy — rich structure, minimal technical debt` |
| ≥ 0.65 | `Good — rich structure, low smell coverage` |
| ≥ 0.45 | `Moderate — structure is present, smell coverage is elevated` |
| < 0.45 | `Needs attention — sparse structure or significant smell coverage` |

Chunk density context lines (appended to Status line as a note):

| Density | Note |
|---|---|
| ≥ 5.0 | `High chunk density indicates thorough code coverage in the knowledge graph.` |
| ≥ 2.0 | *(no note)* |
| < 2.0 | `Low chunk density — run 'ix ingest' to improve coverage.` |

### Why it matters

Single prose paragraph synthesised from health, level, cross-cutting status, and parent
context.  Mirrors the structure of `ix explain`'s `renderWhyItMatters`.

Decision tree:

1. **Cross-cutting + fuzzy confidence** → architectural drift warning:
   `<label> spans multiple subsystems and has low clustering confidence, suggesting architectural drift. Consider decomposing or clarifying its boundaries.`

2. **High health (≥ 0.80) + top-level (level 3)** → stable anchor:
   `<label> is a stable, well-defined system boundary. Changes within it are well-contained. Run 'ix impact "<label>"' to review cross-system dependencies.`

3. **Low health (< 0.45) + smell files > 0** → needs attention:
   `<label> has <N> files with active smell claims and a health score of <score>. Prioritize refactoring here before expanding the subsystem. Run 'ix smells' to review.`

4. **Normal** → role + callers suggestion:
   `<label> is a <status> <level label> <parent phrase>. Run 'ix impact "<label>"' to understand its downstream blast radius.`

### Notes

Mirrors `ix explain`'s Notes section.  Sources:
- Health score missing: `Run 'ix subsystems' to compute health scores for this region.`
- Health score computed at a different revision than current graph:
  `Health score may be stale — run 'ix subsystems' to refresh.`

Implementation note:
- This second note requires new score revision metadata and should be treated as optional
  follow-up work, not part of the minimum implementation.

---

## Ambiguity Handling

Identical to the current `ix subsystems <target>` behaviour.  If the target is ambiguous,
the existing `renderSubsystemError` output is shown and `--explain` is ignored:

```
Ambiguous target "auth". Multiple architecture regions matched:

1. Auth Middleware     subsystem    12 files
2. Auth Tests         module        8 files

Run:
  ix subsystems auth --pick <n> --explain
```

---

## Implementation Plan

### Phase 1 — Client (subsystems.ts)

1. Add `--explain` flag to the command definition.
2. When `--explain` is set and a `ScopedSubsystemResult` is returned:
   a. Make a second call to `client.listSubsystems()` and find the matching `SubsystemScore`
      by `region_id`.
   b. Call a new `renderSubsystemExplanation(scoped, score | null)` function.
3. `renderSubsystemExplanation` implements the five sections above using template functions
   (no new server endpoints, no LLM).
4. If `--format json` is set, return a purpose-built explanation object instead of the current
   scoped map JSON.

New functions (all in `subsystems.ts` or a new `explain/subsystem.ts`):

| Function | Purpose |
|---|---|
| `synthesizeSubsystemExplanation(region, parent)` | Returns the explanation string |
| `healthStatus(score)` | Returns the status phrase |
| `renderSubsystemExplanation(scoped, score)` | Assembles all five sections |
| `renderSubsystemExplanationJson(scoped, score)` | Returns the JSON object |

Primary files to change:

- `ix-cli/src/cli/commands/subsystems.ts`
  Add the new flag, target validation, second score lookup, text rendering, and JSON rendering.
- `ix-cli/src/client/api.ts`
  Likely no required API changes for v1, but tighten typings for `listSubsystems()` and
  `getSubsystemMap()` if the implementation needs stricter data contracts.
- `memory-layer/src/main/scala/ix/memory/api/SubsystemRoutes.scala`
  No new endpoint required for v1. Only change this file if revision metadata is added later.
- `memory-layer/src/main/scala/ix/memory/api/MapEncoder.scala`
  No required change for v1 text mode. Only change this file if scoped JSON needs extra fields
  or if you choose to expose `map_rev`.
- `memory-layer/src/main/scala/ix/memory/subsystem/SubsystemScoringService.scala`
  Only required if you want the stale-health note in v1 by exposing score revision metadata.

### Phase 2 — Optional score metadata

Only needed if stale-health notes are required:

1. Extend stored score payloads to include `map_rev` or score creation revision.
2. Extend `listScores()` so the CLI can compare the score revision to the current scoped region.
3. Add the stale-health note only when the score metadata proves drift.

Suggested file targets:

- `memory-layer/src/main/scala/ix/memory/subsystem/SubsystemScoringService.scala`
- `memory-layer/src/main/scala/ix/memory/api/SubsystemRoutes.scala`
- `ix-cli/src/client/api.ts`
- `ix-cli/src/cli/commands/subsystems.ts`

### Phase 3 — Validation

- Smoke test against two regions: one with a health score, one without.
- Confirm `--format json` produces valid parseable output.
- Confirm `--explain` + ambiguous target shows the error, not a stack trace.
- Confirm `--explain` without a target produces the intended CLI error.
- If stale-health metadata is implemented, verify both fresh and stale note paths.

---

## Large-Repo Ingestion Failures

This is separate from `subsystems --explain`, but it is the other major issue discovered while
reviewing the current architecture and should be fixed in parallel.

### Failure Mode 1 — all parse results are retained in memory before any write

Current behavior:
- `BulkIngestionService.ingestPath()` discovers all files.
- Loads all existing hashes for all files.
- Parses all files with `parTraverseN`.
- Keeps every `Parsed(FileBatch)` in memory.
- Only then starts chunked writes.

That makes the current chunked commit logic too late to protect memory.

Required change:
- Convert ingestion into a bounded pipeline:
  1. discover files
  2. slice into file batches
  3. load hashes for that slice
  4. parse only that slice
  5. commit only that slice
  6. release memory before moving to the next slice

Primary file:
- `memory-layer/src/main/scala/ix/memory/ingestion/BulkIngestionService.scala`

### Failure Mode 2 — source hash lookup is one giant query

Current behavior:
- `getSourceHashes(sourceUris)` is called with the full discovered file list.
- The query scans `patches`, sorts by revision, and groups by URI in one shot.

On large repos, the bind payload and query work both become too large.

Required change:
- Chunk source-hash lookups to the same batch size as ingestion.
- Keep hash lookup local to each parse/commit slice.
- If needed later, add an indexed materialized source-hash table rather than scanning `patches`.

Primary files:
- `memory-layer/src/main/scala/ix/memory/ingestion/BulkIngestionService.scala`
- `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`

### Failure Mode 3 — discovery is broader than parser support

Current behavior:
- File discovery includes many docs, configs, scripts, build files, and other text-like files.
- Parser routing only has dedicated parsers for Python, TypeScript, Scala, config, and Markdown.
- Unsupported files fall back to generic text ingestion.

That means large repos do not just ingest code; they also ingest a wide tail of raw text.

Required change:
- Narrow default discovery to parser-supported file types for normal ingestion.
- Optionally add an explicit `--include-generic-text` or similar opt-in later.
- At minimum, stop treating unsupported text as full-content graph facts by default.

Primary files:
- `memory-layer/src/main/scala/ix/memory/ingestion/FileDiscovery.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/ParserRouter.scala`
- `memory-layer/src/main/scala/ix/memory/api/IngestionRoutes.scala`
- `ix-cli/src/client/api.ts`

### Failure Mode 4 — generic text path stores full content and explodes patch size

Current behavior:
- Generic text fallback stores `"content"` in entity attrs.
- `GraphPatchBuilder` converts attrs into claims.
- Bulk ingestion persists node docs, claim docs, and the full patch document.

This duplicates large text payloads across multiple persisted artifacts.

Required change:
- Remove full raw content from generic-text attrs by default.
- Replace it with compact metadata only:
  - file name
  - line count
  - maybe a short preview
  - content fingerprint / source hash
- Do not emit claims for raw file content.

Primary files:
- `memory-layer/src/main/scala/ix/memory/ingestion/BulkIngestionService.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/IngestionService.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/GraphPatchBuilder.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/ParseResult.scala`

### Failure Mode 5 — chunking is by file count, not payload size

Current behavior:
- Bulk writes use a fixed `chunkSize = 100`.
- A 100-file batch can still serialize into an oversized bulk request.

Required change:
- Chunk by estimated payload size, not just file count.
- Keep a file-count cap as a secondary guardrail.
- Emit progress based on committed slices, not only discovered totals.

Primary files:
- `memory-layer/src/main/scala/ix/memory/ingestion/BulkIngestionService.scala`
- `memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`
- `memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala`

### Recommended ingestion order

1. Refactor bulk ingestion into bounded discovery/hash/parse/commit slices.
2. Chunk `getSourceHashes()` by slice.
3. Remove raw-content attrs and claims from generic text ingestion.
4. Narrow default discovery to parser-supported files.
5. Add payload-size-aware commit chunking.

This order addresses the actual failure mode first: unbounded memory retention.

---

## Constraints

- No new server endpoints.
- No LLM calls — explanations are template-driven, same as `ix explain`.
- `--explain` is ignored when `--list` is also passed (error message).
- `--explain` without a `<target>` is an error: `--explain requires a target.`
- Output is intentionally terse — one screen of text for the full explanation.
- Do not claim stale health in the output unless the score payload actually exposes revision
  metadata that proves staleness.
- Large-repo ingestion fixes should prefer bounded-memory behavior over preserving the current
  exact batching structure.
