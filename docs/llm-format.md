# `--format llm` output convention

`--format llm` is a token-minimal, newline-delimited output mode for AI coding
agents (ix-claude-plugin, Cursor, Codex, ...) that call `ix` many times per
session. It strips the decorative whitespace of `--format text` and the
structural overhead of `--format json`, typically cutting response bytes 2-4x
versus `json` on tree- and table-shaped output.

It is accepted on every command that accepts `--format`. Commands with a
hand-written renderer emit compact records (see below); the rest route
`--format llm` to whichever existing format is most compact (usually `text`),
so consumers can pass the flag unconditionally without a per-command lookup.

## Choosing it once

`--format` on the command line always wins. When it is absent, the default is
resolved in this order:

1. `IX_FORMAT` — `text`, `json` or `llm`.
2. `format` in `~/.ix/config.yaml`, i.e. `ix config set format llm`.
3. `text`.

A plugin or a shell profile can therefore set `IX_FORMAT=llm` once instead of
appending the flag to every command it wraps. `ix config show` prints the
stored value and says when `IX_FORMAT` is overriding it.

Two things this deliberately does not do. It does not switch on whether stdout
is a terminal: a script that has always parsed `text` would start receiving
records on its next run, with nothing it could have done about it. And it does
not apply to a command that has no `llm` renderer to switch to — `ix query`
offers `text` and `json`, so it stays on `text` and says so in `--help`.

An unrecognised value is ignored rather than fatal — it is read by every later
command, so a typo would otherwise break all of them at once. The CLI says
which value it ignored, on stderr, when a person is there to read it.

## Wire format

- **One record per line.** Newline-delimited, no nesting.
- **Scalars:** `key=value` pairs separated by a single space.
- **Tabular rows:** a leading `record-kind` token, then `key=value` pairs:
  `region id=cli kind=subsystem label="Cli / Client" level=2 files=87`.
- **No decorative whitespace, separators, or headers.**
- **Omitted fields:** null, undefined, and empty values are dropped. Zeros and
  other defaults are dropped where they carry no signal.
- **Ids are eight characters.** Any field holding an opaque identifier — `id`,
  `parent`, `src`, `dst`, `entity`, `claim_a`/`claim_b` — carries the first
  eight characters of it, which is what `/v1/resolve-prefix` accepts, so the
  short form can be passed straight back to the CLI. A 36-character UUID
  tokenizes at roughly 1.8 characters per token, and on `ix map` the ids alone
  outweigh the labels beside them. A reference is shortened on both sides, so
  `parent=` still matches some other row's `id=`. `--format json` carries the
  full id. Ids that are not opaque blobs — a slug like `root`, a prefixed id
  like `c-8f31a2` — are left whole.
- **Search and edge rows carry an id only when it is needed.** `search`,
  `callers`, `callees`, `imports` and `imported-by` rows are acted on by name
  and path, so they leave `id=` off — except on rows that share a name, kind
  and path with another row in the same answer, where the id is the only
  handle that tells them apart (every symbol command accepts one), and on an
  unresolved `ref`, which has nothing else. `--fields id` asks for it on every
  row.
- **Quoting:** a value containing a space, `=`, `"`, `\`, or a control
  character is wrapped in double quotes. Inside quotes, `"` and `\` are
  backslash-escaped and newline / carriage-return / tab are encoded as `\n` /
  `\r` / `\t`, so a record never spans more than one line.
- **Errors:** a uniform `error code=<slug> message="..."` line in the same
  format as data lines; the process still exits non-zero. A graph target that
  does not exist is always `unresolved_target`.
  The graph commands (`locate`, `callers`, `callees`, `impact`, `explain` and
  the rest that resolve a target, `subsystems <region>` and `around` included)
  exit with a code per outcome, and json's `error` / llm's `error code=` carry
  the matching slug (`subsystems --format json` prints the backend's body, where
  an unknown region is `unknown_target`):

  | Exit | Outcome | Slug |
  |---|---|---|
  | 0 | results | — |
  | 2 | ambiguous: candidates listed, retry with `--pick <n>`, `--path` or `--all` | `ambiguous_target` |
  | 3 | not found: suggestions and a reason when known | `unresolved_target` |
  | 4 | workspace not mapped: run `ix map` | `workspace_not_mapped` |
  | 1 | any other error (backend down, bad argument, ...) | its own slug |

  `IX_LEGACY_EXIT_CODES=1` makes every non-zero exit `1`, for an integration
  that compares the status against `1`. A hook must not pass ix's status
  through as its own: Claude Code reads a hook's exit `2` as "block this
  action", so an ambiguous name would block the tool call. End the hook with
  its own status (the shipped hooks exit 0), or set `IX_LEGACY_EXIT_CODES=1`.
  One exception in json: `locate`'s ambiguity record carries the slug as
  `code: "ambiguous_target"`, not `error` (it never was an `error` record, and
  readers that treat any string `error` as a failure would drop its
  candidates); it still exits 2.
  One exception in exit code: `read`'s ambiguity (a file or symbol name that
  matches several) exits 0 with its own record, `ambiguous kind=<file|symbol>
  target=... count=<n>` and its candidates (json: `targetType:
  "ambiguous-file"` / `"ambiguous-symbol"`, `candidates`, no `error`), as it
  always has. Retry with `--pick <n>` or `--path`. Its miss exits 3 like the
  rest.
  A file target's miss adds `reason=file_not_in_graph` (on disk, not ingested)
  or `reason=file_not_found`. A symbol's miss says why when the workspace's
  text can: `reason=symbol_file_not_indexed` (the name is only in source files
  the graph does not have), `reason=symbol_not_extracted` (it is in indexed files, named
  with their revision, but not as an entity) or `reason=symbol_not_in_source`
  (it is nowhere in the workspace either), with `files=` naming up to three
  files. Only files `ix map` parses count, so a name that appears only in, say,
  a `.txt` is a plain miss; a command spends at most 5 seconds on these lookups,
  then reports later misses plainly; `IX_MISS_PROBE=0` turns them off. A miss
  under `--kind`, `--path` or the test filter, where an entity of that name
  exists outside the filter, is a plain miss too (no `reason`): drop or change
  the filter. Any miss may carry
  `suggestion` records with the nearest names in the graph (`locate` included),
  and a miss on an empty or degraded graph carries a `graph` record saying so.
  A graph read from a directory no registered workspace covers is
  `workspace_not_mapped`, with `dir=` and a `hint=` naming the command that
  maps it.
  An ambiguous graph target is instead `ambiguous_target`, includes numbered
  candidates, and exits non-zero because the requested graph operation could
  not choose a target. The error also carries `shown=<n> total=<m>` after
  `count=` (and `truncated=true` when the search window came back full, so
  `total` is a lower bound); json has `total` and `truncated` beside
  `candidates`. Candidates are numbered in (path, line, id) order, so
  `--pick <n>` means the same thing on every run. (The
  backend spells a missing target `unknown_target` in its own JSON bodies; that
  is a wire detail and is translated on the way out, so a consumer never sees
  both.)

### Every candidate at once (`--all`)

`callers`, `callees` and `impact` take `--all`: an ambiguous name is answered
for every listed candidate (exit 0) instead of exiting 2. Edge rows are one
union, paged by `--limit`/`--offset`, and each carries the candidate it belongs
to; json has `resolutionMode: "all"`, a `candidates` list and `candidate` on
each row:

```
callers target=handle shown=3 total=3 resolved=3 candidates=2
candidate n=1 name=handle kind=function path=src/a.ts id=1111aaaa
candidate n=2 name=handle kind=function path=src/b.ts id=2222bbbb
ref name=route kind=function path=src/server.ts lines=10-30 candidate=1
ref name=retry kind=function path=src/jobs.ts lines=4-9 candidate=2
```

`impact --all` prints one analysis per candidate, each after its `candidate`
record (json: `results: [{ candidate, ... }]`). Tied candidates past the 8 an
ambiguity error lists are covered too (those 8 keep their `--pick` numbers; the
rest follow, and `--pick <n>` reaches them by the same numbers), up to 25 per
call: past that, only the first 25 are answered and a `candidates_truncated`
diagnostic says so. An import of the name (`from app.utils import clamp`) is listed in
an ambiguity but skipped by `--all` when a definition is listed too, so the
numbers can skip it; when only imports are listed, they are answered. The search window is bounded (up to 200 names with `--path`, fewer
without); the same diagnostic says when it was cut off. Narrow
with `--kind` or `--path` to keep the run small. `--pick` takes precedence over
`--all`.

### Several targets (`ix locate a b c`, `ix callers a b c`)

Each target is answered as it would be alone, grouped: llm opens each group
with `target n=<i> name=<t>` and ends with
`targets total=<n> ok=<n> [ambiguous=<n>] [not_found=<n>] [not_mapped=<n>] [failed=<n>]`;
json is `{ targets: [{ target, exitCode, ...answer }], summary }`. The run exits
with the worst target's code (error, then workspace not mapped, then not
found, then ambiguous), so a partial answer never exits 0. The summary counts
each target by its outcome, so it reads the same under `IX_LEGACY_EXIT_CODES=1`.

### Resolution notices (exit 0)

When a target resolves by choosing among equal candidates, or by a fuzzy match,
the command still succeeds. It says so with `diagnostic` records, never an
`error` record, printed before the command's own first record (so before a
`context` header):

```
diagnostic code=ambiguous_target target=index.ts chosen=index.ts shown=3 total=3 message="..."
candidate n=1 name=index.ts kind=file path=packages/a/src/index.ts id=1111aaaa
candidate n=2 name=index.ts kind=file path=packages/b/src/index.ts id=2222bbbb
hint text="Use --pick <n> or --path to choose another."
```

The candidates are only the true ties: the ones that scored the same as the
chosen target. `shown=`, `total=` and `--pick <n>` all count that same list.
Candidates that scored close but lower are not listed as equal; the message
only counts them ("2 more scored lower and are not listed"). `--pick <n>`
selects among the tied candidates, the listed ones first and the rest in the
order `--all` numbers them; an out-of-range pick keeps the
default and adds a `pick_out_of_range` diagnostic, still exiting 0.

`Class.method` and `Class#method` resolve only to a member of that class: one
of the class's `CONTAINS` children in the graph or, when the graph has none
for it, a symbol in the class's own source file (the same path, not a
substring of it). A same-named method elsewhere is not returned: the target is
a miss instead, unless the name as typed matches something fuzzily, which
resolves as a fuzzy match (exit 0). A name whose last part is a file extension
(`Response.json`, `Template.html`, `Tree.go`) is a file when a file has exactly
that name, and otherwise gets the same class-member reading.

A match on a name that is not an exact one, or a path that ends in the target
without a `/` before it (`site/package.json` matching `docs-site/package.json`),
is `diagnostic code=fuzzy_match resolution=fuzzy ...`, and json carries
`resolutionMode: "fuzzy"`. In json the
notices are a top-level `resolutionNotices` array merged into the command's
object; an `{error}` record never carries one.

## Graph health

`explain` and `context` check that the graph they answer from still has its
structure (`ix-cli/src/cli/graph-health.ts`). When it does not, a `graph`
record comes first (right after the header for `context`), the `context`
header carries `graph=degraded classification=degraded` instead of `stale=`,
and `explain` withholds what it would infer from the missing edges:

```
graph status=degraded reason=hollow message="9243 nodes but 387 edges: 1% of symbols are attached to a file (healthy: ~100%), so callers, callees and members are missing, not zero. ..." fix="ix reset --workspace --yes --ingest"
entity id=9dbdebd9 name=parseBudgetOption kind=function path=ix-cli/src/cli/options.ts rev=1243
role role=unknown confidence=none reason=graph_degraded
importance level=unknown reason=graph_degraded
edges callers=unknown callees=unknown dependents=unknown importers=unknown members=unknown downstream=unknown depth=1 history=1 complete=false
```

A non-zero count on a degraded graph is still an edge that exists, so it is a
floor; a zero is `unknown`. `reason=orphaned_target` is the same verdict for
one entity whose file lost its edges while the rest of the graph looks fine.
`--format json` carries the verdict as a top-level `graph` object.

## Hierarchies

Hierarchical data (e.g. `ix map` regions) is emitted flat, one record per line,
with an explicit `parent=<id>` field. Trees are re-treeable on the consumer
side from `id` / `parent=` alone. This keeps the "no significant whitespace"
invariant and survives pipe truncation.

```
region id=root kind=system label="Cli"
region id=cli kind=subsystem label="Client" parent=root
region id=srv kind=subsystem label="Server" parent=root
```

## Bounded lists

Any command that cuts its answer to `--limit` says both numbers on its header
record: `shown` is what follows, `total` is what there was before the cut.

```
callers target=verify_token shown=50 total=212 resolved=48 unresolved=2
diagnostic code=results_truncated next_offset=50 message="212 callers; showing 50. next: ix callers --offset 50 verify_token"
```

A list that can be paged says where the next page starts: `next_offset=` on
the `results_truncated` diagnostic, and a `next:` command in its message that
repeats the caller's flags with `--offset`. A page past the first carries
`offset=` on its header. A page that starts at or past the end is not an
error: it prints a `diagnostic code=offset_past_end` and exits 0.

The edge commands page over what one `/v1/expand` call returns, and the
server stops at 1000 edges. When it reports a cut, or returns a full 1000,
`total` is a floor: the list stays `results_truncated` on every page, its
message says "At least N" and names the cap, no offset is called past the
end, and the JSON summary carries `capped: true`. Past the cap, narrow the
target (`--kind`, `--path`) instead of paging.

```
callers target=verify_token offset=50 shown=50 total=212 resolved=50
diagnostic code=results_truncated next_offset=100 message="212 callers; showing 51-100. next: ix callers --offset 100 verify_token"
```

The `next:` text is for whoever reads it: over MCP it is the tool's own
input (`next: offset=50`), not a CLI command. A command with no `--offset`
never prints `next:`; its message says `Raise --limit to see them.`

`shown < total` is the only signal that a list is partial, and it exists
because the header used to carry a single `total` field holding the length of
the *cut* list — so `ix callers` on a symbol with 212 callers reported
`total=50`, which reads as "this symbol has 50 callers".

Two commands cannot know a true total and say so rather than inventing one:

- `ix inventory` reports `shown=N truncated=true`. The backend applies the
  limit and has no count endpoint, so the CLI only knows the window it asked
  for came back full. Its truncation message says "More than N" rather than
  a total. `/v1/list` has no offset either, so `--offset N` fetches the N rows
  before the page too: a deep page costs O(offset). The server returns at
  most 5000 rows, so no page reaches past row 5000: a page at or beyond it
  stays `truncated=true` (JSON: `capped: true`) and says to narrow with
  `--path`, never `offset_past_end`. The server lists newest first, so
  pages are stable only between ingests: an ingest while paging shifts later
  pages, and rows can repeat or be skipped.
- `ix text` reports `shown=N scanned=M`: ripgrep's traversal is bounded by a
  scan window, and `scanned` is how many matches were ranked, not how many
  exist. The window holds the best `scanWindow(limit, offset)` matches (code,
  then tests, then prose; then path; then line) over every match ripgrep
  finds, so the output is the same on every run. The window looks
  `5 × --limit` rows past the page's offset, and stops at 500 rows; a wider
  window only appends rows, so pages line up. Keep `--limit` fixed while
  paging (it is also ripgrep's per-file match cap). The page that reaches the end of a full
  window has no `next_offset=`; its message says to narrow with `--path` or
  `--language` instead, and so does a page past a full window (it is not
  `offset_past_end`: more matches exist). `--format json` stays a bare array of matches with no
  paging fields; the next offset is the offset plus its length.

`ix read` caps a read at 400 lines and marks the `file` record with
`truncated=true total_lines=<n> next=<target>`. `total_lines` is always a
count, never a line number:

- `target=file`: the lines in the file, and `next=<path>:<from>-<to>`.
- `target=symbol`: the lines in the symbol's whole span, not the file. The
  record also carries `span_end=<n>`, the symbol's last line, and
  `next=<path>:<first>-<last>@<from>`: the symbol's span, resumed at `<from>`.
  A span the graph places past EOF is clamped to the file first.

A plain `path:a-b` is a range you typed and is never capped. A `path:a-b@from`
cursor is capped again, and its record (`target=file-range`) repeats the same
`total_lines`, `span_end` and a further `next=`, so following `next=` until it
is absent reaches the symbol's last line. A cursor's path is relative to the
workspace root, which is what `ix read` resolves it against, so it works from
any directory inside the workspace:

```
file path=src/big.ts line_start=10 line_end=409 target=symbol symbol=bigFn kind=function truncated=true total_lines=1318 span_end=1327 next=src/big.ts:10-1327@410
file path=src/big.ts line_start=410 line_end=809 target=file-range truncated=true total_lines=1318 span_end=1327 next=src/big.ts:10-1327@810
```

## Rows an agent acts on

The rows below are the ones an agent reads and then opens, cites or edits, so
each carries the location it will need next rather than leaving it to a
second `grep` or `read`.

`ix search <term>` — every row has `path=` and, for anything smaller than a
file, `lines=`:

```
search count=1 candidates=30
node name=resolveWorkspaceRoot kind=function path=ix-cli/src/cli/config.ts lines=320-340 score=0.83
```

A row that matched on a claim or its provenance rather than its name carries
`match=<source>`, and such rows are dropped entirely when some row matched the
name exactly. An empty result is followed by one `hint` record saying what to
try — a multi-word term is the usual cause, since search matches names:

```
search count=0 candidates=0
hint text="search matches one identifier by name, not a phrase. Search one word (e.g. workspace), or use ix text for a phrase."
```

`ix callers|callees|imports|imported-by` — `path=`/`lines=` say where the
entity at the other end is defined; `site=` says where the edge itself is:

```
callers target=resolveWorkspaceRoot shown=2 total=2 resolved=2
ref name=ingestFiles kind=function path=ix-cli/src/cli/commands/ingest.ts lines=1366-3660 site=ix-cli/src/cli/commands/ingest.ts:1496 snippet=": nodePath.resolve(resolveWorkspaceRoot(opts.root), path);"
ref name=registerCallersCommand kind=function path=ix-cli/src/cli/commands/callers.ts lines=15-141 site=ix-cli/src/cli/commands/callers.ts:43 also=135 snippet="const root = resolveWorkspaceRoot();"
```

| relation | `site=` is |
|---|---|
| `callers` | the call to the target, inside the caller's span |
| `callees` | the call to the row, inside the target's span (the target's file) |
| `imported-by` | the import of the target, in the importing file |
| `imports` | the import of the row, in the target's file |

`also=` lists further sites in the same scope (at most four), and `snippet=`
is the site's line, with up to two continuation lines of a call left open.
The graph does not record call sites — a CALLS edge carries no line — so the
CLI finds them in the file on disk: it re-anchors the graph's span to where the
entity is declared now (a file edited since the last ingest has moved under
it), then prefers call syntax (`name(`, `name<T>(`, `new Name`) over a bare
use, skipping comments and the name's own declaration. A row whose file is
missing, outside the workspace, or has no findable use simply has no `site=`.
`--format json` carries the same object as `site: {path, line, snippet, also}`.

`ix callers` on a Java method also lists the callers that reach it through a
supertype. For a target `C.m`, it walks `C`'s superclasses and interfaces (up
to five levels) and adds the callers of each one's own `m`: a call typed
against the interface or superclass can run `C.m`. Such a row ends with
`via=<Supertype>.<m>`, the member the call names; json adds `via` to the row.
Direct rows come first and carry no `via`; a caller that is both is listed
once, as a direct row. `shown`/`total` count every row, and `--all` adds the
same rows per candidate. A call typed directly against the interface is a
plain caller of the interface method, with no `via`.

```
callers target=getUrl shown=2 total=2 resolved=2
ref name=invoke kind=method path=src/rpc/Filter.java lines=10-24
ref name=select kind=method path=src/cluster/Cluster.java lines=30-41 via=Invoker.getUrl
```

`ix overrides <method>` (alias `ix implementations`) lists the other
definitions of a method, the ones that move with it when its signature or
behaviour changes. The header names the target as `<Type>.<method>`, the type
that contains it (`owner=`) and the farthest supertype that declares the
method (`root=`). Then one `override` record per definition:

```
overrides target=Mid.m owner=Mid root=Base.m shown=3 total=3
override name=m relation=overrides owner=Base kind=method path=pkg/base.py lines=3-5 depth=1
override name=m relation=overridden_by owner=Leaf kind=method path=pkg/leaf.py lines=5-7 depth=1
override name=m relation=sibling owner=Other kind=method path=pkg/other.py lines=7-9 depth=1 via=Base.m
```

`relation` is `overrides` (declared on a supertype) or `implements` (the
supertype's kind is interface, trait or protocol; a graph that stores the
base as a class says `overrides`), `overridden_by` (declared on a subtype), or
`sibling` (declared on another subtype of the root, `via=<Root>.<method>`).
`depth` counts levels from the target's type for up and down rows, and from
the root for siblings. Rows are ordered by relation, then depth, then path.
Matching is by name through `EXTENDS` (which carries `implements`) and
`CONTAINS` edges, never by signature; each type is a graph id, so a
same-named class in another file is not in the family. Diagnostics:

- `no_owner_type`: the target is not a member of a class, interface or trait
  (a free function). No rows, exit 0.
- `hierarchy_truncated cap=depth|types|edges`: a walk stopped at 5 levels, at
  32 types (16 of them supertypes), or at the server's edge cap. The header
  carries `truncated=true`.
- `overloads_not_distinguished`: in Java, Kotlin, C#, Scala or C++, a matched
  type declares the method more than once; check each row's parameters.
- `heritage_not_in_graph`: the type has no `EXTENDS` edge but its header names
  a base, so the map may predate heritage capture; re-map.

`--format json` carries `{target, resolvedTarget, owner, root, rows, total,
truncated, diagnostics}`; each row is `{name, kind, id, path, lineStart,
lineEnd, owner: {name, kind, id}, relation, depth, via?}`. Over MCP it is
`ix_neighbors relation=overrides` or `ix_overrides`.

`ix around <path>[:<line>]` — the dependents of the code at a location, sized
for an agent's context (`--budget`, default 300 tokens):

```
around path=ix-cli/src/cli/options.ts lines=90 symbols=1
symbol name=parsePickOption kind=function path=ix-cli/src/cli/options.ts lines=90-92 callers=0 users=14 tests=1
user site=ix-cli/src/cli/commands/subsystems.ts:70 snippet=".option(\"--pick <n>\", \"Resolve an ambiguous region target by numbered candidate\", parsePickOption)"
user site=ix-cli/src/cli/commands/diff.ts:473 snippet=".option(\"--pick <n>\", \"Pick Nth candidate from ambiguous results (1-based)\", parsePickOption)"
test site=ix-cli/src/cli/__tests__/pick-option-validation.test.ts:52 snippet="expect(() => parsePickOption(value)).toThrow(\"must be a positive integer\");"
importers shown=0 total=17 tests=2
```

(Three `user` rows are left out above.) A `symbol` record carries the totals
(`callers`, `users`, `tests`); the `caller` / `user` / `test` / `same_name`
rows after it are the ones shown, so fewer rows than a total means the list
was cut to the budget. With more than one symbol each row names its own with
`of=`. `caller` is a CALLS/REFERENCES edge at its call site; `user` is a file
that imports this one, names the symbol in that import, and uses it -- found
on disk, so it also catches a function handed over by name, which no edge
records; `test` is a test file that calls it, calls a caller of it (`via=`
that caller), or imports and uses it. `importers` counts every file importing
this one; its `importer` rows are the first cut when the answer is over
budget. Empty lists print no rows. On a degraded graph a `graph` record
follows the header and the totals are floors.

`ix text <pattern>` — `match path=... line=... symbol=... snippet=...`. No
`lang=`: the extension on `path` says it; `--format json` keeps `language`.

## Examples

`ix map`:

```
map files=412 regions=9 levels=2 rev=1043 outcome=full_local_completed files_too_large=2
too_large path=data/fixtures/large.json
too_large path=vendor/bundle.js
region id=3f9c1a2b kind=system label=Ix level=2 files=412 children=2 cohesion=0.41 coupling=0 confidence=0.9
region id=7d02e4c1 kind=subsystem label="Cli / Client" level=1 files=87 parent=3f9c1a2b cohesion=0.62 coupling=4.1 confidence=0.74 signals=imports,calls
```

The `map` record carries `parse_errors`, `commit_errors` and `files_too_large`
only when they are non-zero, so a clean map says nothing about them.
`files_too_large` counts the files over the 1 MB parse limit, which were left
out of the graph. Up to 20 of them follow as `too_large` rows, sorted by path,
before the regions. A count above the number of rows means the rest were not
listed. `--format json` carries the same two things as `files_too_large`
and `files_too_large_paths`, and has them on every map: zero and an empty list
when no file was too large. `ix map --silent` adds `too_large=N` to its one
line.

An `ix map` you (or an agent) run always computes the map, and clears a
stale one. The automatic `ix map` the editor/agent hooks and `ix watch` run
after an edit (they set `IX_AUTO_MAP=1`) ingests the change but defers the
map itself: it prints the last computed map's regions and marks the `map` record
`map_stale=true` (only when true, so a fresh map says nothing). `files`,
`regions`, `levels`, `rev`, `outcome` and the `region` records are then the
last map's, not this ingest's, and `regions_as_of_rev` and
`regions_as_of_files` name that map (both only when stale). A
`diagnostic code=map_stale` record follows the `map` record and says the
same in a sentence. The next region view (`overview`, `subsystems`,
`locate`, `impact`, `explain`, `view`) never maps inline: it answers from
the last map, says so in one line on stderr
(`ix: architecture map is stale (<why>); ...`), and starts a detached
background refresh unless one ran moments ago or another `ix map` holds the
lock. `ix map --remap` recomputes the map at once, even from an automatic
run; `IX_MAP_EAGER=1` makes automatic runs compute too, as before; `IX_MAP_BACKGROUND_REFRESH=0` stops region
views starting a refresh. `--format json` carries `map_stale` on every map (`false` when fresh) and
`regions_as_of` (`{map_rev, file_count}` of the last map, `null` when
fresh); `ix map --silent` ends its line with `· map=stale`.

The region views say it in their machine output too, not only on stderr.
While the map is stale, `overview`, `subsystems`, `locate`, `impact` and
`explain` print one `diagnostic code=map_stale` record, worded as `ix map`'s,
with their answer (just before its first record), and their `--format json`
object gains `map_stale: true` and, when the deferring `ix map` recorded which
map it was, `regions_as_of` (`{map_rev, file_count}`, as above) at its top
level. A fresh map adds neither key and no record. An error answer carries
neither: it is its own answer, and a caller takes a leading `error` record as
the command failing. `ix locate` with several targets prints the record once
per call and puts the keys on each answered target's object; `ix impact --all`
puts them on the grouping object. Text output only has the stderr line.

`ix stats`:

```
nodes total=98979 method=49180 module=38199 class=6833 file=3285
edges total=354283 CALLS=177418 CONTAINS=57163 IMPORTS=38199
```

`ix subsystems --list`:

```
subsystems count=2
region id=cli-client label="Cli / Client" kind=subsystem level=2 files=87 health=0.62 chunks_per_file=4.1 smells=3 confidence=0.88
region id=ingestion-parsers label="Ingestion / Parsers" kind=subsystem level=2 files=212 health=0.71 confidence=0.74
```

`ix smells`:

```
smells rev=42 count=2 shown=2 version=smell_v1
smell kind=has_smell.god_module file=Region.scala confidence=0.91 chunks=42 fan_in=18 fan_out=9
smell kind=has_smell.orphan_file file=tmp.py confidence=0.8 connections=0
```

`count` is the number of candidates after non-source orphan files (docs,
templates, data/config) are dropped; `filtered_non_source=<k>` appears when any
were. Output stops at `--limit` (default 50, highest confidence first); when it
cuts, a `diagnostic code=results_truncated` record follows the header.

`ix impact <leaf>`:

```
impact target=verify_token kind=function risk=high category=boundary summary="Auth check; 14 call sites at risk"
behavior text="Token validation across the request pipeline"
counts callers=14 callees=3 shown_callers=10 shown_callees=3
bucket region="Auth Layer" kind=subsystem count=9
caller name=handleLogin kind=method path=src/auth/login.ts lines=20-48
diagnostic code=results_truncated message="14 callers; showing 10. Raise --limit to see them, or page them with ix callers verify_token"
```

`callers` and `callees` are the true totals; `shown_callers` and `shown_callees` are the rows
printed after the `--limit` cut (the two lists share one header, so `shown`/`total` are split by list).
`ix impact` has no `--offset`, so its truncation diagnostic carries no `next_offset=`; it points at
`ix callers`/`ix callees` (over MCP, `ix_neighbors`), which page.
In `--format json` the same rows (`callerList`, `calleeList`, bucket `members`) carry `path`,
`lineStart` and `lineEnd`, and a container target's JSON adds `dependentList`, its located
importers and dependents.

`ix overview <container>`:

```
overview target=IngestionService kind=class file=src/ingest.ts system_path=Ingestion,Parsers
contains method=12 field=4
item name=parseFile kind=method
```

`ix context <target>`:

```
context target=Widget target_kind=class target_path=src/widget.ts stale=false classification=current entities=2 relationships=1 claims=1 decisions=0 conflicts=0 intents=0 evidence=7 truncated_entities=0 truncated_relationships=0 truncated_evidence=0 truncated_chars=0
evidence score=0 kind=target title="Widget (class)" path=src/widget.ts
evidence score=2000 kind=structural title="member render" path=src/widget.ts lines=12-40
evidence score=3000 kind=claim title="renders to DOM"
evidence score=4000 kind=relationship title="Widget --calls--> mount"
```

One header record, then the ranked evidence. `score` is `tier * 1000` plus the
row's place in its tier, tiers in order target, issue, structural, claims,
relationships, provenance, so a tier never runs into the next. Each entity gets
one row: a relationship that restates a member, import or caller row is left
out. A target's callers and dependents share one row, titled with how many of
how many (`used by (3 of 214): ...`); `--format json` carries the two numbers
as `count: { shown, total }`. The entity, relationship and claim
lists stay counts here — `llm` is the token-minimal surface and the ranked
evidence is what it exists to deliver; `--format json` carries the rest.

`path=` and `lines=` say where an item is defined, when the graph knows, so a
reader can open it instead of searching for it. For a file target, members are
ranked by use — those used from other files first — so the ones that survive
the evidence budget are the ones worth reading. Relationship titles name their
endpoints; a name shared by two entities in the bundle is qualified with its
path, and the ids stay in the `relationship` records.

`ix context --diff <id>`:

```
diff investigation=widget target=Widget saved_at=2026-01-03T09:12:44.108Z generated_at=2026-01-19T11:02:07.441Z freshness_previous=current freshness_current=stale
budgets scope=saved entities=50 relationships=100 evidence=25 chars=12000
budgets scope=requested entities=10 applied=false
budgets scope=effective entities=50 relationships=100 evidence=25 chars=12000
count added_entities=1 removed_entities=0 added_relationships=1 removed_relationships=1 added_evidence=2 removed_evidence=1 added_claims=1 removed_claims=0
entity change=added id=entity-3 kind=method name=mount path=src/widget.ts
relationship change=removed src=entity-1 pred=calls dst=entity-2
evidence change=added score=4000 kind=relationship title="Widget --holds--> mount"
claim change=added id=c-8f31a2 entity=entity-1 status=active statement="mounts to DOM"
```

The counts keep their zeros: "nothing was added" is the answer `--diff` was
asked for, not a default worth dropping. Added and removed share one record
kind and separate on `change=`, so a consumer routing on `entity` sees both
sides of the comparison.

`saved_at` is when the baseline snapshot was taken. `freshness_previous` says
whether it was fresh *then*, not how long ago that was, so a snapshot from five
minutes ago and one from three months ago read identically without it.

The three `budgets` records say which limits governed the comparison.
`scope=saved` is the saved investigation's, `scope=effective` is what the fresh
bundle was actually built with, and `scope=requested` appears only when
`--max-*` flags were passed — carrying `applied=`, because saved budgets govern
`--diff` and a flag that changed nothing is worth saying so in a field a
consumer can test.

An `entity` record carries `id=` because `relationship` records name their
endpoints by entity id; without it `src=`/`dst=` resolve to nothing the reader
has seen. A `claim` record carries `statement=` for the same reason its `id=`
is not enough: the id is the backend's, and the statement is what changed.

`ix context --list`:

```
investigations total=2 skipped=1
investigation id=widget saved_at=2026-01-03T09:12:44.108Z target=Widget target_kind=class classification=current stale=false entities=12 relationships=20 evidence=8 truncated_entities=0 truncated_relationships=0 truncated_evidence=0 truncated_chars=0
investigation id=auth-path saved_at=2026-01-02T17:03:11.882Z target=verify_token target_kind=function classification=stale stale=true entities=31 relationships=64 evidence=25 truncated_entities=0 truncated_relationships=0 truncated_evidence=4 truncated_chars=0
```

`skipped` counts saved files that did not match the contract and is present
only when it is non-zero — it is the one thing about a listing that cannot be
seen from the records themselves. Note that `stale=` and the four `truncated_*`
fields are *not* dropped when zero or false: `llmField` omits only nullish and
empty-string values, and these say "measured, and it was none", which a missing
field does not.

`id` is the id `--resume` and `--diff` take, not necessarily the file name on
disk; the two differ whenever an id contains a character outside
`[A-Za-z0-9._-]`. Both forms load, because the encoding is not always
reversible — above U+00FF the escape width is ambiguous, and the listing shows
the stored name rather than guess.

The counts describe each bundle; the bundles themselves are not in the listing,
and `ix context --resume <id>` fetches one:

```
resumed id=widget saved_at=2026-01-03T09:12:44.108Z
context target=Widget target_kind=class stale=false classification=current entities=2 relationships=1 claims=1 decisions=0 conflicts=0 intents=0 evidence=7 truncated_entities=0 truncated_relationships=0 truncated_evidence=0 truncated_chars=0
evidence score=0 kind=target title="Widget (class)"
```

`resumed`, not `investigation`: the record kinds are distinct because the
shapes are, and a consumer routing on the kind should not have to guess which
of two field sets it is holding. `saved_at` is on it because the `context`
record that follows says whether the snapshot was fresh when it was taken, not
when that was.

`ix savings --detail`:

```
savings model="Claude Opus ($15/MTok in, $75/MTok out)"
scope name=session commands=726 tokens_saved=832739 naive_tokens=1099164 actual_tokens=266425 money_saved=27.48 water_saved_ml=1665.478
command scope=session name=callers count=329 tokens_saved=334995
scope name=lifetime commands=4820 tokens_saved=6142880 naive_tokens=8003104 actual_tokens=1860224 money_saved=202.72 water_saved_ml=12285.76
command scope=lifetime name=callers count=2104 tokens_saved=2210488
```

(Truncated: one `command` record is shown per scope, and a real run emits one
per entry in that scope's breakdown.)

The two `scope` records are always emitted; `command` records appear only under
`--detail` and carry their own `scope=` because both scopes are broken down in
one stream. They are emitted inside the scope loop, so they follow their own
`scope` record rather than being grouped at the end — a parser reading the
stream in order sees session's breakdown before the lifetime `scope` line.

`money_saved` is the only field `--model` moves — the token and water figures
are model-independent.

Error line:

```
error code=unresolved_target message="No entity named 'IngestionService' found" suggestions=Ingestion,Service
```

## Status

Renderers shipped: Tier 1 (`map`, `subsystems`, `impact`, `smells`,
`overview`) plus `stats`; Tier 2 (`inventory`, `rank`, `depends`, `trace`,
`contains`, `callers`, `callees`, `imports`, `imported-by`, `overrides`); Tier 3 (`search`,
`text`, `history`, `patches`); Tier 4 (`entity`, `locate`, `diff`,
`conflicts`); Tier 5 (`explain`, `read`, `status`, `doctor`, `savings`).

Tier 5 closes the prose fallback. Those five routed `--format llm` to `text` on
the theory that verbatim source and prose have no record form, which is true of
the *payload* but not of what surrounds it — `explain`'s prose is a rendering of
facts the agent can have directly, and `read`'s source was arriving under a
per-line number gutter and ANSI escapes. `explain` is the one that mattered
most: it is the first call most plugins make, and its records are ~55% smaller
than the `--format json` that `text` sent people to as a workaround.

Two deliberate exceptions remain:

- **`read`'s content block is not records.** An agent asked for source, so
  the payload follows a `content lines=<n> numbered=true` record that makes
  the block self-delimiting, one source line per line, each prefixed with its
  file line number and a tab — the `cat -n` shape, without the padding or the
  ANSI of `--format text`:

  ```
  file path=src/auth.py line_start=10 line_end=11 target=symbol symbol=verify kind=function
  content lines=2 numbered=true
  10	def verify():
  11	    return True
  ```

  The numbers are what let an agent cite or edit a line without reading the
  file again through a tool that numbers it. Strip everything up to the first
  tab to get the source byte-for-byte. This is the only place the
  one-record-per-line invariant is relaxed, and the count is what lets a
  consumer relax it safely.
- **`status` is not smaller** — it is within a byte or two of `json`, because
  the payload is a handful of scalars either way. It is in Tier 5 for its
  explicit boolean fields, which are the questions the command gets called to
  answer and which `text` only implied through warning lines:

  ```
  status backend=ok endpoint=http://localhost:8090 graph_health=ok graph_complete=true map_complete=false rev=2467 last_ingest_at=2026-08-29T01:38:43.341Z stale_files=0 stale=false
  ```

  `graph_complete` and `map_complete` are two different questions and a
  workspace can sit at `true`/`false`. The source graph is ingested and current
  — search, `read`, `context` and `explain` all answer from it — while no
  architecture hierarchy has been recorded for that revision, so `map`,
  `subsystems` and region-scoped views may be empty or stale. `stale` follows
  `graph_complete`, not `map_complete`: it is a claim about files having
  changed, and a missing hierarchy does not make a file out of date.

  `map_stale=true` (only when true) says why `map_complete` is false right
  after an edit: the last automatic `ix map` deferred the map, and the
  hierarchy is the last computed one until the next region view or `ix map`
  refreshes it. `--format json` carries it as `mapStale`, always present.

  `graph_health` is a third, separate question: whether the graph the backend
  holds for this workspace is whole (`ok`), has nodes but lost their edges
  (`degraded`, followed by a `graph` record with the fix), holds nothing
  (`empty`), or could not be checked (`unverified`: no workspace here, an older
  backend, a slow stats read). `stale=false` says no file changed since the
  last ingest; it does not vouch for the graph.

  When a whole-root `ix verify` (no paths) has run for this workspace, the
  `status` record ends with what it found: `verified_at` (ISO),
  `verified_files`, `verified_diverged`, `verified_outdated` and
  `verified_graph` (`clean`, `stale`, `diverged` or `unverified`; a stale or
  unverified record's `verified_diverged=0` is not a pass). Only that
  command saves the record: `ix verify <path>` and `ix doctor` do not.
  `verified_outdated=true` means the workspace was ingested after that verify
  ran, so its counts describe an earlier graph; run `ix verify` again rather
  than act on them. `status` only reads the record; it never runs a verify.
  With no record the five fields are absent and the line is unchanged.

`verify` answers whether the graph's nodes match the source they came from. One
`verify` record, then one `file` record per file that is not clean:

```
verify graph=diverged files=20 clean=18 stale=1 diverged=1 unverified=0 fix="ix reset --workspace --yes --ingest"
file path=src/a.ts state=stale reason=changed_since_ingest missing=0 extra=1 changed=2
file path=src/b.ts state=diverged missing=3 extra=0 changed=0
```

`graph` is the first of these that holds: `diverged` when any file diverged;
`stale` (fix `ix map`) when any file is stale, even beside clean ones, since a
stale file's nodes could not be checked against its source; `clean` when at
least one file was judged clean; otherwise `unverified` (with a `reason`: `not_mapped`,
`extractor_changed`, `parser_unavailable`, `no_files` when nothing could be
sampled, `no_file_verified` when nothing sampled could be judged, `timed_out`
when `ix doctor`'s time budget ran out before any file was judged).

A file is judged by its nodes and by the backend's source hash for it, which
is the hash of the file's newest stored patch:

- `diverged`: the nodes do not match a re-parse, and the graph claims these
  bytes: the stored hash equals the disk hash (nodes left behind or lost), or
  the last map listed the file as not applied (`not_applied` in `status`, F-01:
  a revert the backend answered `Idempotent`, so the newest patch is still the
  edit in between) and it has not changed since (`reason=replayed_not_applied`).
- `stale` (`reason=changed_since_ingest`): the stored hash is not the disk hash.
  Usually an edit since the last map, fixed by `ix map`. An F-01 revert that the
  last map did not record as not applied looks exactly like this, so verify
  reports it as stale, not diverged. `missing_on_disk` is a deleted file the
  graph still has; `not_file` is a path the graph has that is now a
  directory or another non-regular file.
- `unverified`, with a `reason`: `not_in_graph` (no stored hash and no nodes:
  ingest skips some files), `parse_timed_out` (the last map's parse ran out of
  budget), `too_large` (over ingest's 1 MB limit), `missing_on_disk` (a named
  path that does not exist), `not_file` (a named path that is a directory or
  another non-regular file), `unsupported_language`,
  `no_parse`, `list_failed`, `truncated`, `hash_unknown` (the hash lookup
  failed and the nodes differ), `no_comparison`.

A stale file does not make the graph diverged, and does not let it be clean.
Unverified files beside clean ones do not stop a `clean` verdict; they are
counted. Nodes only: edges are not compared. The command exits 0 for every
verdict.

Still routing to `text`: `diff --content` (verbatim hunks) and `ingest`, a
hidden implementation-detail command whose output is a completion summary.

Programmatic consumers that need to parse output should continue to use
`--format json`; the `llm` format is optimized for being read by a model, not
parsed.
