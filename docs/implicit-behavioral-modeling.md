# Implicit Behavioral Modeling for Ix

Architecture proposal for the public checkout at `38c5dfec`. The first release would answer a narrow question from an ordinary `ix map .` run. **Which literal state writes appear in this symbol, under which source conditions, and what prior state does the code give us reason to infer?**

**Recommendation.** Extract write sites from the existing TypeScript or JavaScript syntax tree. Persist a bounded, versioned attribute on the existing function or method node in its normal file patch. Project a partial state machine from these records when answering `explain`, `impact` and `context`. The storage milestone passed on released memory-layer versions 1.0.35 and 1.0.30. Steps 2–4 below describe the implemented extractor, persistence, and agent-facing projection.

## How Ix works today

| Stage | Path through this checkout |
| --- | --- |
| **Discovery and dispatch** | `runMapCommand` resolves the root, takes a per-workspace single-flight lock and bootstraps local ingestion. It calls `ingestFiles` recursively. Discovery uses Git's tracked and unignored untracked files, or a filesystem walk, with supported extensions and exclusions. A ready remote runner takes a separate path through `runIngestion`. The public repo defines that interface. [map.ts](../ix-cli/src/cli/commands/map.ts#L977) · [file-discovery.ts](../ix-cli/src/cli/file-discovery.ts#L142) · [remote.ts](../ix-cli/src/cli/remote.ts) |
| **Parsing and file IR** | The CLI dynamically loads its sibling `core-ingestion/dist` and sends source and workspace-relative path to a worker. Each worker reuses a parser and cached grammar-specific queries. `parseFile` selects a grammar, parses a tree and partitions query matches. The first pass collects definitions, heritage and type hints. The second handles imports, calls and references. TSX has its own grammar and query cache key. The returned `FileParseResult` contains entities with names, kinds, containers and line ranges, relationships with named endpoints, hashed source chunks, file role and optional resolution or parse-error metadata. Only cloneable data crosses the worker boundary. [loader](../ix-cli/src/cli/commands/ingestion-loader.ts) · [worker](../core-ingestion/src/parse-worker.ts) · [parser and passes](../core-ingestion/src/index.ts#L2842) · [IR types](../core-ingestion/src/index.ts#L187) · [queries](../core-ingestion/src/queries.ts) · [extension map](../core-ingestion/src/languages.ts#L45) |
| **Resolution and identity** | `summarizeParseResult`, `buildGlobalResolutionIndex` and `resolveEdges` use per-file summaries to resolve cross-file endpoints. `buildPatchWithResolution` generates graph ops. A symbol ID is the UUID-shaped first 128 bits of SHA-256 over a workspace namespace, normalized lower-case path and qualified key (`name` or `container.name`). Edge IDs generally use source-file scope, endpoint keys and predicate, with a collision disambiguator where needed. Chunk keys include their start line. In a co-ingest, symbol identity uses the member workspace and member-relative path. Source provenance retains the prefixed workspace-relative URI. [resolution](../core-ingestion/src/index.ts#L4058) · [summary index](../core-ingestion/src/symbol-index.ts) · [identity helpers](../core-ingestion/src/patch-builder.ts#L23) · [qualified keys and node emission](../core-ingestion/src/patch-builder.ts#L386) · [workspace identity](../ix-cli/src/cli/system.ts#L452) |
| **Incremental writes** | A local mtime baseline avoids rereading settled files. For remaining candidates Ix compares SHA-256 of the bytes with `POST /v1/source-hashes`, keyed by workspace and URI. Changed parses are resolved, patched and committed in batches. Saved symbol summaries support re-resolution of affected dependents. Superseded entities are reconciled, deleted files get deletion patches, and retryable or unsettled files retain pending state. Patch IDs incorporate path, source hash and extractor version, with variants for full-mode re-sends and changed resolutions. The recorded extractor can force a resumable rebuild. [ingestion](../ix-cli/src/cli/commands/ingest.ts#L2994) · [hash lookup](../ix-cli/src/cli/commands/ingest.ts#L5701) · [baseline persistence](../ix-cli/src/cli/commands/ingest.ts#L5090) · [stored symbol summaries](../ix-cli/src/cli/ingest-symbols.ts) · [patch identity](../core-ingestion/src/patch-builder.ts#L720) |
| **Map mode** | By default, local map removes `chunk` upserts, edges touching those chunks, and claim assertions/retractions. It retains ordinary symbol upserts and their attributes. `ix map --full` controls the backend's mapping limits. Patch filtering is selected separately. After ingestion the CLI asks `POST /v1/map` for regions and hierarchy, reuses a suitable cached result, or defers region recomputation on eligible automatic maps. Behavioral extraction belongs before patch commit, so an edit can change a write even when the architecture hierarchy is reused. [map-mode selection](../ix-cli/src/cli/commands/map.ts#L122) · [op filter and mode IDs](../ix-cli/src/cli/commands/ingest.ts#L297) · [map request and cache](../ix-cli/src/cli/commands/map.ts#L1155) |

### Storage and backend ownership

The public repository owns extraction, patch construction, the HTTP client, CLI rendering and MCP. The separately released `ix-memory-layer` owns storage in ArangoDB, patch application, revisions, graph expansion and region computation. Commands obtain an `IxClient` through the factory, which applies endpoint, authentication, deadlines and request controls. The CLI writes JSON patches through `POST /v1/patches/bulk` and `POST /v1/patch`, with batching, payload splitting and commit-outcome handling in ingestion. [Deployment](../docker-compose.standalone.yml#L70) · [client factory](../ix-cli/src/client/factory.ts) · [HTTP client](../ix-cli/src/client/api.ts#L530) · [bulk splitting](../ix-cli/src/cli/commands/ingest.ts#L1374)

A patch carries `patchId`, actor, timestamp, source provenance, base revision, ops and `replaces`. The public writer enumerates node kinds and eight predicates, including `CONTAINS`, `CALLS`, `IMPORTS`, `EXTENDS` and `REFERENCES`. It models node/edge upsert and delete, and claim assert/retract. Node and edge attributes are open JSON maps. Existing writers use symbol attributes for bounded `unresolved_calls` and edge attributes for resolution tier and confidence. Read-side nodes include provenance and revision metadata. An entity read can include claims and edges. Expand returns nodes and edges. Structured context can include claims, conflicts, decisions, intents, full nodes/edges or compact summaries. Search, entity, expand, provenance, patch history, diff and context routes are documented. The public API specifies neither behavioral traversal nor a behavior capability. The OSS graph schema and its CLI copy are byte-identical by test. [Writer schema](../core-ingestion/src/schema.ts) · [schema mirror](../ix-cli/src/client/graph-schema.ts) · [read models](../ix-cli/src/client/types.ts#L85) · [HTTP specification](api/openapi.yaml) · [release-dependent features](../ix-cli/src/client/features.ts)

### How the answers reach agents

| Reader | Current behavior and proposed integration |
| --- | --- |
| `ix explain` | Resolves the target, reads its entity, predicate-filtered neighborhoods and provenance, and derives role and importance. JSON includes the facts. Text and `llm` have explicit renderers. Decode the attribute once beside `unresolvedCallsOf` in `collectFacts`. Render a write, its guard and both citations. Cover the separate `--raw` projection too. [command](../ix-cli/src/cli/commands/explain.ts#L36) · [fact collection](../ix-cli/src/cli/explain/facts.ts#L543) · [LLM renderer](../ix-cli/src/cli/explain/llm.ts) |
| `ix impact` | Container analysis expands containment, importers, callers and references, then samples member callers. Leaf analysis expands inbound/outbound calls and references. Both use hierarchy and attached decisions, tasks and bugs. Today's `behaviorAtRisk` is generated from structural and naming heuristics. Add a separately attributed source-evidence section for the target or its directly returned members. The resolved target descriptor lacks attrs. For a leaf, budget at most one full target entity read when needed. For a class, use member nodes from the existing containment response where they carry full attrs. Report partial coverage on a cut. Transition candidates contribute no weight to propagation counts or risk levels. [dispatch](../ix-cli/src/cli/commands/impact.ts#L42) · [containers](../ix-cli/src/cli/commands/impact.ts#L367) · [leaves](../ix-cli/src/cli/commands/impact.ts#L714) · [risk semantics](../ix-cli/src/cli/impact/risk-semantics.ts) |
| `ix context` and MCP | Targeted context combines shared facts with an ID-seeded `POST /v1/context`, ranks evidence, then enforces output budgets. Add a ranked behavioral evidence row with the owner ID, projected transition, write and guard citations. Include optional typed detail in the bundle schema or saved bundles will strip it. For `--as-of-rev`, use only full attrs and provenance from the requested revision, or omit the row when unavailable. The parallel ordinary entity read represents the head. MCP runs CLI handlers in process over stdio, normally returning bounded `--format llm` records. `ix_context` also offers `structured: true`. The default catalog includes `ix_context` and `ix_impact`. `ix_explain` is in the full catalog. Use these existing routes into the product. [context command](../ix-cli/src/cli/commands/context.ts#L230) · [context read](../ix-cli/src/client/api.ts#L216) · [ranking](../ix-cli/src/cli/context/rank.ts) · [budgets](../ix-cli/src/cli/context/bundle.ts#L348) · [bundle schema](../ix-cli/src/cli/context-bundle-schema.ts#L142) · [MCP catalog](../ix-cli/src/mcp/server.ts#L261) · [runner](../ix-cli/src/mcp/runner.ts#L579) |

## MVP extraction rules

For example, consider a named instance method in `src/job.ts`.

```ts
class Job {
  start() {
    if (this.status === "queued") {
      this.status = "running"
    }
  }
}
```

Two source facts are available. Line 4 contains a literal assignment to `this.status`. Line 3 is the condition whose true arm contains that assignment. The partial machine for `Job`'s instance field `status` can show **`queued → running`, candidate, via `Job.start`**, with both lines as evidence. A write under `if (authorized)` gives **`unknown → running` under `authorized`**. The same applies to the prior state of an unguarded write. Here `unknown` means the extractor has no source value to show. It contributes no state node or wildcard transition.

1. **Select a slot and owner.** Start with plain `=` statements assigning a short string literal to `this.state`, `this.status` or `this.phase` in a named, uniquely mapped class instance method, or to a same-named, uniquely bound `let` in a named callable's own body. This initial vocabulary is a precision decision. Keep field identity per class and local identity per declaration's callable. Skip shadowed or multiply declared local names, captured outer bindings, static methods and ambiguous symbol keys. The existing extension registry covers TS, TSX, JS, JSX, MJS and CJS. Declaration files have no executable bodies.
2. **Capture lexical control.** Walk the existing tree with an owner stack and an ordered stack of enclosing `if` arms. Track whether the assignment is in the consequence or alternative by AST field. Preserve each condition's span and polarity, including the outer false arm of `else if`. Start fresh at callable/class boundaries. Limit v1 to statement blocks and `if` control paths. Skip sites inside loops, switches, try/catch/finally, conditional or short-circuit expressions and unsupported execution contexts. A preceding early return can constrain later code. An empty guard list means “no enclosing supported `if`”, never “always executes”.
3. **Infer sparingly.** A same-slot strict string equality in the true arm can suggest a prior value when the assignment is the first executable statement of that arm. Allow parentheses and braces. Record an enclosing guard even if a call, another write or an `await` intervenes, but leave the prior state unknown. Treat other predicates as evidence of a controlling expression with a source span. A false arm does not identify a unique prior value. Preserve conditionality for every write. An assignment can throw or invoke a setter. The projection expresses a possible transition if executed.
4. **Bound the pass.** Add a JS/TS helper called from `parseFile` while definition captures and the tree are available. Match the exact enclosing definition by syntax-node identity/span before attaching the qualified key. Existing relationship attribution has line-based helpers and the patch builder deduplicates symbol keys. A single source line can contain several methods. Skip ambiguous owners. Visit each syntax node at most a bounded number of times and avoid copying unbounded ancestor lists. Use deterministic visit, depth, record and encoded-byte caps, shared across a file, with partial-coverage metadata. Respect the existing parse budget. An optional analysis that exhausts its own allowance must still allow structural output. For a recovered syntax tree, the simplest v1 rule is to suppress behavioral extraction for the file and use its existing parse-error diagnostic. [Definition capture](../core-ingestion/src/index.ts#L3067) · [parse budget](../core-ingestion/src/index.ts#L2819) · [existing line lookup](../core-ingestion/src/index.ts#L6501)

Computed properties, arbitrary receivers, enum resolution, aliases, setters as calls, inferred call effects, entry/exit contracts and invariants are outside this extractor. In particular, a branch guard is evidence about a write site. Turning it into a required precondition of the enclosing method would be a different inference.

Ix itself provides a useful negative fixture. `createDrainGate` represents an open/closed gate with a boolean captured by methods on a returned object. The source describes the behavior clearly, but v1 lacks evidence under its supported binding and literal rules. It should produce no machine for this function. [createDrainGate](../ix-cli/src/cli/commit-breaker.ts#L417)

## Proposed data model

One optional `behavior` member on `FileParseResult` carries plain records in the worker's result. Each entry has an owner qualified key and the slot's declaring key. The patch builder binds both through the same workspace and member-relative identity context it already uses. Store a single versioned `attrs.behavior_v1` envelope per emitting symbol. Source URI, SHA-256 of mapped bytes and extractor come from that node's patch provenance. Join them to every citation exposed outside the node. An evidence span uses 1-based lines and 0-based UTF-16 columns with an exclusive end, measured in the original decoded source. Test these coordinates against actual source slices.

| Field | Meaning |
| --- | --- |
| `coverage`, `cutReason?` | `complete` for the v1 rules on this owner, or `partial` with the bound reached. Missing, unrecognized or malformed attrs convey unavailable evidence. A consumer must not turn absence into a negative behavioral claim. |
| `writes[].id`, `slotId`, `slotKind`, `slotName` | Stable write-site and candidate-machine IDs, plus a readable target such as instance field `status`. The enclosing graph node supplies the writing callable's ID. |
| `writes[].observed` | `{ to: { kind: "string", value }, assignment: Span, guards: Guard[] }`. A guard carries its span, its arm (`then` or `else`) and a canonical condition key. Simple predicates can carry display operands. For a complex condition retain a token fingerprint and location. Guard order is outermost first. |
| `writes[].inferred` | Tagged union `{ from: "unknown" }` or `{ from: { kind: "string", value }, basis: "direct-same-slot-equality", guardIndex }`. A known candidate source always cites the observed guard. Extraction and inference carry different semantics from the backend's claim-confidence and relevance scores. |

**Identity construction.** Hash canonical, length-delimited tuples (a canonical JSON array suffices). `slotId = H("ix-slot/1", declaringNodeId, slotKind, slotName)`. For an instance field the declaring node is the existing class, so two methods can contribute to one machine. For an accepted local it is the existing callable, with one qualifying declaration of that name. `writeId = H("ix-write/1", writingNodeId, slotId, typedTargetLiteral, orderedConditionKeysAndArms, duplicateOrdinal)`. Canonicalize syntax tokens, quoting and insignificant trivia while retaining identifiers, operators and values. The ordinal is source order **only among identical fingerprints**. Line shifts and edits to unrelated sites retain identity. Inserting an indistinguishable duplicate can renumber that duplicate group. A file or symbol rename follows existing Ix identity rules. The source hash and positions identify evidence at one revision and do not enter either ID.

The `Job.start` example would persist the following write. IDs are abbreviated for readability. Span tuples are `[startLine, startColumn, endLine, endColumn]`.

```json
{
  "id": "<write-id>",
  "slotId": "<Job instance status slot-id>",
  "slotKind": "instanceField",
  "slotName": "status",
  "observed": {
    "to": { "kind": "string", "value": "running" },
    "assignment": [4, 6, 4, 29],
    "guards": [{
      "conditionKey": ["strictEqual", "this.status", ["string", "queued"]],
      "arm": "then",
      "span": [3, 8, 3, 32]
    }]
  },
  "inferred": {
    "from": { "kind": "string", "value": "queued" },
    "basis": "direct-same-slot-equality",
    "guardIndex": 0
  }
}
```

**Machine projection.** Group writes by `slotId` and collect distinct observed destinations and guard-supported candidate sources. Emit each arc with `from`, `to`, ordered guards, writing symbol ID and supporting write IDs. A site-level transition uses the write ID. A callable view includes its own writes. A class view can combine evidence from its returned methods through existing `CONTAINS` relationships. Report partial coverage when a member/page limit cuts the view or a member's attributes are unavailable. Resolve a member by its existing ID to inspect its sites. Start states, terminal states and reachability remain open questions in this partial machine.

## Persistence choices and failure modes

| Choice | Benefit | Cost or constraint |
| --- | --- | --- |
| **Symbol attributes in the existing file patch** | Same symbol, source hash, commit and deletion lifecycle. Survives map's filter. Full entity reads already carry attrs. Both tested releases preserved and replaced the nested value. | Adds bytes to node reads. Indexed search by state would need a separate contract. |
| Claims on the writing symbol | Existing provenance and claim retrieval. | Ordinary map strips claims. Changing that filter affects write volume and conflict semantics. Different branch destinations are both valid and should not look like conflicting truth. |
| Dedicated machine/state/transition nodes and predicates | Native traversal and repository-wide queries by state. | Needs coordination on graph vocabulary, historical writes, deletion, region analysis, rankings and read contracts in the separate backend. |
| CLI-local file keyed by workspace and source hash | Feasible for an extractor experiment. | Introduces a second persistence lifecycle with invalidation, reset, revision and cross-client consistency work. A remote agent reading the graph would lack the data. |

## Step 1 wire-contract results

**Use full symbol upserts.** Send the ordinary symbol attributes and the entire `behavior_v1` envelope when there is evidence. When the last write disappears or the owner loses eligibility, send the ordinary attributes and omit `behavior_v1`. On both releases omission removed the key, the symbol kept its ID, and the supplied ordinary attributes remained intact. An explicit `{ "coverage": "complete", "writes": [] }` also persisted exactly, including the empty array. Reserve that value for a future reader that specifically needs to distinguish an analyzed-empty owner from unavailable evidence. A writer that omits this field, including an older writer using the ordinary upsert shape, can clear newer evidence when it supersedes the symbol.

On November 18, 2026, the suite ran against two disposable Compose projects. Each used its own ArangoDB volume. `/v1/health` identified the two backend releases and reported schema version 3 on both. Every case reset its database and wrote synthetic source patches through the production HTTP client. Replacement/removal cases read back the populated symbol before the edit, then asserted the updated source hash and unrelated attributes as well as the evidence. [Integration tests](../ix-cli/test/e2e/behavior-attributes.e2e.ts) · [Isolated harness](../ix-cli/test/e2e/harness.ts)

| Operation | 1.0.35 | 1.0.30 |
| --- | --- | --- |
| Single and bulk upsert of function and method, exact nested entity readback | Pass | Pass |
| Two different files in one bulk request, each symbol retains its own evidence | Pass | Pass |
| Replace two guarded writes with one new write on the same method | Pass | Pass |
| Final write removed, omit the key | Pass, key absent | Pass, key absent |
| Final write removed, explicitly send empty envelope | Pass, envelope retained | Pass, envelope retained |
| Instance method becomes an abstract signature, omit the key | Pass, key absent | Pass, key absent |
| Same loss of eligibility, explicitly send empty envelope | Pass, envelope retained | Pass, envelope retained |
| Replay identical patch, same head revision and exact evidence | Pass | Pass |
| Delete live symbol | Pass, single and bulk delete | Pass, single delete after either upsert route |
| Retrieve both committed evidence versions after update and again in a separate case after deletion | Pass | Pass |
| Compact context identifies the target, full context returns exact live evidence | Pass | Pass |
| **Passed / failed assertions / infrastructure-blocked cases** | **25 / 0 / 0** | **25 / 0 / 0** |

Deletion follows the existing 1.0.32 bulk-delete gate. On 1.0.30 both writers were exercised and deletion used `POST /v1/patch`. The identity check used `GET /v1/entity/{id}` at head. Historical checks sent the actual commit revisions to ID-seeded `POST /v1/context` with `depth: "full"` and verified the response revision, source hash and evidence. These are wire-level results. The eventual TypeScript demonstration will run `ix map .` once, then retrieve the discovered transition and both source citations through the MCP tool `ix_context`. [Release gate](../ix-cli/src/client/features.ts#L40) · [Context client](../ix-cli/src/client/api.ts#L218)

To reproduce from the repository root with Docker running, use dedicated ports and project names. Each invocation removes its disposable stack and volume after the suite.

```sh
cd ix-cli
npm ci
npm run build

check_release() (
  set -eu
  export IX_E2E=1 IX_E2E_PROJECT="ix-behavior-step1-$1"
  export IX_E2E_BACKEND_PORT="$2" IX_E2E_ARANGO_PORT="$3" IX_E2E_BACKEND_IMAGE="$4"
  export IX_E2E_ENDPOINT="http://127.0.0.1:$2" IX_E2E_ARANGO_URL="http://127.0.0.1:$3"
  npm run e2e:up
  trap 'npm run e2e:down' EXIT
  curl -fsS "$IX_E2E_ENDPOINT/v1/health"
  ./node_modules/.bin/vitest run --config vitest.e2e.config.ts test/e2e/behavior-attributes.e2e.ts
)

check_release 35 8293 8733 ''
check_release 30 8294 8734 'ghcr.io/ix-infrastructure/ix-memory-layer:1.0.30'
```

## Step 2 parser evidence

`parseFile` retains the structural query's accepted name and definition nodes for candidate JS/TS source. A file-text check can rule out literal assignments cheaply. Only the syntax tree can establish a write. The extractor checks each qualified key against all emitted entity kinds. Overlapping captures of the same exported arrow share a name node and count once. Two distinct declarations claiming one key disqualify that key. For a method, the exact enclosing class declaration must also match the graph container. This matters when the structural parser attributes adjacent one-line classes by their line ranges. [Parser](../core-ingestion/src/index.ts) · [Extractor and IR](../core-ingestion/src/behavior.ts)

The in-memory result is an optional `FileParseResult.behavior` with file-level `coverage` and source-ordered `writes`. Each write carries the callable's `ownerKey`, the slot's `declaringKey`, slot kind and name, duplicate ordinal, observations and inferred prior. Workers transfer plain records. `bindBehaviorIds(write, nodeId)` binds these records to workspace-scoped IDs using the existing symbol-key resolver and member-relative path. This defers the one input the parser does not possess. Tests compare ordinary patch operations and resolution summaries from the same parse with and without evidence. [Identity helper](../core-ingestion/src/patch-builder.ts#L87) · [Tests](../core-ingestion/src/__tests__/behavior.test.ts)

| Example inside an eligible callable | Evidence |
| --- | --- |
| `if (this.status === "queued") this.status = "running"` | Observed write and true arm. Candidate prior `queued` cites that guard. |
| `if (ready) this.status = "running"` | Observed write and true arm. Prior unknown. |
| `if (this.phase === "idle") { await notify(); this.phase = "busy" }` | Observed write, condition and true arm. The intervening statement leaves the prior unknown. |
| `if (state === "a") {} else if (ok) state = "c"` following a unique direct-body `let state` | Observed local write under the outer false and inner true arms. Prior unknown. |
| `while (ready) this.state = "busy"`, `other.status = "done"`, or a write to a shadowed `let state` | Outside the supported control, receiver or binding rules. |

Guards carry the exact expression text and UTF-16 span, outermost first. `sameSlot` reports a recognized syntactic match (`true`), a different simple operand (`false`), or an unresolved expression (`null`). Only strict equality with a short string literal on either side can supply a candidate prior. The site must be the first executable statement of its innermost true arm, allowing braces, comments and empty statements. Each candidate cites its observed guard index. No control-flow claim follows from an empty guard list.

**Coverage and cost bounds.** The file allowance is 32,768 units of syntax and ownership work, a traversal depth of 48, 256 writes and 192 KiB of UTF-8 JSON for the write array. Child-array materialization consumes work units. A controlling expression is limited to 1,024 UTF-16 units and a quoted literal to 128 units between its delimiters. The pass also observes the structural parser's remaining wall-clock deadline. A cut returns verified writes, `coverage: "partial"` and the reason. The uniqueness and local-binding scans must finish before dependent writes can be emitted. Recovered files retain their structural parse-error diagnostic. A clean file with zero supported writes omits the optional result. A future writer must propagate file-level partial coverage to any projections it publishes.

**Precision boundary.** The implemented owners are top-level named functions and function-valued variable declarations captured by Ix, plus ordinary instance methods of a named top-level class declaration. Local slots require one direct-body `let` whose declaration precedes the assignment. The scan conservatively rejects potential rebinding, including destructuring and shadowing in an unsupported control path. Accessors, generators, field-initializer functions, class expressions, computed members, alias receivers, nested callables and complex control flow remain outside the supported set. Opaque predicates retain a token fingerprint. Unsupported literal escape forms yield no candidate literal. [Labeled cases](../core-ingestion/src/__tests__/fixtures/behavior-cases.ts)

### Fixture results

| Measure | Result |
| --- | --- |
| Write precision and recall within the labeled rules | 17 true positives, 0 false positives, 0 false negatives. Precision 17/17 and recall 17/17. |
| Unsupported and ambiguous cases | All 40 rejection fixtures emitted zero records. |
| Guard attribution | All 19 labeled arms had the expected expression, polarity, order and same-slot classification. All 17 sites had the exact expected guard list, including both unguarded sites. |
| Prior-state inference | 3/3 candidate values correct with a matching cited equality. All 14 unknowns remained unknown. |

The table counts distinct source cases. All 17 positive sites were checked in each of TS, TSX, JS and JSX (68 write detections, 76 guard arms). The 40 negatives ran in both TypeScript grammars and the 39 valid JavaScript negatives ran in both JavaScript dialects (158 rejection checks). Repository-wide recall for implicit state machines remains unmeasured. Separate tests cover the four main grammars and MJS/CJS, CRLF, astral Unicode, exact citations, repeated parsing, line shifts, equivalent quoting, duplicate fingerprints, distinct owners, worker serialization and partial results. Broader hand-labeling across real projects would give the next review a better basis for extending eligibility. Class-field arrows and nested bindings would each require their own ownership tests.

Both builds, CLI type checking, a strict type check of the extractor and performance tests, and parser smoke passed. The full core suite passed 1,106 tests with one skip, including all 198 tests in the behavioral suite. A built parse worker returned the same `Job.start` evidence as an in-process parse and both qualified keys resolved to actual nodes in the ordinary structural patch.

The full CLI unit run on Node 26.12.0 reported 5,301 passes, one expected failure, three skips and two failures. The agent-evaluation subprocess exceeded its 120-second deadline and passed when rerun alone on the workspace's default Node 24.11.0. The outstanding caller-output snapshot expects `site=src/app.ts:4` and receives `site=4`. It predates Step 2. [CLI snapshot](../ix-cli/src/cli/__tests__/plugin-output-2.test.ts#L130)

### Parsing performance

Local measurements compare the parser at `38c5dfec` with the Step 2 build on macOS arm64, Node 26.12.0 and the same installed grammars. Times are median elapsed milliseconds for `parseFile`, with sources already in memory and `budgetMs: 0`. Four fresh processes ran in baseline, Step 2, Step 2, baseline order. Each warmed each workload five times. Each build contributed 50 timed samples per single file and 10 per 32-file batch.

| Workload | Before | Step 2 | Change | Evidence |
| --- | ---: | ---: | ---: | --- |
| 1,000 `work();` calls, no state slot, 8,025 bytes | 12.08 ms | 14.93 ms | +23.6% | Absent |
| 100 guarded writes, 5,925 bytes | 6.66 ms | 7.81 ms | +17.2% | 100 writes, complete |
| 1,000 guarded writes, 59,025 bytes | 44.50 ms | 54.20 ms | +21.8% | 256 writes, partial at record cap |
| Real `ix-cli/src/cli/commit-breaker.ts`, 29,320 bytes | 4.22 ms | 6.50 ms | +54.2% | Absent |
| 32 CLI TypeScript files, 342,183 bytes total | 303.74 ms | 343.57 ms | +13.1% | Zero writes |

The synthetic inputs join four framing lines (`class Job {`, `start() {`, `}`, `}`) and one line per statement with LF. The write statement is `if (this.status === "queued") { this.status = "running"; }`. The real batch samples the sorted production `.ts` paths under `ix-cli/src` at indices `floor(i * N / 32)` for `i = 0…31`, excluding test directories and declaration files. An additional alternating, same-process comparison checked structural equality on every input. It measured −6.1% on the no-slot file and +50.4% on `commit-breaker.ts`, with +3.5% on the 32-file batch. Absolute timings varied between runs even on files where the text filter rejected extraction. These measurements cover total parsing time. Attributing the no-evidence overhead to a specific operation requires profiling. A controlled parse-pool benchmark on a larger, labeled production corpus is the recommended next performance check. [Regression workloads](../core-ingestion/src/__tests__/parseFile.perf.test.ts)

## Implementation sequence and acceptance tests

| Step | Work and acceptance criteria |
| --- | --- |
| **1. Verify the wire contract — complete** | The suite and compatibility matrix above establish replacement and removal for the harness-pinned release and the supported floor. [E2E harness](../ix-cli/test/e2e/README.md) · [image pin](../ix-cli/test/e2e/compose.e2e.yml#L53) · [client feature floor](../ix-cli/src/client/features.ts#L37) |
| **2. Build and test the pure extractor — approved** | Add TS and JS fixtures for the example, an unguarded write, nested and negative branches, unrelated guards, names shadowed by parameters/blocks, deferred closures, an intervening call/write/await, duplicate sites, overloads, adjacent one-line methods, different classes sharing a field, local string writes, TSX/JSX and malformed source. Include computed keys and dynamic RHS as negatives. Check Unicode before a site, CRLF, precise spans, repeated runs and line-shift identity. Reuse grammar tests, parser snapshots and the mini-repo. [TS](../core-ingestion/src/__tests__/queries.typescript.test.ts) · [JS](../core-ingestion/src/__tests__/queries.javascript.test.ts) · [parser snapshots](../core-ingestion/src/__tests__/parseFile.test.ts) · [fixtures](../core-ingestion/test-fixtures/mini-repo/src/Bar.ts) |
| **3. Attach attributes and migrate — implemented for review** | Extend canonical `SymbolNodeAttrs` and its CLI mirror. Emit through the existing node builder in map and full modes. Keep site data out of the global resolution summary. Bump the current `tree-sitter/1.30` extractor and add it to `PREVIOUS_EXTRACTORS` so a normal map upgrades existing baselines. Test a scoped run followed by full map and interrupted rebuild/resume. Also cover an empty local baseline against an already populated backend. `extractorChanged(null, …)` is false and `source-hashes` returns bytes' hashes without extractor versions. In that case force the in-scope supported JS/TS candidates through the existing re-ingest path once before recording the new baseline. [patch goldens](../core-ingestion/src/__tests__/patchBuilder.golden.test.ts) · [schema parity](../ix-cli/src/client/__tests__/graph-schema.test.ts) · [extractor baseline](../ix-cli/src/cli/ingest-baseline.ts#L207) · [version-bump precedent](../ix-cli/src/cli/__tests__/ingest-receiver-extractor-bump.test.ts) · [mode filter](../ix-cli/src/cli/__tests__/ingest-map-mode-ops.test.ts) |
| **4. Expose the projection** | Add one tolerant attribute decoder and use it from the readers above. Give output fields optional types. Quote guard and write locations in records and text. Verify saved/resumed bundles, old bundles, bounded output, stale files, `--as-of-rev`, `impact --all`, default MCP context/impact and full-catalog explain. With missing/unknown attrs, existing read commands must still succeed. [explain pipeline](../ix-cli/src/cli/__tests__/explain-pipeline.test.ts) · [impact schema](../ix-cli/src/cli/__tests__/impact-schema.test.ts) · [context budgets](../ix-cli/src/cli/__tests__/context-token-budget.test.ts) · [MCP structured output](../ix-cli/src/cli/__tests__/mcp-structured-output.test.ts) |
| **5. Establish equivalence and cost** | Map twice, edit only a guard, remove the final write, delete/restore a file, rename, revert A → B → A, compare fresh vs incremental, and compare solo vs co-ingest IDs. Include map → full ingest → map and partial commit/retry. Keep the existing structural signature and add a behavioral comparison via entity reads. The E2E signature currently selects topology and line ranges, so silent attribute loss would pass. Use the parser growth test with many writes/deep branches, the 5,000-file ingest test for wall time/RSS/requests, and perf-gate's fresh/no-op/one-line TS edit and read budgets. Measure serialized patch **request** bytes separately from its response-byte metric. Require zero extra requests on steady-state no-op maps, bounded payloads and evidence rows, and no changes in structural signatures or risk scores attributable to behavioral records. [fixture scenarios](../ix-cli/test/e2e/scenarios.e2e.ts) · [signature query](../ix-cli/test/e2e/graph-sig.mjs#L29) · [mode identity tests](../ix-cli/src/cli/__tests__/ingest-map-full-identity.test.ts) · [parser growth](../core-ingestion/src/__tests__/parseFile.perf.test.ts) · [ingest scale](../ix-cli/src/cli/__tests__/ingest-scale.slow.test.ts) · [perf gate](../ix-cli/scripts/perf-gate.mjs) · [budgets](../ix-cli/test/perf/budgets.json) |

The main precision risk is presenting a guarded assignment as a runtime guarantee. Keeping observations and candidate source states separate lets an agent inspect exactly what supports an arc. The main rollout risks are stale attrs on long-lived symbols, the one-time cost of an extractor rebuild across languages, and increased payloads on graph reads. The public change reaches local OSS ingestion. The cloud runner's maintainers would need to confirm equivalent emission before advertising cloud coverage.

The wire tests used this checkout's client and the released backend images. Step 2 measures fixture accuracy and parsing time. End-to-end map, persistence, retrieval and their costs belong to the later milestones.

## Step 3 implementation and rollout

Local `ix map .` and full source ingest both build behavioral attributes in the ordinary per-file patch under `tree-sitter/1.31`. Only a function or method with at least one verified assignment receives an envelope. Its enclosing node provides the writing callable, source URI, content hash and extractor revision. The declaring class or callable's graph ID supplies the slot namespace, including the member-relative path during co-ingest. The map-mode filter retains those symbol upserts. A replacement upsert carries all current ordinary attributes and the complete new envelope. Omitting the key retires previous evidence. [Patch builder](../core-ingestion/src/patch-builder.ts) · [Canonical wire types](../core-ingestion/src/schema.ts)

The body filter uses the same conservative assignment candidate expression as the file filter. The first candidate offset can exclude earlier bodies. For a later body, the extractor checks that body's source before walking its AST. The global ownership check still sees every definition, including ambiguous duplicates. Each published envelope inherits the file's coverage and cut reason. A cut before any verified write leaves the optional attribute absent. Such absence carries no conclusion about runtime behavior. [Extractor](../core-ingestion/src/behavior.ts) · [Bounds and structural equivalence tests](../core-ingestion/src/__tests__/behavior.test.ts)

### Upgrade and recovery

A previous extractor marker triggers the existing workspace rebuild. A checkout with no local baseline asks the existing source-hash service which files the backend holds and re-extracts its supported TS/JS paths even when bytes match. A scoped or language-filtered pass cannot certify the whole workspace. A full rebuild collects each confirmed file's path and mtime and periodically writes an atomic checkpoint. A process killed between checkpoints can repeat recent uploads. The next process checks the recorded mtimes and reprocesses any checkpointed file edited in the meantime. A missing checkpoint can cost another upload. Progress is cleared only after the final baseline has been atomically replaced. Outstanding uploads, failed reads or commits, deferred deletions and structural parse failures withhold the new marker. Existing exclusions for generated/minified, oversized and empty input still apply. [Ingest](../ix-cli/src/cli/commands/ingest.ts) · [Baseline and checkpoints](../ix-cli/src/cli/ingest-baseline.ts)

A previously seen patch ID can describe history. On a qualifying replay, the writer reads the live file and callable nodes and compares identity, source hash, URI, extractor, and the entire behavioral value, including omission. When the backend still exposes obsolete data, the writer may resubmit the same operations once under a distinct patch ID derived from the original ID and the observed backend revision. It verifies that repair against live nodes before checkpointing. An inconclusive read leaves the file eligible for retry. Delete-bearing patches still take the existing single-write path below the 1.0.32 bulk-delete gate. Steady-state maps do not perform this verification.

**Workspace writer policy.** Before enabling a workspace, inventory every process that can write its source nodes, including developer installations, watchers, automation and cloud runners. Upgrade or stop all writers that omit behavioral envelopes before mapping that workspace. Readers can keep using their existing interfaces. Both tested releases accept a legacy full symbol upsert and remove the current behavioral attribute. A current, mtime-clean checkout can then report an ordinary no-op. There is no backend writer fence or automatic detection of remote erasure on that path. After quiescing incompatible writers, an upgraded checkout with a legacy or missing baseline backfills on its next full map. For an already-current checkout use `ix ingest . --force` from the workspace root. The recovery tests read back the live result. A rollback to older writers also requires scheduling a subsequent backfill. Cloud writing remains subject to the same compatibility requirement.

### Reproducing the checks

Build both revisions with the same Node and grammar installations. From `ix-cli`, run the following against the dedicated E2E stack. The E2E and map benchmark commands reset that stack. Repeat the two behavioral E2E files on the supported floor with the harness image override and isolated ports. [Live scenarios](../ix-cli/test/e2e/behavior-map.e2e.ts) · [Wire-contract assertions](../ix-cli/test/e2e/behavior-attributes.e2e.ts) · [Harness](../ix-cli/test/e2e/README.md)

```sh
npm run build
npm run typecheck
npm run smoke
IX_E2E=1 npx vitest run --config vitest.e2e.config.ts
npm run test:slow -- src/cli/__tests__/ingest-scale.slow.test.ts
node scripts/behavior-perf.mjs "$STEP2_BUILD_ROOT" --parser
IX_E2E=1 node scripts/behavior-perf.mjs "$STEP2_BUILD_ROOT" --map
```

The paired runner uses Node 26, four parser workers and the actual built CLI for both revisions. It checks returned write counts, serialized patch uploads and every steady-state request count. It alternates the two builds, prints raw samples and exits unsuccessfully when a wall-time gate is exceeded. The CI performance fixture separately measures response bytes and command request counts. [Paired runner](../ix-cli/scripts/behavior-perf.mjs) · [CI budgets](../ix-cli/test/perf/budgets.json)

### Observed live behavior

For a TypeScript project containing the method below, the only Ix command used to extract and persist evidence was `ix map .`. An independent `GET /v1/entity/{method-id}` read the result. After each edit the same command updated the same graph node.

```ts
export class Job {
  start() {
    if (this.status === "queued") this.status = "running";
  }
}
```

| Source revision | Live entity result |
| --- | --- |
| Original | One observed write to `running` at `[3,34,3,57]`. The true guard spans `[3,8,3,32]`. The inferred candidate source is `queued`. |
| Change the body to `if (ready) this.status = "done";` | Same method and slot IDs. The new write ID carries destination `done` at `[3,15,3,35]`. The inferred source is `unknown`. |
| Remove the assignment, keeping `start() {}` | The method keeps its ID and its ordinary attributes. `behavior_v1` is absent. |
| Downgrade experiment on the original source | Running the saved Step 2 binary's ordinary map removes the attribute. Running the Step 3 binary's ordinary map from that downgraded local baseline restores the original write and slot IDs. |

### Compatibility and migration checks

| Check | Memory layer 1.0.30 | Memory layer 1.0.35 |
| --- | --- | --- |
| Existing single/bulk wire suite, including historical reads | 25 passed | 25 passed |
| Ordinary map, guard and destination edits, final removal, loss of eligibility, historical evidence | Passed | Passed |
| Full-mode equivalence, rename, deletion, restoration, partial prefix with reason | Passed | Passed |
| Legacy attribute loss, old/missing/current local baselines, forced recovery | Passed | Passed |
| Scoped upgrade, failed commit, unverifiable replay and failed baseline replacement | Passed | Passed |
| Abrupt child-process termination, checkpointed file edited before resume | Passed | Passed |
| Two workspaces with the same relative source path and distinct evidence | Passed | Passed |

These nine map and migration cases run against real storage. The deterministic failure case intercepts selected calls within the writer to withhold an upload, fail a live read, or fail the local atomic write. Assertions independently inspect the actual graph and the on-disk checkpoint. A separate test terminates the writer process after its first checkpoint. The canonical identity test also compares solo and co-ingest symbol/slot IDs directly. [Map and recovery tests](../ix-cli/test/e2e/behavior-map.e2e.ts) · [Patch identity tests](../core-ingestion/src/__tests__/patchBuilder.test.ts)

The local-state guarantee uses Ix's existing atomic rename. Tests cover process termination and filesystem write failure. Host power loss, simultaneous conflicting checkouts and cloud authoring have separate operational assumptions. On the release floor an ambiguous patch ID may require an additional repair upload and live reads of the file's callables. These costs apply to recovery. An unchanged workspace with compatible writers uses its existing mtime and hash checks.

### Step 3 performance measurements

Measurements used Node 26.12.0 on macOS arm64, the saved Step 2 build, identical sources and a disposable 1.0.35 backend. Times below are wall-clock medians in milliseconds with observed minimum and maximum. The parser pool alternated builds in ABBA order and transferred full parse results. The live-map benchmark staged both compiled distributions in the same temporary filesystem layout, warmed each four times, alternated build order, reset the backend for each fresh map and then mapped the same checkout again.

| Workload | Samples per build | Step 2 median [min, max] | Step 3 median [min, max] | Change | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Optional extractor on 100 candidate-free method bodies in a file with a false text hit | 25 | 2.55 [1.69, 9.78] | 0.76 [0.49, 1.83] | −70.1% | At least 50% reduction |
| Four-worker parse, 32 production TS files, zero writes | 20 | 186.62 [134.39, 331.56] | 182.52 [110.01, 321.24] | −2.2% | At most +5% |
| Four-worker parse, 3,200 guarded writes | 20 | 131.72 [91.65, 193.67] | 118.24 [61.76, 229.52] | −10.2% | At most +10% |
| Fresh map, 24 files with zero writes | 24 | 1,131.09 [660.15, 2,234.25] | 1,140.43 [707.95, 2,597.87] | +0.8% | At most +5% |
| Fresh map, 24 files with one guarded write each | 24 | 1,152.05 [676.80, 2,338.31] | 1,104.66 [794.89, 2,421.20] | −4.1% | At most +10% |
| Steady no-op requests, each live workload | 24 | 6 [6, 6] | 6 [6, 6] | 0 | Zero additional requests in every pair |

The first live run compared a bare distribution with a developer checkout. Both workloads exceeded their gates. Instrumentation located a 611 ms difference before the first backend request, with 8 ms and 5 ms respectively in patch building. After staging the builds identically, the nine-sample zero-write run still exceeded its gate at +7.8%. The longer isolated run above kept the original thresholds. Startup-to-first-request medians in that run were 102.2 and 109.6 ms for the zero-write case, and 110.3 and 110.4 ms for the guarded case. The timing ranges limit conclusions about small speed differences.

The 24-file fresh upload totaled 61,317 bytes in Step 2 for either workload. Step 3 sent 62,253 bytes with zero writes and 76,605 bytes with 24 verified writes. The extractor bump adds one predecessor UUID per file and these guarded envelopes added another 598 bytes per file. The test suite bounds added behavioral attributes to 256 KiB per file and checks structural output under exhaustion. The 5,000-file scale test, including 250 eligible functions, took 3,871 ms and added 533,804,584 bytes of peak RSS. It uploaded 15,676,698 bytes in ten bulk requests and zero single-file fallbacks, within the 30 s, 1.5 GB and 30-bulk limits. All nine scenarios in the pinned fixture's request and response-byte gate passed. On its steady no-op map the result was six requests, 1,017 response bytes and 336 ms.

### Files changed in Step 3

| Area | Files |
| --- | --- |
| Candidate filtering, verified writes and patch construction | [Parser](../core-ingestion/src/index.ts) · [Extractor and ID binding](../core-ingestion/src/behavior.ts) · [Patch builder](../core-ingestion/src/patch-builder.ts) |
| Attribute types | [Canonical schema](../core-ingestion/src/schema.ts) · [CLI mirror](../ix-cli/src/client/graph-schema.ts) |
| Patch submission, live verification, migration and checkpoints | [Ingest command](../ix-cli/src/cli/commands/ingest.ts) · [Ingest baseline](../ix-cli/src/cli/ingest-baseline.ts) |
| Structural equivalence, member identity and size bounds | [Extractor tests](../core-ingestion/src/__tests__/behavior.test.ts) · [Patch builder tests](../core-ingestion/src/__tests__/patchBuilder.test.ts) |
| Live lifecycle and regression coverage | [E2E scenarios](../ix-cli/test/e2e/behavior-map.e2e.ts) · [Test backend entity provenance](../ix-cli/src/cli/__tests__/helpers/fake-backend.ts) · [Floor-release CI run](../.github/workflows/ci.yml) |
| Performance and rollout evidence | [Paired benchmark](../ix-cli/scripts/behavior-perf.mjs) · [Scale suite](../ix-cli/src/cli/__tests__/ingest-scale.slow.test.ts) · This architecture document |

### Regression results

Both production builds, CLI type checking, a separate strict type check of both behavioral E2E files, schema-mirror parity and parser smoke passed. Core ingestion finished with 1,108 passes and one skip. An earlier concurrent run crossed the existing edge-batching timing threshold. The isolated batching test and the final full core run passed.

The final Node 26 CLI regression run reported 5,301 passes, one expected failure, three skips and one failing caller-output snapshot. The snapshot expects `site=src/app.ts:4` and receives `site=4`, as recorded in Step 2. The timed agent-evaluation subprocess passed separately on Node 24.11.0 in 87 s. In an additional broad Node 24 run, two directory-symlink teardown calls failed at `rmSync`; both tests passed in the final Node 26 suite. Across the final split CLI runs there were 5,302 passes. The released-backend results above come from a 53-test full harness run on 1.0.35 and a 34-test behavioral run on 1.0.30.

## Step 4 — Agent-facing retrieval

After an ordinary map, a default MCP call such as `ix_context({"target":"Job"})` can show both the assignment inside `start`’s true branch and the assignment in `stop`. On the benchmark fixture, the mapped source records `this.status = "running"` at `job.ts [2,42,2,65]` under the guard `this.status === "queued"` at `[2,16,2,40]`. The candidate prior is `"queued"`. The unguarded write of `"done"` at `[3,11,3,31]` has an unknown prior. The two methods share one slot ID. These facts describe assignments in source. Runtime ordering, reachability, initial states, and terminal states remain unknown.

| Entry point | Behavior and read cost |
| --- | --- |
| Target context, including default MCP | A ranked evidence row follows the first structural row. The normal formatter names the method, field, assigned literal, controlling branch, predicate, candidate prior, and exact spans. Existing entity and containment reads supply the data at head. |
| Structured context, save, resume, diff | The selected projection is in `evidence[].behavior`. It carries slot and write IDs, owner ID, URI, source hash, extractor, ordered guards, tagged prior, and per-site extraction coverage. Saved bundles retain the selection made under their original format and budgets. A changed citation, guard, inferred prior, destination or coverage produces a removed and an added evidence row, including when the write ID survives. |
| Impact | Uses full nodes observed during the existing target resolution and containment reads. The separate `behavioralEvidence` JSON field and `mapped_writes` text record describe the analyzed owner. Impact propagation, scores and heuristic behavior-at-risk retain their original inputs. |
| Explain | Uses the target and member reads already made for structural facts. The raw class view can use one bounded outgoing containment read for member attributes. Normal and raw views use the same decoder. |

The decoder accepts the supported producer, language, code provenance, bounded field values, structurally valid UTF-16 spans, and internally consistent candidate references. It treats guard expressions and literals as quoted source text. The backend is the trust boundary for the original mapped source. The projection groups direct contained callables by persisted slot ID. Limits are 20 owners, 256 decoded writes across the selection, four returned sites, and a 1,600-character allowance for site descriptions. Context additionally charges each complete selected write against a quarter of the existing format-specific character budget, then applies its ordinary whole-bundle budgets. A class projection always identifies its scope as the returned members. Missing owners, omitted owners, and omitted writes have distinct counters. Extraction coverage and cut reasons describe the producer's analysis. A missing envelope has no negative evidentiary value, including after a legacy writer upsert.

### Revision behavior

Both released backends provide complete attributes and provenance on entity and direct containment reads. Their compact and standard context summaries can substitute the filename for the member name and omit behavioral attributes. A seed-only full `POST /v1/context` can hydrate the requested node IDs at a fixed revision, including deleted methods. Retrieval checks the returned revision, identity, visible lifetime and containment. It bounds historical hydration to the target, directly selected members or the qualifying parent. Full context and previously verified individual-ID lookups can supply the node directly.

An in-place remap can retire the old containment edges even while a previous method revision is readable by UUID. Historical name search can also omit deleted namesakes. A verified historical class view requires historical membership. Use a full owner UUID for the most reliable historical read. A historical name requires an exact source path, with a verified containing class for a method. An ambiguous or unanchored name, missing relationship, unsupported producer or failed historical hydration yields unavailable behavioral evidence. Historical issue starting points can depend on working-tree data and therefore do not establish a behavioral identity. Saved investigations retain a verified ID for rebuilding their historical side. The projection takes its source citations from graph provenance at the requested revision.

[Decoder and projector](../ix-cli/src/cli/behavioral-evidence.ts) · [Revision checks](../ix-cli/src/cli/context/behavior-revision.ts) · [Context assembly and budgets](../ix-cli/src/cli/context/bundle.ts) · [Live compatibility tests](../ix-cli/test/e2e/behavior-retrieval.e2e.ts) · [Paired stdio benchmark](../ix-cli/scripts/behavior-retrieval-perf.mjs)
