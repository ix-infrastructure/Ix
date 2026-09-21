# Output Formats & Pro Features

## Output formats

Query commands accept `--format text|json|llm`:

- **`--format llm`** — use when reading the result yourself. Token-minimal,
  newline-delimited (`key=value`, one record per line). Smallest output; on
  `ix context` it is roughly a ninth of the same answer in `json`.
- **`--format json`** — use when chaining results between commands or pulling a
  specific field out of a response.
- **`--format text`** — human-oriented tables and trees.

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
