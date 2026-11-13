<!-- Copyright 2026 Ix Infrastructure Inc. -->

# Changes together

`ix map` and full-workspace `ix ingest` mine git history by default. Use
`--no-git-history` on either command, or `IX_GIT_HISTORY=0`, to skip this step.
Scoped file/directory refreshes leave the workspace history index alone.
For a system spanning independent repositories, mine each repository with
its own full ingest; the multi-repository parent does not mine across them.

```sh
ix coupled src/parser.ts
ix coupled parseFile --path src/parser.ts --format json
ix impact parseFile
```

The read-only MCP tool `ix_coupled` is available with `ix mcp --tools=all`.
CLI and MCP results include ranked partners, support, directed confidence,
last co-change date and recent fix commit metadata. Impact has a labelled
“Changes together” section. Full issue-mode context uses cached file partners
as low-weight companions, with reason “changes together”; starting points
and primary lexical ranking retain their precedence. Existing query-time
history is the fallback when no ingestion index exists.

## Evidence and bounds

The mining window contains at most 2,000 non-merge commits from the last
12 months. Commits touching more than 50 files, formatting/bot subjects,
common vendor/generated paths, lock files, and files marked
`linguist-generated` or `linguist-vendored` are excluded. Sensitive file
paths such as `.env` and private-key files are excluded before blob reads.

Support counts eligible commits touching both endpoints. Confidence divides
support by eligible commits touching the source, including solo changes.
Each source retains at most 20 outgoing `CO_CHANGES` edges, with support
at least 3 and confidence at least 0.3, ordered by confidence then support.
Edges carry `support`, `confidence` and `last_co_change` attributes.

Symbol evidence is best effort: at most 200 historical file versions per run,
200 KiB per blob, and 250 symbols per commit. Post-image diff hunks are mapped
through the existing language parsers; deleted-only hunks and unsupported
languages contribute file evidence only. A symbol must still exist in the
current ingestion symbol table to appear in the query index or graph.
Coverage counters are returned in the ingestion summary. The newest three
fix-like commits per symbol retain only short SHA, date and subject; no blob
or diff content is stored. Fix-like subjects include fix/bug/regression words
and issue references such as `#123`.

Mining and graph writes share a 30-second deadline; each git subprocess also
has a 5-second limit. Graph writes use batches of at most 1,000 operations.
An interrupted write keeps a recovery journal and retries on the next full
ingest. Only a completed refresh advances the mined cursor and query index.
Rewritten history rebuilds the bounded window. Expired evidence and missing
endpoints remove old edges. Reset clears the index and recovery journal.
Forced ingests and detected backend resets republish edges from cached evidence
without re-mining old commits. Workspace re-keying preserves the old namespace.
The index lives beside the workspace ingestion caches. Results identify the
mined HEAD, which can lag the worktree until its next full ingest.

## Evaluation

Build first with `cd ix-cli && npm run build`. Run the offline localization
slice against a **single-repository** JSONL manifest containing
`instance_id`, `base_commit`, `problem_statement`, and `patch`:

```sh
node scripts/ranking-eval/coupling.mjs --repo <repo> --instances <manifest>
npx tsx scripts/bench-git-coupling.ts
```

The evaluator reads base-commit git objects without checking out branches and
mines only that revision's ancestors. It reports multi-file second-gold
recall@5 and before/after file recall@5 (`F@5`), using the existing offline
definition-search approximation. Without a manifest, it labels recent fix
subjects as a local proxy, not an issue benchmark. The overhead fixture uses
5,000 source files, 2,000 commits, real git/parsers, and the test HTTP backend;
its graph-size measurements are edge counts and serialized operation bytes,
not database disk usage or production-backend throughput.
