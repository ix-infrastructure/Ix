# ix map Experience Improvements — Full Implementation Spec

---

## TL;DR (Start Here)

**Implement Phase 1 only (CLI renderer rewrite).**

Do:

* Replace flat output with tree layout
* Group modules under subsystems
* Add health summary line
* Preserve JSON output exactly

Do NOT:

* Modify backend
* Change API contracts

Primary file:

* `ix-cli/src/cli/commands/map.ts`

---

## Goals

Improve `ix map` across 3 dimensions:

1. **Clarity** → readable, hierarchical output
2. **Exploration** → drill into subsystems/modules
3. **Performance** → avoid unnecessary recomputation

All changes must be:

* Incremental
* Backwards compatible
* Independently shippable

---

## Current Behavior (Simplified)

Pipeline:

```
ix map
  → ingest
  → POST /v1/map
  → build graph + cluster (Louvain)
  → persist regions
  → return JSON
  → CLI renders flat table
```

---

## Data Model (IMPORTANT)

The CLI receives:

```json
{
  "regions": [
    {
      "id": "r1",
      "label": "Cli / Client",
      "level": 2,
      "parent_id": null,
      "file_count": 105,
      "confidence": 0.72,
      "is_cross_cutting": false
    },
    {
      "id": "r2",
      "label": "Queries",
      "level": 1,
      "parent_id": "r1",
      "file_count": 10,
      "confidence": 0.66,
      "is_cross_cutting": true
    }
  ]
}
```

Levels:

* 3 = System
* 2 = Subsystem
* 1 = Module

---

## Problems

### Output

* Flat structure → no hierarchy
* Hard to answer “what’s inside X?”
* Truncation breaks readability
* Cross-cutting unclear
* Verbose mode overwhelming

### Exploration

* No drill-down
* No file visibility
* No explain integration

### Performance

* Always recomputes map
* Always persists
* Always runs ingest

---

## Target Design

---

## 1. Default Output (Tree Layout)

Replace flat output with:

```
Architectural Map  225 files · 4 subsystems · 14 modules

  Cli / Client  ·  105 files  ·  Moderate (72%)
  ├─  Cli / Client     53 files   Well-defined
  ├─  Cli / Github     22 files   Moderate
  ├─  Queries          10 files   Moderate  ⚠
  ╰─  Role              5 files   Fuzzy     ⚠

  Context  ·  56 files  ·  Moderate (65%)
  ├─  Ingestion    12 files   Well-defined
  ╰─  Model        19 files   Fuzzy
```

---

## 2. Health Summary Line

Add at top:

```
3 well-defined · 8 moderate · 3 fuzzy · 3 cross-cutting
```

---

## 3. Verbose Mode

Keep tree, add right-aligned metrics:

```
Cli / Client  ·  105 files     conf=72%  br=651  xcut=0.03
├─ Queries    10 files         conf=66%  xcut=0.15 ⚠
```

---

## 4. Rendering Algorithm (IMPLEMENT THIS)

```ts
const subsystems = regions.filter(r => r.level === 2);
const modules = regions.filter(r => r.level === 1);

const modulesByParent = groupBy(modules, m => m.parent_id);

for (const subsystem of subsystems) {
  printSubsystem(subsystem);

  const children = modulesByParent[subsystem.id] || [];

  children.forEach((child, i) => {
    const isLast = i === children.length - 1;
    const prefix = isLast ? "╰─" : "├─";
    printModule(child, prefix);
  });
}
```

---

## 5. Rendering Rules

* No label truncation
* Use terminal width (`process.stdout.columns`)
* Indentation = 2 spaces
* Tree chars: `├─`, `╰─`
* Cross-cutting = `⚠`
* Confidence shown as % in headers

---

## 6. Flags (Future Phases)

### `--subsystem <name>`

Show only one subsystem + modules

### `--module <name>`

Show module + files

### `--files`

Expand full file list

### Positional shorthand

```
ix map Ingestion
ix map "Cli / Client"
```

---

## 7. File Listing (Future)

Add to backend:

```json
"member_paths": ["src/cli/map.ts"]
```

Only for level-1 regions.

---

## 8. Explain Integration (Future)

### CLI Prompt Template

```
Explain the following subsystem:

Name: {label}
Files: {file_count}
Confidence: {confidence}
Child modules: {children}

Boundary files:
{top_files}

Smells:
{smells}

Summarize:
1. Purpose
2. Structure quality
3. Risks
```

---

## 9. Performance Plan

### Priority

1. Cache map by graph revision (HIGH)
2. Skip persist if unchanged (HIGH)
3. Skip ingest if fresh (MEDIUM)
4. Optimize parent wiring (LOW)

---

### 9a. Cache Map

If `map_rev == graph_rev` → return stored map

---

### 9b. Skip Persist

```
if storedRev == currentRev:
  skip write
```

---

### 9c. Skip Ingest

If freshness = false → skip ingest

---

## 10. Implementation Phases

---

### Phase 1 — CLI Output (DO THIS FIRST)

Scope:

* Tree rendering
* Health summary
* Verbose redesign

Files:

* `map.ts`

Constraints:

* JSON output unchanged
* No backend changes

---

### Phase 2 — Drill-down

* Add flags
* Add member_paths

---

### Phase 3 — Explain

* CLI context builder
* Call explain endpoint

---

### Phase 4 — Performance

* Cache map
* Skip persist
* Skip ingest

---

### Phase 5 — Future

* Incremental Louvain
* `/map/explain` endpoint
* TUI interface

---

## 11. Acceptance Criteria (Phase 1)

Must pass:

* `ix map` → tree structure
* `ix map --verbose` → tree + metrics
* `ix map --level 3` → systems only
* `ix map --level 1` → modules only
* `ix map --format json` unchanged
* No truncation up to 40 chars
* Health summary present

---

## 12. Risks

| Risk            | Mitigation      |
| --------------- | --------------- |
| Narrow terminal | fallback layout |
| Name ambiguity  | disambiguation  |
| Cache stale     | `--full` flag   |
| Payload size    | level-1 only    |
| Explain quality | improve prompt  |

---

## 13. Key Files

* CLI: `ix-cli/src/cli/commands/map.ts`
* API: `MapRoutes.scala`
* Service: `MapService.scala`
* Graph: `MapGraphBuilder.scala`
* Clustering: `LouvainClustering.scala`

---

## Final Instruction for Implementer

Start with Phase 1.

Do not over-engineer.

Focus on:

* Correct grouping
* Clean tree rendering
* Zero regression in JSON output

Then stop and validate before continuing.
