# Output Formats & Pro Features

## Output formats

Query commands accept `--format text|json|llm`:

- **`--format llm`** — use when reading the result yourself. Token-minimal,
  newline-delimited (`key=value`, one record per line). Smallest output; on
  `ix context` it is roughly a ninth of the same answer in `json`.
- **`--format json`** — use when chaining results between commands or pulling a
  specific field out of a response.
- **`--format text`** — human-oriented tables and trees.

### What an `llm` row already tells you

Each row carries the location you would otherwise grep or re-read for:

- `search` rows: `path=` and `lines=` (e.g. `lines=320-340`). An empty search
  ends in a `hint` record — search matches one identifier, so search a single
  word, or use `ix text` for a phrase.
- `callers`, `callees`, `imports`, `imported-by` rows: `site=path:line` is the
  call or import itself, with `snippet=` (the line) and `also=` (more sites in
  the same scope); `path=`/`lines=` are where the other entity is defined.
  On a Java method, `callers` also lists callers through a superclass or
  interface after the direct ones, each ending `via=<Supertype>.<method>`
  (json: `via`).
- `overrides` rows: `override name=... relation=... owner=<Type> path=...
  lines=... depth=<n>`, where `relation` is `overrides` or `implements` (a
  base declaration), `overridden_by` (below the target) or `sibling` (another
  implementation of a root's method, `via=<Root>.<method>`). The header's
  `root=` is the farthest declaring supertype; `roots=` lists every top one
  when there are several (two interfaces, or a class and an interface).
- `read`: every source line is `<line number><TAB><source>`, after a
  `content lines=<n> numbered=true` record — cite and edit by those numbers.
- `text`: `match path=... line=... snippet=...`.

Ids appear only where two rows would otherwise read the same (same name, kind
and path); pass one back as the symbol to pick that row. `--fields id` prints
them everywhere.

A `diagnostic code=map_stale` record (json: `map_stale: true`, with
`regions_as_of: {map_rev, file_count}` when known) on `ix overview`,
`subsystems`, `locate`, `impact`, `explain` or `map` means the architecture
map was not recomputed after the latest edits: system paths and regions are
the last map's. The answer is still usable; run `ix map --remap` when the
hierarchy itself matters. A fresh map adds neither.

### Setting it once

Resolution is: the flag, then `IX_FORMAT`, then `format` in `~/.ix/config.yaml`
(`ix config set format llm`), then `text`. Set the env var or the config key and
stop passing the flag; an explicit `--format` still wins on the call that needs
something else. `ix config show` reports when `IX_FORMAT` is overriding the
stored value.

A command that does not implement the configured format keeps its own default
rather than being handed one it cannot render — `query` renders `text` and
`json` only, so `IX_FORMAT=llm` leaves it on `text`.
### JSON is compact unless a person is watching

`--format json` prints one line when stdout is not a terminal — a pipe, a
command substitution, an agent's tool result — and indents only when you are
reading it on screen. Indentation is whitespace a parser throws away, and it is
about a fifth of the payload. `--pretty` forces the indented shape anywhere.

### `ix impact` JSON

One object per target (under `--all`, one per candidate in `results`). Top-level
keys, each omitted when empty: `resolvedTarget`, `graph` (only on a degraded
graph), `depth`, `systemPath`, `riskSummary`, `riskLevel`, `riskCategory`,
`atRiskBehavior`, `nextStep`, `flowPropagation`, `summary`, then

- leaf targets (functions, methods, ...): `callerList`, `calleeList`,
  `propagationBuckets`;
- container targets (`class`, `module`, `file`, `object`, `trait`,
  `interface`): `topImpactedMembers`, `propagationBuckets`, `dependentList`;

then `decisions`, `tasks`, `bugs` (and `diagnostics` on containers).

Rows say where their entity is: `callerList[]`, `calleeList[]`,
`propagationBuckets[].members[]`, `topImpactedMembers[]` and `dependentList[]`
carry `path` (workspace-relative), `lineStart` and `lineEnd` next to `kind`
and `name`. A `file` row has `path` only; a field the graph does not know is
left out, never `null`. The span is the entity's own, not the line of the call.

`dependentList` is every direct importer and dependent of a container, each
once, importers first: `{ kind, name, path?, lineStart?, lineEnd?, via }`, with
`via: "importer"` for a node reached over `IMPORTS` and `via: "dependent"` for
one reached over `CALLS`/`REFERENCES` (a node reached both ways is an
`importer`). `summary.directImporters` and `summary.directDependents` count the
two expands before that dedup.

`--limit` cuts `topImpactedMembers` and the `llm` caller/callee rows only.
`callerList`, `calleeList` and `dependentList` are never cut;
`propagationBuckets[].members` lists the first five of each bucket's `count`.

### Commands that accept `--format` but route `llm` to `text`

The deprecated `query` takes `text|json` only. `diff --content` (verbatim hunks)
and `ingest` fall back to text without an error. `explain`, `read`, `status`,
`doctor` and `savings` **do** implement `llm` — that was the last prose
fallback, and `explain`'s records are about 55% smaller than the `json` people
used as a workaround.

### Commands with no `--format` at all

`config`, `init`, `reset`, `upgrade`, `view`, `watch`. (`ingest` does accept
`--format`, despite being an action command.)

## Pro features

Commands marked **[Pro]** require Ix Pro (server-side). The **Planning** and
**Workflows** sections of the CLI are entirely Pro-only — including `plan`,
`plans`, `task`, `tasks`, and `workflow`.

If any Pro command prints `The '<name>' command requires Ix Pro.`, this install
does not have them — skip that step, do not retry it, and do not mention it
again for the rest of the session. Nothing outside those marks is Pro-gated.

Pro-only surface: `plan`, `plans`, `task`, `tasks`, `workflow`, `decide`,
`decisions`, `goal`, `truth`, `bug`, `briefing`.

### Semantic boundaries (Pro record types)

- **decision** — a choice between alternatives, with rationale. Use `ix decide`.
- **bug** — something broken, missing, or incorrect. Use `ix bug create`.
- **task/plan** — intended work and sequencing. Use `ix plan` / `ix plan task`.

## Confidence scores

Ix returns confidence scores with results. When data has low confidence:

- Mention the uncertainty to the user.
- Suggest re-running `ix map` to refresh the graph.
- Never present low-confidence data as established fact.
