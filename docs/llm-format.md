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

## Wire format

- **One record per line.** Newline-delimited, no nesting.
- **Scalars:** `key=value` pairs separated by a single space.
- **Tabular rows:** a leading `record-kind` token, then `key=value` pairs:
  `region id=cli kind=subsystem label="Cli / Client" level=2 files=87`.
- **No decorative whitespace, separators, or headers.**
- **Omitted fields:** null, undefined, and empty values are dropped. Zeros and
  other defaults are dropped where they carry no signal.
- **Quoting:** a value containing a space, `=`, `"`, `\`, or a control
  character is wrapped in double quotes. Inside quotes, `"` and `\` are
  backslash-escaped and newline / carriage-return / tab are encoded as `\n` /
  `\r` / `\t`, so a record never spans more than one line.
- **Errors:** a uniform `error code=<slug> message="..."` line in the same
  format as data lines; the process still exits non-zero. A target that does
  not exist is always `unresolved_target`, whichever command was asked —
  `context`, `explain`, `read`, `locate`, `subsystems`, `trace`. (The backend
  spells the same condition `unknown_target` in its own JSON bodies; that is a
  wire detail and is translated on the way out, so a consumer never sees both.)

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

## Examples

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
context target=Widget target_kind=class stale=false classification=current entities=2 relationships=1 claims=1 decisions=0 conflicts=0 intents=0 evidence=7 truncated_entities=0 truncated_relationships=0 truncated_evidence=0 truncated_chars=0
evidence score=0 kind=target title="Widget (class)"
evidence score=20 kind=claim title="renders to DOM"
evidence score=30 kind=relationship title="entity-1 --calls--> entity-2"
```

One header record, then the ranked evidence. The entity, relationship and claim
lists stay counts here — `llm` is the token-minimal surface and the ranked
evidence is what it exists to deliver; `--format json` carries the rest.

`ix context --diff <id>`:

```
diff investigation=widget target=Widget saved_at=2026-01-03T09:12:44.108Z generated_at=2026-01-19T11:02:07.441Z freshness_previous=current freshness_current=stale
budgets scope=saved entities=50 relationships=100 evidence=25 chars=12000
budgets scope=requested entities=10 applied=false
budgets scope=effective entities=50 relationships=100 evidence=25 chars=12000
count added_entities=1 removed_entities=0 added_relationships=1 removed_relationships=1 added_evidence=2 removed_evidence=1 added_claims=1 removed_claims=0
entity change=added id=entity-3 kind=method name=mount path=src/widget.ts
relationship change=removed src=entity-1 pred=calls dst=entity-2
evidence change=added score=30 kind=relationship title="entity-1 --holds--> entity-3"
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

- **`read`'s content block is not records.** An agent asked for source and wants
  it byte-for-byte, so the payload is emitted raw after a `content lines=<n>`
  record that makes the block self-delimiting. This is the only place the
  one-record-per-line invariant is relaxed, and the count is what lets a
  consumer relax it safely.
- **`status` is not smaller** — it is within a byte or two of `json`, because
  the payload is a handful of scalars either way. It is in Tier 5 for its
  explicit boolean fields, which are the questions the command gets called to
  answer and which `text` only implied through warning lines:

  ```
  status backend=ok endpoint=http://localhost:8090 graph_complete=true map_complete=false rev=2467 last_ingest_at=2026-08-29T01:38:43.341Z stale_files=0 stale=false
  ```

  `graph_complete` and `map_complete` are two different questions and a
  workspace can sit at `true`/`false`. The source graph is ingested and current
  — search, `read`, `context` and `explain` all answer from it — while no
  architecture hierarchy has been recorded for that revision, so `map`,
  `subsystems` and region-scoped views may be empty or stale. `stale` follows
  `graph_complete`, not `map_complete`: it is a claim about files having
  changed, and a missing hierarchy does not make a file out of date.

Still routing to `text`: `diff --content` (verbatim hunks) and `ingest`, a
hidden implementation-detail command whose output is a completion summary.

Programmatic consumers that need to parse output should continue to use
`--format json`; the `llm` format is optimized for being read by a model, not
parsed.
