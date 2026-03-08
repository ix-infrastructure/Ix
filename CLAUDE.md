<!-- IX-MEMORY START -->
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## MANDATORY RULES
1. BEFORE answering codebase questions → use targeted Ix tools (see Command Routing below). Do NOT answer from training data alone.
2. AFTER every design or architecture decision → call `ix_decide` with both the conclusion AND the reasoning.
3. When you notice contradictory information → call `ix_conflicts` and present conflicts to the user before continuing.
4. NEVER guess about codebase facts — if Ix has structured data, use it. Say "according to Ix" when citing results.
5. IMMEDIATELY after modifying code → call `ix_ingest` on changed files. Do not batch this to the end of the session.
6. At start of each session → review `ix://session/context` to load prior work and decisions.
7. When the user states a goal → call `ix_truth` to record the intent so all decisions can trace back to it.

## Preferred Ix Command Routing

Use bounded, composable primitives — never broad NLP-style queries.

| Question type | Command | Example |
|---|---|---|
| Find an entity by name | `ix_search` | `ix_search "IngestionService" --kind class` |
| Understand a symbol | `ix_entity` | `ix_entity <id>` |
| What calls a function | `ix_expand` | `ix_expand <id> direction=in predicates=["CALLS"]` |
| What a function calls | `ix_expand` | `ix_expand <id> direction=out predicates=["CALLS"]` |
| Members of a class/module | `ix_expand` | `ix_expand <id> direction=out predicates=["CONTAINS"]` |
| What imports something | `ix_expand` | `ix_expand <id> direction=in predicates=["IMPORTS"]` |
| Exact text/snippet search | `ix_text` | `ix_text "verify_token" --language python` |
| Past design decisions | `ix_decisions` | `ix_decisions --topic "ingestion"` |
| Entity change history | `ix_history` | `ix_history <entityId>` |
| What changed between revisions | `ix_diff` | `ix_diff 1 5` |
| Detect contradictions | `ix_conflicts` | `ix_conflicts` |
| Record a goal | `ix_truth` | `ix_truth add "Support 100k file repos"` |

### Decomposition Examples

**"List all files and what they import"**
1. `ix_search "" --kind file --limit 50`
2. For each file: `ix_expand <id> direction=out predicates=["IMPORTS"]`

**"How does ingestion work?"**
1. `ix_search "IngestionService" --kind class`
2. `ix_entity <id>` — get details
3. `ix_expand <id> direction=out predicates=["CONTAINS"]` — see methods
4. `ix_expand <methodId> direction=out predicates=["CALLS"]` — see what each method calls

**"What depends on verify_token?"**
1. `ix_search "verify_token" --kind function`
2. `ix_expand <id> direction=in predicates=["CALLS"]` — callers
3. `ix_expand <id> direction=in predicates=["IMPORTS"]` — importers

### Bounded-Result Best Practices
- Always use `--kind` to filter entity type when searching
- Always use `--limit` to cap result sets
- Use `--path` to restrict text searches to specific directories
- Use exact entity IDs from previous results, not broad queries
- Decompose large questions into multiple targeted tool calls

## Avoid ix_query

`ix_query` is **deprecated**. Do NOT use it for:
- Broad repo-wide inventory ("list all classes")
- NLP-style QA ("how does X work?")
- Exploratory graph sweeps

These produce oversized, low-signal responses that waste tokens and return noisy data. Always decompose into the targeted commands above.

## Workflow
A typical session follows this flow:
1. **Start** — Read `ix://session/context` and `ix://project/intent` to understand prior state.
2. **Explore** — Use `ix_search` + `ix_entity` + `ix_expand` to understand relevant code.
3. **Work** — Implement changes, making decisions as needed.
4. **Ingest** — After each file change, call `ix_ingest` immediately to keep the graph current.
5. **Decide** — Record any design decisions with `ix_decide` so future sessions can understand why.

## What NOT to Do
- Do NOT use `ix_query` for broad exploration — decompose into targeted commands instead.
- Do NOT answer architecture questions from training data alone — always check Ix first.
- Do NOT skip `ix_ingest` after modifying files — stale memory leads to wrong answers next session.
- Do NOT record a decision without rationale — "we chose X" is useless without "because Y".
- Do NOT ignore conflicts — if `ix_conflicts` returns results, surface them to the user before proceeding.

## Confidence Scores
Ix returns confidence scores with query results. When data has low confidence:
- Mention the uncertainty to the user (e.g., "Ix has low confidence on this — it may be outdated").
- Suggest re-ingesting the relevant files to improve confidence.
- Never present low-confidence data as established fact.
<!-- IX-MEMORY END -->
