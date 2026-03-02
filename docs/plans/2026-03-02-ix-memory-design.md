# Ix Memory Layer — Architecture & Design

## 0. Context and Goals

We are building an **epistemic operating system for LLMs** — a persistent knowledge system where **patch events** (graph mutations) are the source of truth. The system stores a hierarchy of modules, files, and symbols connected by imports, calls, ownership, and dependency relationships, all with time and provenance.

### Core Principles

- **Patch/Event Log = Source of Truth.** Normal databases store whether something exists. Ours stores patches that state who added something, why, what it replaced, and when it happened.
- **The human prompt defines an initial intent hypothesis, and truth emerges as the event log accumulates verified observations aligned with that intent.**
- **Every fact has time (Temporal Truth).** We don't just say if X is true — we say when it was true, when it became true, when it stopped being true.
- **Provenance-first.** Every fact carries full provenance: who asserted it, from what source, using what extractor, when.
- **Computed confidence.** Confidence scores are derived from provenance signals, never manually assigned.
- **Conflict detection.** When two patches disagree, the system surfaces the contradiction — it doesn't silently pick a winner.

### What We're Building (Scope)

| Component | Description |
|---|---|
| **Memory Layer** | The core engine: context assembly, ingestion, confidence scoring, conflict detection, versioning. Scala service with HTTP API. |
| **CLI** | Command-line interface for humans. Thin client calling the Memory Layer API. |
| **MCP Server** | Model Context Protocol server for LLM tool use (Claude Desktop, Cursor, etc.). Thin client calling the Memory Layer API. |
| **SDK** | TypeScript + Python client libraries for developers. Includes prompt builder and BYOK LLM caller. |

### What We're NOT Building (Out of Scope)

- Custom database (no Rust GraphDB / RocksDB work). Using existing ArangoDB.
- Our own API key / authentication system (for now).
- LLM hosting — developers bring their own keys (BYOK).

---

## 1. System Overview

### 1.1 Full Architecture

```
╔═══════════════════════════════════════════════════════════════════════╗
║                        DEVELOPER'S WORLD                              ║
║                                                                       ║
║  Developer's App                                                      ║
║  ├── Uses Ix SDK (@ix/client or ix-python)                           ║
║  ├── Provides their own LLM API key (Claude, OpenAI, etc.)          ║
║  ├── ix.getContext(query) → structured claims (no LLM call)          ║
║  └── ix.query(query) → LLM answer with provenance (uses their key)  ║
║                                                                       ║
╚═══════════════════╤═══════════════════════════════════════════════════╝
                    │
    THREE ENTRY POINTS INTO Ix:
    ┌───────────────┼───────────────────────┐
    │               │                       │
    ▼               ▼                       ▼
┌────────┐   ┌───────────┐   ┌──────────────────┐
│  CLI   │   │ MCP Server│   │ HTTP API (SDK)   │
│(term)  │   │ (stdio)   │   │ (REST)           │
│        │   │           │   │                  │
│ix query│   │ Claude    │   │POST /v1/context  │
│ix ingest   │ Desktop   │   │POST /v1/ingest   │
│ix diff │   │ Cursor    │   │POST /v1/diff     │
│ix hist │   │           │   │GET /v1/entity/:id│
└───┬────┘   └─────┬─────┘   └────────┬─────────┘
    │              │                   │
    └──────────────┼───────────────────┘
                   │
         All three call the same thing:
                   │
                   ▼
┌──────────────────────────────────────────────────────┐
│              MEMORY LAYER (Scala)                     │
│              Port 8090                                │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Service Layer                                   │ │
│  │  ├── ContextService (query pipeline)             │ │
│  │  ├── IngestionService (parse + commit)           │ │
│  │  ├── VersionService (diff, history, staleness)   │ │
│  │  └── ConflictService (detect + resolve)          │ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────▼──────────────────────────┐ │
│  │  Graph Access Layer                              │ │
│  │  (GraphWriteApi + GraphQueryApi traits)           │ │
│  └──────────────────────┬──────────────────────────┘ │
└─────────────────────────┼────────────────────────────┘
                          │
                          ▼
                   ┌──────────────┐
                   │   ArangoDB   │
                   │   (8529)     │
                   └──────────────┘
```

### 1.2 Where the LLM API Key Lives

The LLM API key is **BYOK (Bring Your Own Key)**. It never touches the Ix server.

```
Developer's Machine / App                    Ix Infrastructure
═══════════════════════════                  ═══════════════════

  LLM API Key lives HERE ──┐
                            │           ┌── Ix Memory Layer
  Ix SDK ───────────────────┤           │   (NO LLM key)
    │                       │           │       │
    ├─ getContext() ────────│── HTTP ──│───→    │── queries DB
    │  (no key needed)      │           │       │
    ├─ query() ─────────────┤           │       │
    │  │                    │           │       │
    │  ├─ getContext()──────│── HTTP ──│───→    │── queries DB
    │  │                    │           │       │
    │  └─ call LLM ────────│── HTTPS──│───→ Claude/OpenAI
    │    (key used HERE,    │           │   (LLM provider)
    │     never sent to Ix) │           │
    │                       │           │
    └─ ingest() ────────────│── HTTP ──│───→   │── writes DB
```

### 1.3 Two Integration Patterns

| Interface | Who controls the prompt | Truth enforced? | Use case |
|---|---|---|---|
| **MCP server** | The LLM (Claude Desktop, Cursor) | No — LLM can skip tool calls | Adding memory to existing tools |
| **SDK (BYOK)** | Ix SDK (developer's app) | Yes — SDK injects context before every LLM call | Developers building apps with enforced memory |

---

## 2. Patch / Event Log Model

The event log is the source of truth. Every mutation is a patch with full provenance.

### 2.1 GraphPatch (the atomic unit of truth)

```
{
  patch_id:      "uuid-v7",                    // Unique, idempotency key
  tenant:        "tenant_abc",                 // Isolation
  actor:         "ci/tree-sitter",             // WHO created this patch
  timestamp:     "2026-03-02T...",             // WHEN
  source: {
    uri:         "billing.py",                 // FROM WHAT
    hash:        "a1b2c3",                     // Content hash at time of observation
    extractor:   "tree-sitter-python/1.0",     // HOW it was extracted
    source_type: "code"                        // code|config|doc|inferred|human
  },
  base_rev:      42,                           // Optional: optimistic concurrency
  ops: [                                       // WHAT changed
    UpsertNode(id, kind, attrs),
    UpsertEdge(src, dst, predicate, attrs),
    DeleteNode(id),
    DeleteEdge(id),
    SetAttr(owner_id, key, value),
    DelAttr(owner_id, key),
    AssertClaim(entity_id, statement),
    RetractClaim(claim_id, reason)
  ],
  replaces:      ["patch_id_old"],             // What prior patches this supersedes
  intent:        "Re-parsed billing.py after commit abc123"  // WHY
}
```

### 2.2 Traditional DB vs Ix Event Log

```
Traditional DB:                    Ix Event Log:
═══════════════                    ════════════

retry_count = 3                    Patch #1 (rev 1, 2026-01-15, actor: ci/parser)
                                     "retry_count = 3 observed in billing.py:45"
(that's it.                          source: billing.py, hash: a1b2c3
 who set it? when?
 what was it before?               Patch #2 (rev 7, 2026-02-01, actor: ci/parser)
 why? unknown.)                      "retry_count = 5 observed in README.md:22"
                                     source: README.md, hash: d4e5f6

                                   Patch #3 (rev 12, 2026-02-20, actor: human/riley)
                                     "retry_count = 3 confirmed by developer"
                                     source: manual assertion
```

The graph state at any revision is deterministically derivable from replaying the patch log up to that point.

---

## 3. Data Model (Schema)

### 3.1 Node Types (Kinds)

**Structural Nodes** (from code/AST parsing):

| Kind | Attributes |
|---|---|
| Module | name, path, language |
| File | path, language, hash, size |
| Class | name, file_path, line_start, line_end |
| Function | name, signature, file_path, line_start, line_end |
| Variable | name, type, scope |
| Config | path, format |
| ConfigEntry | key, value, type |
| Service | name, port, protocol |
| Endpoint | method, path, handler |

**Knowledge Nodes** (from docs, comments, LLM extraction):

| Kind | Attributes |
|---|---|
| Claim | statement, status (ACTIVE / STALE / RETRACTED) |
| Decision | title, rationale, alternatives_considered |
| ConflictSet | reason, status (OPEN / RESOLVED / DISMISSED), candidates[] |

### 3.2 Common Node Fields

Every node has:

```
{
  id:          "uuid-v7",
  kind:        "Function",
  tenant:      "tenant_abc",
  attrs:       { ... },                  // Kind-specific attributes
  provenance:  {
    source_uri:   "billing.py",
    source_hash:  "a1b2c3",
    extractor:    "tree-sitter-python/1.0",
    source_type:  "code",
    observed_at:  "2026-03-01T10:00:00Z"
  },
  created_rev: 42,                       // MVCC: when created
  deleted_rev: null,                     // MVCC: when deleted (tombstone)
  created_at:  "2026-03-01T...",
  updated_at:  "2026-03-01T..."
}
```

### 3.3 Edge Types (Predicates)

**Structural Edges** (deterministic, from AST/parsing):

| Predicate | From → To | Meaning |
|---|---|---|
| DEFINES | Module → Class/Function | "module defines function" |
| CONTAINS | File → Class/Function | "file contains class" |
| CALLS | Function → Function | "fn A calls fn B" |
| IMPORTS | File → Module/File | "file imports module" |
| DEPENDS_ON | Service → Service | "svc A depends on svc B" |
| CONFIGURES | ConfigEntry → Service/Fn | "config entry configures svc" |
| EXPOSES | Service → Endpoint | "service exposes endpoint" |
| INHERITS | Class → Class | "class A extends class B" |
| IMPLEMENTS | Class → Interface | "class implements interface" |

**Knowledge Edges** (from LLM or human input):

| Predicate | From → To | Meaning |
|---|---|---|
| HAS_CLAIM | Entity → Claim | "entity has this claim" |
| SUPPORTS | Claim → Claim | "claim A supports claim B" |
| CONTRADICTS | Claim → Claim | "claim A contradicts claim B" |
| DECIDED_BY | Entity → Decision | "design decided by decision" |
| MENTIONED_IN | Entity → File/Doc | "entity mentioned in doc" |
| CHANGED_WITH | Entity → Entity | "these changed together" |
| SAME_AS | Entity → Entity | "identity resolution" |
| IN_CONFLICT | Claim → ConflictSet | "claim is part of conflict" |

### 3.4 Common Edge Fields

```
{
  id:          "uuid or derived from (src, dst, predicate)",
  src:         "node_id",
  dst:         "node_id",
  predicate:   "CALLS",
  tenant:      "tenant_abc",
  attrs:       { weight?, metadata? },
  provenance:  { ... },                  // Same structure as node provenance
  created_rev: 42,
  deleted_rev: null
}
```

### 3.5 MVCC Visibility Rule

An entity is **visible at revision R** iff:

```
created_rev <= R AND (deleted_rev IS NULL OR R < deleted_rev)
```

---

## 4. Confidence Scoring Engine

Confidence is **computed from provenance signals**, never manually assigned.

### 4.1 Formula

```
confidence(claim) = clamp(0, 1,
    base_authority(source_type)
    × verification_multiplier(claim)
    × recency_multiplier(claim, latest_rev)
    × corroboration_multiplier(claim)
    × conflict_penalty(claim)
)
```

### 4.2 Signal Definitions

**Base Authority** (from source type — deterministic):

| Source Type | Base Score | Why |
|---|---|---|
| Passing test | 0.95 | Verified by execution |
| Code (AST-parsed) | 0.90 | The code IS the behavior |
| Config file | 0.85 | Explicitly set values |
| Schema/types | 0.85 | Compiler-enforced contracts |
| Official spec/doc | 0.75 | Human-written, intended truth |
| Commit message | 0.60 | Human intent, sometimes vague |
| PR/issue comment | 0.50 | Discussion, not assertion |
| LLM-inferred | 0.40 | Model guessed, not stated |
| Chat/Slack | 0.35 | Informal, often stale |

**Verification Multiplier:**

| Verification State | Multiplier |
|---|---|
| Test passes that cover this | x 1.1 |
| Human explicitly confirmed | x 1.1 |
| Observed in running system | x 1.05 |
| No verification | x 1.0 |
| Test FAILS that covers this | x 0.3 |
| Human explicitly denied | x 0.1 |

**Recency Multiplier:**

| Age (revisions since observed) | Multiplier |
|---|---|
| 0-5 revisions ago | x 1.0 |
| 6-20 revisions ago | x 0.95 |
| 21-50 revisions ago | x 0.85 |
| 51-200 revisions ago | x 0.70 |
| 200+ revisions ago | x 0.50 |

Exception: if the source file hasn't changed since the observation, recency stays at x 1.0.

**Corroboration Multiplier:**

| Independent sources agreeing | Multiplier |
|---|---|
| 1 source (uncorroborated) | x 1.0 |
| 2 sources agree | x 1.1 |
| 3+ sources agree | x 1.15 |

**Conflict Penalty:**

| Conflict state | Multiplier |
|---|---|
| No conflicts | x 1.0 |
| Conflict exists, this claim has higher authority | x 0.85 |
| Conflict exists, this claim has lower authority | x 0.5 |
| Conflict resolved AGAINST this claim | x 0.1 |
| Conflict resolved FOR this claim | x 1.1 |

### 4.3 Explainability

Every confidence score includes a full breakdown:

```json
{
  "score": 0.925,
  "breakdown": {
    "base_authority":    { "value": 0.90, "reason": "code, AST-parsed" },
    "verification":      { "value": 1.1,  "reason": "covered by passing test" },
    "recency":           { "value": 1.0,  "reason": "source unchanged since observation" },
    "corroboration":     { "value": 1.1,  "reason": "2 independent sources agree" },
    "conflict_penalty":  { "value": 0.85, "reason": "conflict with README (lower authority)" }
  }
}
```

---

## 5. Context Assembly Pipeline

How the Memory Layer turns a question into structured context.

### 5.1 Pipeline Steps

```
Input: "How does billing retry?"

Step 1: Entity Extraction
  ├── Keyword: split + normalize → ["billing", "retry"]
  ├── Synonym expansion: "retry" → ["retry", "retries", "retry_handler"]
  └── Output: search terms

Step 2: Graph Seed Lookup
  ├── Fulltext search on node names + attrs
  ├── Kind index scan for matching kinds
  └── Output: seed node IDs

Step 3: Graph Expansion (1-2 hops)
  ├── Adjacency scan from seed nodes
  ├── Follow: DEFINES, CALLS, IMPORTS, CONFIGURES, HAS_CLAIM
  └── Output: subgraph (nodes + edges)

Step 4: Claim Collection
  ├── Gather all Claims attached to subgraph nodes
  └── Output: claim list with provenance

Step 5: Confidence Scoring
  ├── For each claim: compute confidence from provenance
  ├── Check source staleness, corroboration, conflicts
  └── Output: scored claims with breakdown

Step 6: Conflict Detection
  ├── Find claim pairs that contradict
  └── Output: conflicts list

Step 7: Ranking + Assembly
  ├── Sort claims by confidence descending
  ├── Group by entity for structure
  └── Output: StructuredContext
```

### 5.2 StructuredContext (output format)

```json
{
  "claims": [
    {
      "statement": "The billing service retries 3 times",
      "confidence": { "score": 0.925, "breakdown": { ... } },
      "provenance": {
        "source_uri": "billing.py:45",
        "source_type": "code",
        "extractor": "tree-sitter-python",
        "observed_rev": 43
      },
      "entity_id": "uuid-of-retry-handler"
    }
  ],
  "conflicts": [
    {
      "id": "conflict-uuid",
      "claim_a": { "statement": "retries 3 times", "confidence": 0.925 },
      "claim_b": { "statement": "retries 5 times", "confidence": 0.263 },
      "reason": "contradictory values for retry count",
      "recommendation": "trust code (0.925) over README (0.263)"
    }
  ],
  "graph": {
    "nodes": [ ... ],
    "edges": [ ... ]
  },
  "metadata": {
    "query": "How does billing retry?",
    "seed_entities": ["billing_service", "retry_handler"],
    "hops_expanded": 2,
    "as_of_rev": 48
  }
}
```

---

## 6. Ingestion Pipeline

### 6.1 Parser Routing

| Source | Parser | LLM Needed? |
|---|---|---|
| Code files (.py, .ts, .scala) | AST (tree-sitter) | No |
| Config files (.yaml, .json, .toml) | Schema parser | No |
| Git history | Git log/diff parser | No |
| Markdown/docs | Section parser + optional LLM | Maybe |
| Unstructured text | LLM extraction | Yes (developer's key) |

### 6.2 Ingestion Flow

```
Source file arrives (via CLI, SDK, or MCP)
       │
       ▼
  File discovery (walk directory, filter by language)
       │
       ▼
  Route to parser by file type
  ├── .py → tree-sitter-python (AST, deterministic, free)
  ├── .yaml → YAML schema parser (deterministic, free)
  ├── .md → Markdown section parser (deterministic)
  │         + optional LLM extraction (uses developer's key)
  └── .git → Git log parser (deterministic)
       │
       ▼
  Extract entities + relationships
  ├── Nodes: File, Module, Class, Function, Variable, Config...
  └── Edges: DEFINES, CALLS, IMPORTS, CONFIGURES...
       │
       ▼
  Build GraphPatch
  ├── Assign patch_id (uuid-v7)
  ├── Attach provenance (source_uri, hash, extractor, source_type)
  ├── Set actor (e.g., "ci/tree-sitter-python")
  └── List ops (UpsertNode, UpsertEdge, etc.)
       │
       ▼
  Validate patch
  ├── Schema valid?
  ├── Referential integrity?
  └── Invariant violations?
       │
       ▼
  Commit to DB
  ├── Apply ops atomically
  ├── Increment revision
  ├── Store idempotency key (patch_id → rev)
  └── Return { new_rev, status }
```

---

## 7. CLI

```
ix — the Ix Memory CLI

COMMANDS:

  ix ingest <path> [--language <lang>] [--recursive] [--watch]
      Ingest source files into the graph.

  ix query <question> [--as-of-rev <rev>] [--format json|text]
      Query the graph. Returns structured context with claims,
      confidence, and conflicts.

  ix diff <revA> <revB> [--entity <id>] [--scope <kind>]
      Show what changed between two revisions.

  ix history <entity_id>
      Show the full revision history of an entity.

  ix conflicts [--status open|resolved|all]
      List active conflicts (contradictory claims).

  ix resolve <conflict_id> --winner <claim_id>
      Resolve a conflict by choosing the correct claim.

  ix entity <id> [--as-of-rev <rev>]
      Inspect a single entity: attrs, claims, edges, provenance.

  ix provenance <entity_id>
      Trace the full provenance chain.

  ix status
      Show graph stats: node/edge counts, latest rev, open conflicts.

IMPLEMENTATION:
  - Scala, using decline for command parsing
  - Thin client: every command calls the Memory Layer HTTP API
  - Formats output for terminal (tables, colors, tree views)
  - Config: ~/.ix/config.yaml (endpoint, tenant, LLM key)
```

---

## 8. MCP Server

```
Transport: stdio (for Claude Desktop, Cursor, etc.)

Tools:

  ix_query
    Input:  { question: string, as_of_rev?: number }
    Output: { claims: Claim[], conflicts: Conflict[], graph: SubGraph }

  ix_ingest
    Input:  { path: string, language?: string }
    Output: { patches_applied: number, new_rev: number }

  ix_entity
    Input:  { id: string, as_of_rev?: number }
    Output: { node: Node, claims: Claim[], edges: Edge[], history: PatchRef[] }

  ix_diff
    Input:  { rev_a: number, rev_b: number, scope?: string }
    Output: { added: Entity[], removed: Entity[], changed: Entity[] }

  ix_conflicts
    Input:  { status?: "open" | "resolved" | "all" }
    Output: { conflicts: ConflictSet[] }

  ix_resolve_conflict
    Input:  { conflict_id: string, winner_claim_id: string }
    Output: { resolved: boolean, new_rev: number }

  ix_expand
    Input:  { entity_id: string, direction: "out"|"in"|"both",
              predicates?: string[], hops?: number }
    Output: { nodes: Node[], edges: Edge[] }

IMPLEMENTATION:
  - Scala, MCP stdio protocol
  - Calls same Memory Layer HTTP API as CLI
  - Tool descriptions optimized for LLM comprehension
```

---

## 9. SDK (TypeScript + Python)

### 9.1 TypeScript (@ix/client)

```typescript
import { IxClient } from '@ix/client';

const ix = new IxClient({
  endpoint: 'http://localhost:8090',
  llmProvider: 'anthropic',
  llmApiKey: process.env.ANTHROPIC_KEY,
});

// Ingest code into the graph
await ix.ingest('./src', { language: 'python', recursive: true });

// Get raw structured context (no LLM call)
const ctx = await ix.getContext('How does billing retry?');
// ctx.claims, ctx.conflicts, ctx.graph

// Full query with LLM (uses developer's key client-side)
const answer = await ix.query('How does billing retry?');
// answer.response, answer.sources, answer.confidence

// Time travel
const old = await ix.getContext('...', { asOfRev: 10 });

// Diff
const changes = await ix.diff(10, 43);

// Inspect entity
const entity = await ix.entity('uuid-of-retry-handler');
```

### 9.2 SDK Architecture

```
┌────────────────────────────────────────┐
│  SDK                                    │
│  ├── HttpClient (calls Ix Memory API)  │
│  ├── PromptBuilder (turns Structured   │
│  │   Context into LLM system prompt)   │
│  ├── LlmCaller (calls Claude/OpenAI   │
│  │   using DEVELOPER'S key)            │
│  └── ResponseParser (extracts sources, │
│      confidence from LLM response)     │
└────────────────────────────────────────┘

The LLM API key lives ONLY in the SDK (client-side).
The Ix server never sees it.
```

---

## 10. Repo Structure

```
IX-Memory-Repo/
├── docs/
│   └── plans/
│       └── 2026-03-02-ix-memory-design.md
│
├── memory-layer/                              (Scala, sbt)
│   ├── build.sbt
│   ├── src/main/scala/ix/memory/
│   │   ├── Main.scala
│   │   ├── api/
│   │   │   └── Routes.scala
│   │   ├── context/
│   │   │   ├── ContextService.scala
│   │   │   ├── EntityExtractor.scala
│   │   │   ├── GraphSeeder.scala
│   │   │   ├── GraphExpander.scala
│   │   │   ├── ClaimCollector.scala
│   │   │   ├── ConfidenceScorer.scala
│   │   │   ├── ConflictDetector.scala
│   │   │   └── ContextRanker.scala
│   │   ├── ingestion/
│   │   │   ├── IngestionService.scala
│   │   │   ├── ParserRouter.scala
│   │   │   ├── parsers/
│   │   │   │   ├── TreeSitterParser.scala
│   │   │   │   ├── SchemaParser.scala
│   │   │   │   ├── MarkdownParser.scala
│   │   │   │   └── GitParser.scala
│   │   │   ├── GraphPatchBuilder.scala
│   │   │   └── PatchValidator.scala
│   │   ├── version/
│   │   │   ├── VersionService.scala
│   │   │   ├── DiffEngine.scala
│   │   │   └── StalenessDetector.scala
│   │   ├── conflict/
│   │   │   ├── ConflictService.scala
│   │   │   └── ConflictResolver.scala
│   │   ├── model/
│   │   │   ├── GraphPatch.scala
│   │   │   ├── Node.scala
│   │   │   ├── Edge.scala
│   │   │   ├── Claim.scala
│   │   │   ├── ConflictSet.scala
│   │   │   ├── Provenance.scala
│   │   │   ├── StructuredContext.scala
│   │   │   └── ConfidenceBreakdown.scala
│   │   └── db/
│   │       ├── ArangoClient.scala
│   │       ├── GraphWriteApi.scala
│   │       └── GraphQueryApi.scala
│   └── src/test/scala/ix/memory/
│
├── cli/                                       (Scala, shared sbt build)
│   └── src/main/scala/ix/cli/
│       ├── Main.scala
│       ├── Commands.scala
│       └── Formatter.scala
│
├── mcp-server/                                (Scala, shared sbt build)
│   └── src/main/scala/ix/mcp/
│       ├── Main.scala
│       ├── ToolRegistry.scala
│       └── ToolHandlers.scala
│
├── sdk/
│   ├── typescript/                            (npm: @ix/client)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── prompt-builder.ts
│   │   │   ├── llm-caller.ts
│   │   │   └── types.ts
│   │   └── test/
│   └── python/                                (pip: ix-python)
│       ├── pyproject.toml
│       ├── ix/
│       │   ├── client.py
│       │   ├── prompt_builder.py
│       │   ├── llm_caller.py
│       │   └── types.py
│       └── tests/
│
├── docker-compose.yml                         (ArangoDB + memory-layer)
└── .gitignore
```

---

## 11. Build Phases

### Phase 1: Memory Layer Core (the engine)

- Data model (GraphPatch, Node, Edge, Claim, Provenance)
- ArangoDB integration (reuse/adapt from SD_Query_Engine)
- Ingestion pipeline: tree-sitter Python parser → GraphPatch → DB
- Context pipeline: entity extraction → seed → expand → claims → rank
- Confidence scoring engine (the computed formula)
- Conflict detection
- HTTP API: /v1/context, /v1/ingest, /v1/entity, /v1/diff
- **Deliverable:** working Memory Layer with HTTP API

### Phase 2: CLI + MCP Server (thin clients, can be parallel)

- CLI: all commands calling Memory Layer HTTP API
- MCP Server: all tools calling Memory Layer HTTP API
- **Deliverable:** ix CLI + MCP server for Claude Desktop

### Phase 3: SDK + More Parsers

- TypeScript SDK with prompt builder + BYOK LLM caller
- Python SDK
- Additional parsers: TypeScript, config files, markdown, git
- **Deliverable:** npm/pip packages developers can install

### Phase 4: Advanced Intelligence

- Corroboration counting across sources
- Verification from test results (CI integration)
- Staleness detection (source file changed since observation)
- Working set continuity (session-scoped activation)
- Intent-aware retrieval
- **Deliverable:** the full "epistemic operating system"
