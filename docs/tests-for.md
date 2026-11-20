# Find tests with `ix tests-for`

```sh
ix tests-for double
ix tests-for src/calc.py --limit 5 --format llm
ix tests-for Parser --path src/parser.ts --format json
```

Run `ix map` after upgrading: extractor 1.31 adds `TESTS` edges using existing
call/import resolution. TS/JS, Python, Go, Java and Scala test paths and framework
markers are recognized. Named pytest functions, Go `TestXxx` functions and JUnit
annotated methods identify individual tests. Anonymous `describe`/`it` callbacks,
suite setup and helpers use the test file as a fallback. Framework calls in
comments and string literals do not classify a file.

Edges point from test to production definition (or imported production file).
Their `confidence` and `tier` come from call/import resolution; `via` is `CALLS`
or `IMPORTS`. This is **static evidence**, not executed coverage. Unresolved calls
and external library nodes do not gain TESTS edges. Test-to-test relationships
are excluded using destination classification, including stored summaries for
incremental maps.

Results rank by resolution confidence multiplied across the path, divided by
path length; import evidence has a 0.65 weight. Direct calls therefore outrank
equally confident indirect/import evidence. The walk includes up to two production
callers between the target and its TESTS edge. When imports resolve only to a
symbol's containing file, the route includes `CONTAINS` and confidence is halved.
File queries also seed contained
definitions. One row per test includes its id, path:line, route, confidence and
an inferred command when available. A named test supersedes its file fallback
for the same result. JSON also includes scores, selectors and truncation status.

Reads are bounded to 40 incoming expansions plus one containment expansion,
250 edges per expansion, six concurrent requests, and the normal read deadline.
Results report truncation when these bounds or `--limit` cut the list.
Use a narrower symbol to reduce traversal truncation. Missing evidence can mean
an old/unmapped graph, unsupported syntax, dynamic calls or unresolved imports.

Command suggestions read local runner configs without executing them. They use
the nearest recognized package test script, pytest configuration, Go module or
sbt build. Nested JS packages are runner boundaries. Unknown or malformed
configs omit the command. Run commands from the workspace root; nested builds
include a `cd` prefix. Review suggestions against the project's usual test gate.

MCP: start `ix mcp --tools=all` to advertise `ix_tests_for`. It accepts `symbol`
(a name or file), `kind`, `path`, `pick` and `limit`. The default core toolset is
unchanged. It returns the compact CLI rows.

See [the test reach evaluator](../bench/test-reach/README.md) for top-k comparison
with filename selection and the available benchmark data's limitations.
