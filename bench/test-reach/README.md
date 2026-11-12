# Test reach evaluation

Build ingestion (`cd core-ingestion && npm run build`), then from `ix-cli`:

```sh
node --import tsx ../bench/test-reach/evaluate.mjs ../bench/agent-eval/smoke.json
node --import tsx ../bench/test-reach/evaluate.mjs --fixtures
node --import tsx ../bench/test-reach/evaluate.mjs path/to/local-manifest.json
```

The local manifest is an array (or `{ "tasks": [...] }`) of records with
`instance_id`, `repo_path` relative to the manifest, the gold unified diff in
`patch`, and `FAIL_TO_PASS` / `PASS_TO_PASS` arrays (JSON-encoded arrays work too).
Use base checkouts with the benchmark's **test patch already applied**. The
evaluator reads tracked files; it does not provision repos, apply patches or run
tests. Labels describe observed harness outcomes, not outcomes this script proves.

Gold targets are functions/methods intersecting changed base lines, falling back
to their file for changes outside a definition. Selections are merged across
gold targets by maximum score. Counts are micro-averaged labeled tests selected
in the first 1/5/10 rows. A file fallback selects all labeled tests in that file;
function rows select their pytest/unittest selector. Parameterized pytest cases
share the function selection. Unresolved targets and missing inputs are reported
as skipped, never successful measurements. Traversal caps are reported per task.

`before` replays CALLS/IMPORTS closure with test-file classification, ignoring
TESTS edges. It uses the same resolved graph to isolate selection from parser
changes (including the Go package-local resolution fix); it does not claim to
reproduce the old extractor. `after` runs the same bounded traversal and ranking
as `ix tests-for`. The filename
baseline ranks all classified test files by matching normalized source/test stem,
then common directory depth, then lexical path. It does not inspect imports.
These are static test-selection counts, not runtime coverage or test executions.

The checked-in `agent-eval/smoke.json` contains three synthetic orchestration
placeholders, **no F2P/P2P labels**, and no task checkouts. It therefore produces
0 measured / 3 skipped tasks and no F2P/P2P denominator. Do not report that as 0%
recall. `--fixtures` is a separate five-language smoke measurement, not SWE-bench
evidence; its expected labels are fixture files, not F2P/P2P outcomes.
