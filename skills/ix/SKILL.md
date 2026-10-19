---
name: ix
description: "Answer structural questions about a codebase — what a symbol is, what calls it, what a change breaks, where the hotspots are — from a persistent code graph via the ix CLI, instead of grepping."
license: Apache-2.0
metadata:
  version: 1.0.0
  source: https://github.com/ix-infrastructure/Ix
---

# Ix — Persistent Codebase Map

Ix parses a repository with tree-sitter (27 languages) into a graph of symbols,
calls and imports, kept in a local backend (ArangoDB via Docker) and persisted
between sessions. Query it for structural answers — what a symbol is, what calls
it, how a flow moves, what a change breaks, which files carry the most weight,
where the smells are — instead of reading files to find out. It does not answer
prose or history questions.

## First run

```bash
bash scripts/bootstrap.sh [repo-root] [--no-map]                                     # macOS / Linux / Git Bash
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 [repo-root] [-NoMap]  # Windows
```

Checks Node >= 22, git, Docker and ripgrep, installs the CLI if missing, starts
the backend, and maps the repo. Re-run it per repo.

## Core workflow

| Step | Command | Example |
|---|---|---|
| Bounded context to start from | `ix context` | `ix context IngestionService` |
| Start from an issue or bug report | `ix context --from-issue` | `ix context --from-issue issue.md` (or `-` for stdin) |
| Understand a component | `ix explain` | `ix explain IngestionService` |
| Trace a flow | `ix trace` | `ix trace user_login_flow` |
| Blast radius of a change | `ix impact` | `ix impact verify_token` |

## Over MCP

When the `ix-memory` MCP server is connected (`ix mcp`; register it with
`ix mcp install`), the same graph is five tools. Reach for them where Grep,
Glob and Read need several steps or cannot answer at all:

| Question | Tool |
|---|---|
| Where to start on an issue or task; what a file or symbol touches | `ix_context target=<name or path>` or `ix_context issue=<issue text>` |
| Who calls / is called by / imports / is imported by X, across files | `ix_neighbors symbol=X relation=callers\|callees\|imports\|imported_by` |
| What a change to X reaches, before editing it | `ix_impact target=X` |
| Which definition a name means when several share it | `ix_search term=X` |
| A definition's source by name, without knowing its file | `ix_read symbol=X` |

Not for a literal string or a line in a file you already have open: that is
Grep and Read. `ix_context` and `ix_impact` end in `next` records phrased as
tool calls; an ambiguous name answers with candidates and `pick=`/`path=` to
choose one. No health check is needed first. `ix mcp --tools=all` serves
every command as a tool.

## Reading the exit code

A non-zero exit from a graph command is usually an answer, not a breakage:

| Exit | Means | Do |
|---|---|---|
| 0 | results | use them |
| 2 | ambiguous: candidates listed | re-run with `--pick <n>` or `--path`, or `--all` (`callers`/`callees`/`impact`) for every candidate at once |
| 3 | not found | read `reason` / `suggestion`: a file not indexed means `ix map`; a near name means retry with it |
| 4 | workspace not mapped | `ix map` |
| 1 | a real error | read the `error` record |

json carries the same outcome in `error` (`ambiguous_target`,
`unresolved_target`, `workspace_not_mapped`); llm in `error code=`. Ask about
several names in one call: `ix locate a b c`, `ix callers a b c`.

## How to spend calls

1. **Start with `ix context <file-or-symbol>`** — one bounded call that names the
   files and symbols that matter, with line ranges.
2. **Read the ranges, not the files.** `ix read <symbol>`, or `path:120-180`, is
   one to three thousand tokens; the file around it is commonly thirty to sixty
   thousand — and every one of those is re-sent on every later step of the turn.
3. Ask the graph what grep cannot: `ix callers`, `ix imported-by` and
   `ix impact` answer "who uses this" and "what does a change reach" across
   files. Drill further with `ix search`, `ix callees`, `ix contains`,
   `ix imports`, `ix depends`, reusing the exact entity IDs from earlier output.
4. **Do not poll `ix status`.** A command that needs the backend says so itself,
   with a hint; a health check in front of every call is a wasted round trip.
5. Format: `llm` is the one to read, and `IX_FORMAT=llm` (or
   `ix config set format llm`) makes it the default so it need not be typed per
   call; `json` is for chaining or extracting a field. On `ix context` the same
   answer runs about 7.6 : 0.8 : 1 for json : llm : text.

## Rules

1. Answer codebase questions from targeted `ix` commands, not from training data.
2. Never guess a codebase fact that Ix holds.
3. The graph is kept current for you: bootstrap maps the repo and editor
   plugins re-ingest edited files. Run `ix map --silent` only when results are
   visibly stale, such as after a branch switch or a pull.
4. When Ix reports low confidence, say so, and never present it as established
   fact.

## References — load on demand

- **references/commands.md** — command routing tables, decomposition recipes,
  best practices, the do-not-use list. Before any command beyond the table above.
- **references/flags.md** — every flag the CLI registers, per command, with
  values and defaults. Before guessing whether a flag exists.
- **references/output-formats.md** — the `llm|json|text` rules, what does not
  implement `llm`, and which commands are Pro-gated.
- **references/troubleshooting.md** — prerequisites, `ix doctor`, backend health,
  environment flags. When a command fails.
- **scripts/bootstrap.sh** / **scripts/bootstrap.ps1** — first-run setup (bash;
  and native PowerShell for Windows).
