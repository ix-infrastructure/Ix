# Graph Decisions Backup
# Re-record these after reset with: ix decide "<name>" --rationale "<rationale>"

1. ix decide "CONTAINS_CHUNK predicate for File→Chunk edges (separate from CONTAINS)" --rationale "CONTAINS is already used for File→Symbol and Class→Method hierarchy. Using a distinct CONTAINS_CHUNK predicate for File→Chunk edges avoids ambiguity in graph traversal and keeps chunk subgraph cleanly separable from symbol hierarchy queries."

2. ix decide "inference_version is a required field on all inferred claims" --rationale "Observed claims (from parsing) are versioned implicitly via the extractor field in provenance. Inferred claims (subsystem membership, smells, summaries) need an explicit inference_version string (e.g. smell_v1) so they can be rerun selectively without touching observed facts. Missing = legacy for backward compat."

3. ix decide "Chunk nodes are first-class observed nodes, not derived from symbols" --rationale "Symbols (class/function/method) are named entities. Chunks are code spans — the retrieval unit for LLM context. A chunk DEFINES one or more symbols and is CONTAINED by a file. Separating them allows chunk-granularity retrieval without blowing up symbol addressing."

4. ix decide "Chunk granularity: AST-based semantic chunks" --rationale "Fixed-line windows break semantics. Symbol-only is too fragmented for LLM context. AST-based chunks (function body, class, top-level logical block) are the right unit. Hierarchy: File -> Chunk -> Symbol(s), with edges next_chunk, CALLS, REFERENCES between chunks. This enables context expansion: retrieve chunk + neighbors instead of whole file."

5. ix decide "Summaries as claims with has_summary.* predicates" --rationale "Summary nodes would be a new abstraction with no benefit. Claims with predicates has_summary.purpose, has_summary.api, has_summary.dependencies, has_summary.responsibility are replaceable, versionable via source field (e.g. llm_v1), allow competing summaries to coexist, and make retrieval trivial with no extra joins."

6. ix decide "SubsystemCandidate as claim not node" --rationale "Subsystem membership is belief, not fact. Using candidate_member_of claims on existing Subsystem nodes avoids graph bloat, reuses confidence/provenance/evidence infrastructure, supports conflicting memberships and overlapping subsystems, and allows re-scoring without rewiring the graph. Subsystems are real entities (nodes); membership is belief (claims)."
