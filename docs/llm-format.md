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
  format as data lines; the process still exits non-zero.

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

Error line:

```
error code=unknown_target message="No entity named 'IngestionService' found" suggestions=Ingestion,Service
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
  the payload is a handful of scalars either way. It is in Tier 5 for the
  explicit `stale=true|false` field, which is the question the command gets
  called to answer and which `text` only implied through a warning line.

Still routing to `text`: `diff --content` (verbatim hunks) and `ingest`, a
hidden implementation-detail command whose output is a completion summary.

Programmatic consumers that need to parse output should continue to use
`--format json`; the `llm` format is optimized for being read by a model, not
parsed.
