# Locate configuration and entry points

After `ix map`, look up an exact config key, environment variable, flag spelling,
or declared HTTP route:

```sh
ix config server.port
ix config APP_HOST --format json
ix config -- --verbose
ix config 'GET /items/{id}'
ix config lookup --format json -- --verbose
```

`ix config show`, `get`, `set` and `prune` still manage Ix's own settings. Use
`lookup` for a binding whose name is one of those reserved subcommands.
The `ix_config` MCP tool is available with `ix mcp --tools=all`; its `query`
argument accepts the same names and returns JSON with `matches` and `truncated`.
Each match records its declaration, read or handler role, qualified symbol,
source location and any recognized scalar default. Search is bounded to 200
candidate nodes and reports a filled page as potentially truncated.
Method-qualified route lookups also match all-method registrations (`* /path`),
while preserving exact path patterns and rejecting other method-specific routes.

Extraction uses parsed accesses, calls and annotations in TypeScript/JavaScript,
Python, Go and Java. It recognizes the environment APIs, settings/config objects,
commander/yargs, argparse/click/typer, flag/pflag/cobra, picocli, express/fastify,
Next app route exports, flask/fastapi/django URL declarations, net/http/gin/echo/chi,
and Spring/JAX-RS annotations. Existing JSON/YAML/TOML parsers provide config
declarations with full key paths. Ordinary strings and comments are not binding
evidence. Static local handlers are linked to their symbols; an unresolved or
dynamic handler is attributed to its containing symbol or file. Runtime router
mounts, arbitrary wrappers and computed keys are not evaluated.
Static Spring controller prefixes are combined with method paths. Flag reads
require a bound parser result, registered callback parameter, or annotated field;
an unrelated variable with the same spelling is insufficient. Arbitrary aliases
and interprocedural argument flow are not resolved.

Issue mode uses exact binding matches as strong starts with reasons `config key`,
`env var`, `flag` and `route`. It recognizes uppercase environment names, flag
spellings, dotted keys, explicit `METHOD /pattern` routes, backticked names and
route paths, and names introduced by “setting”, “config key” or “env var”. Source
eligibility and existing issue-start limits apply.

The backend's optional `/v1/capabilities` `nodeKinds` list must explicitly include
`ConfigKey`, `EnvVar`, `CliFlag` and `Route` before specialized kinds and predicates
are sent. Otherwise bindings use existing `config_entry` nodes and `REFERENCES`
edges, with the binding kind and semantic predicate in attributes. Both forms
support lookup. After backend capability changes, use `ix map --force` to rebuild
unchanged sources. Extractor 1.31 also refreshes pre-feature indexes.

For an offline localization evaluation, build the CLI and supply JSONL rows with
`id`, `issue`, `files` (a path-to-source snapshot), and `gold` (changed file paths).
For a curated benchmark, independently label each row with `bindingMentions`, an
array of the configuration/entry-point names mentioned by the issue (use `[]`
for negatives). Label these before running the extractor being evaluated:

```sh
cd ix-cli
npm run build
node --import tsx scripts/ranking-eval/config-slice.mjs snapshots.jsonl
node --import tsx scripts/ranking-eval/config-slice.mjs --fixtures
```

The evaluator reports slice share and mean file recall at five before/after
binding starts, using the same picker and ranking functions. Slice membership
uses the independent labels; without labels it uses syntactic issue candidates
and reports that definition explicitly. Lookup success never determines slice
membership: missed detections remain in the denominator. `detectedSliceIssues`
reports lookup coverage separately, and per-issue results include the mentions.

Fixture smoke results: 4/5 issues in the candidate slice (share 0.8), F@5 0.0
before and 1.0 after, 53 binding edges checked, zero negative-control edges.
These are synthetic fixture results, not localization-benchmark measurements.

Localization-benchmark share and before/after F@5 remain **unmeasured**. The
existing benchmark loader depends on datasets and repository snapshots outside
this worktree; no benchmark snapshots are present here. This run permits neither
other checkouts nor external services. Completing that measurement requires an
independently labeled JSONL export with issue text, source snapshots and gold
files inside the worktree, then running the command above.
