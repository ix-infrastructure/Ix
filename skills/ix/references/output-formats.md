# Output Formats & Pro Features

## Output formats

Query commands accept `--format text|json|llm`:

- **`--format llm`** — use when reading the result yourself. Token-minimal,
  newline-delimited (`key=value`, one record per line). Smallest output.
- **`--format json`** — use when chaining results between commands or pulling a
  specific field out of a response.
- **`--format text`** — human-oriented tables and trees.

### Commands that accept `--format` but route `llm` to `text`

`explain`, `read`, `status`, and the deprecated `query` do not implement `llm`
and fall back to human-oriented text without an error. Use `--format json` on
those if the output needs to be parsed. Everywhere else, `llm` behaves as
documented.

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
`decisions`, `goal`, `truth`, `bug`, `bugs`, `briefing`, `patches`.

### Semantic boundaries (Pro record types)

- **decision** — a choice between alternatives, with rationale. Use `ix decide`.
- **bug** — something broken, missing, or incorrect. Use `ix bug create`.
- **task/plan** — intended work and sequencing. Use `ix plan` / `ix plan task`.

## Confidence scores

Ix returns confidence scores with results. When data has low confidence:

- Mention the uncertainty to the user.
- Suggest re-running `ix map` to refresh the graph.
- Never present low-confidence data as established fact.
