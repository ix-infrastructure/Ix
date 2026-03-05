<!-- IX-MEMORY START -->
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## MANDATORY RULES
1. BEFORE answering any question about the codebase → call `ix_query` first. Do NOT answer from training data alone.
2. AFTER every design or architecture decision → call `ix_decide` with both the conclusion AND the reasoning.
3. When you notice contradictory information → call `ix_conflicts` and present conflicts to the user before continuing.
4. NEVER guess about codebase facts — if Ix has structured data, use it. Say "according to Ix" when citing results.
5. IMMEDIATELY after modifying code → call `ix_ingest` on changed files. Do not batch this to the end of the session.
6. At start of each session → review `ix://session/context` to load prior work and decisions.
7. When the user states a goal → call `ix_truth` to record the intent so all decisions can trace back to it.

## Workflow
A typical session follows this flow:
1. **Start** — Read `ix://session/context` and `ix://project/intent` to understand prior state.
2. **Query** — Before any task, call `ix_query` to get relevant context from the knowledge graph.
3. **Work** — Implement changes, making decisions as needed.
4. **Ingest** — After each file change, call `ix_ingest` immediately to keep the graph current.
5. **Decide** — Record any design decisions with `ix_decide` so future sessions can understand why.

## What NOT to Do
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
