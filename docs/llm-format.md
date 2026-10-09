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
  does not exist is always `unresolved_target`. `locate` is the remaining
  exit-status exception tracked in #539.
  A file target's miss adds `reason=file_not_in_graph` (on disk, not ingested)
  or `reason=file_not_found`, any miss may carry `suggestion` records with the
  nearest names in the graph, and a miss on an empty or degraded graph carries
  a `graph` record saying so.
  A graph read from a directory no registered workspace covers is
  `workspace_not_mapped`, with `dir=` and a `hint=` naming the command that
  maps it.
  An ambiguous graph target is instead `ambiguous_target`, includes numbered
  candidates, and exits non-zero because the requested graph operation could
  not choose a target. (The
  backend spells a missing target `unknown_target` in its own JSON bodies; that
  is a wire detail and is translated on the way out, so a consumer never sees
  both.)

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
diagnostic code=results_truncated message="212 callers; showing 50. Raise --limit to see the rest."
```

`shown < total` is the only signal that a list is partial, and it exists
because the header used to carry a single `total` field holding the length of
the *cut* list — so `ix callers` on a symbol with 212 callers reported
`total=50`, which reads as "this symbol has 50 callers".

Two commands cannot know a true total and say so rather than inventing one:

- `ix inventory` reports `shown=N truncated=true`. The backend applies the
  limit and has no count endpoint, so the CLI only knows the window it asked
  for came back full.
- `ix text` reports `shown=N scanned=M`: ripgrep's traversal is bounded by a
  scan window, and `scanned` is how many matches were ranked, not how many
  exist.

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
smells rev=42 count=2 version=smell_v1
smell kind=has_smell.god_module file=Region.scala confidence=0.91 chunks=42 fan_in=18 fan_out=9
smell kind=has_smell.orphan_file file=tmp.py confidence=0.8 connections=0
```

`ix impact <leaf>`:

```
impact target=verify_token kind=function risk=high category=boundary summary="Auth check; 14 call sites at risk"
behavior text="Token validation across the request pipeline"
counts callers=14 callees=3
bucket region="Auth Layer" kind=subsystem count=9
caller name=handleLogin kind=method
```

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
evidence score=10 kind=structural title="member render" path=src/widget.ts lines=12-40
evidence score=20 kind=claim title="renders to DOM"
evidence score=30 kind=relationship title="Widget --calls--> render"
```

One header record, then the ranked evidence. The entity, relationship and claim
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
evidence change=added score=30 kind=relationship title="Widget --holds--> mount"
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
`contains`, `callers`, `callees`, `imports`, `imported-by`); Tier 3 (`search`,
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

  `graph_health` is a third, separate question: whether the graph the backend
  holds for this workspace is whole (`ok`), has nodes but lost their edges
  (`degraded`, followed by a `graph` record with the fix), holds nothing
  (`empty`), or could not be checked (`unverified`: no workspace here, an older
  backend, a slow stats read). `stale=false` says no file changed since the
  last ingest; it does not vouch for the graph.

Still routing to `text`: `diff --content` (verbatim hunks) and `ingest`, a
hidden implementation-detail command whose output is a completion summary.

Programmatic consumers that need to parse output should continue to use
`--format json`; the `llm` format is optimized for being read by a model, not
parsed.
