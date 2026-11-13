# Error evidence in issue localization

Ingestion records throws/raises, Go panic and error constructors, and error/warn
logging calls in TypeScript, JavaScript, Python, Go and Java. `RAISES` connects
the enclosing function (or file for module-level sites) to a file-scoped error
type. Its `sites` attribute contains source lines and literal message templates.
Message literals are searchable constant nodes with `message_template`,
`error_type`, `enclosing_function` and source location attributes. Both `ix map`
and full ingestion retain these nodes. Extractor 1.31 triggers re-ingestion of
previously mapped source files.

Printf, brace-format and interpolated values normalize to `{}`. Dynamic-only
messages retain their error type but provide no message match. To avoid generic
starts, message matching requires at least 12 literal letters/digits and permits
at most 256 characters per placeholder, within one line. It is case-sensitive.

`ix context --from-issue` analyzes potential error sites in tracked source files
with the ingestion parser. A batched repository grep finds candidate files;
frame and message lookups share a per-plan fallback budget of 150 ms, 32 source
reads and 512 KiB of source. Each candidate is limited to 200 KiB, and each parse
receives the remaining time allowance. Repository grep and native parsing are
synchronous and cannot be interrupted; the deadline is checked between files
and by the parser's cooperative checks. Budget exhaustion can omit error starts;
identifier resolution and ordinary ranking continue. Parsed symbols and message
results are reused within the plan, including after exhaustion.
Matching templates become confident starts with reason `error message`.
Python, V8, JVM (Java/Scala), and Go frame locations become `traceback frame`
starts. Foreign path prefixes are stripped through tracked-path suffix matching;
JVM packages help disambiguate source basenames. The innermost eligible frame of
each trace is selected, preserving the existing three-start limit. The enclosing
function's graph node is used when search resolves its name, file and location.
An unavailable symbol leaves a source location that can fall back to the file
node. Minified/generated files, runtime libraries and ambiguous paths are skipped.
Source maps and dynamic message construction are not inferred.

## Localization slice evaluation

Build the parent revision's `issue.js` as an importable module, and build the
current CLI. Supply the existing localization JSONL dataset and its base-commit
bare repositories explicitly; the evaluator performs no downloads:

```sh
cd ix-cli
node scripts/ranking-eval/error-slice.mjs \
  --dataset <dataset.jsonl> --repos <bare-repo-directory> \
  --before <parent-issue-module.mjs> --set dev
```

The JSON report gives the share of evaluable instances containing a matchable
message or repository frame, and before/after F@5 on that slice. As in the
existing ranking harness, F@5 is macro mean gold-file recall among the first five
files. Both runs use the same base snapshots, definition-search stand-in and
gold paths; no backend or graph closeness is used. The held-out test split
requires `--final yes-once`. Dataset measurements require the external dataset
and repositories; the committed unit fixtures only validate the evaluator.

Measurement status: **not measured on the benchmark**. This worktree contains
neither the localization dataset nor its base-commit repositories. The review-fix
run permits neither external downloads nor reading caches outside the worktree.
Matchable-instance share and before/after F@5 therefore remain unavailable, and
the benchmark acceptance criterion remains incomplete. The two-row fixture
assertions are evaluator checks and must not be reported as benchmark results.
