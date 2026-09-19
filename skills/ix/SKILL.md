---
name: ix
description: "Answer structural questions about a codebase — what a symbol is, what calls it, what a change breaks, where the hotspots are — from a persistent code graph via the ix CLI, instead of grepping."
license: Apache-2.0
metadata:
  version: 1.0.0
  source: https://github.com/ix-infrastructure/Ix
---

# Ix — Persistent Codebase Map

Ix parses a repository with tree-sitter (26 languages) into a graph of symbols,
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
| Understand a component | `ix explain` | `ix explain IngestionService` |
| Trace a flow | `ix trace` | `ix trace user_login_flow` |
| Blast radius of a change | `ix impact` | `ix impact verify_token` |
| Build / refresh the graph | `ix map` | `ix map .` |

## How to spend calls

1. **Start with `ix context <file-or-symbol>`** — one bounded call that names the
   files and symbols that matter, with line ranges.
2. **Read the ranges, not the files.** `ix read <symbol>`, or `path:120-180`, is
   one to three thousand tokens; the file around it is commonly thirty to sixty
   thousand — and every one of those is re-sent on every later step of the turn.
3. Drill down with primitives, reusing the exact entity IDs from earlier output:
   `ix search`, `ix callers`, `ix callees`, `ix contains`, `ix imports`,
   `ix imported-by`, `ix depends`.
4. **Do not poll `ix status`.** A command that needs the backend says so itself,
   with a hint; a health check in front of every call is a wasted round trip.
5. Format: `llm` is the one to read, and `IX_FORMAT=llm` (or
   `ix config set format llm`) makes it the default so it need not be typed per
   call; `json` is for chaining or extracting a field. On `ix context` the same
   answer runs about 7.6 : 0.8 : 1 for json : llm : text.

## Rules

1. Answer codebase questions from targeted `ix` commands, not from training data.
2. Never guess a codebase fact that Ix holds.
3. On contradictory information, run `ix conflicts` and present the results.
4. Refresh with `ix map --silent` when the graph has gone stale — after a branch
   switch, a pull, or a batch of edits. Editor plugins re-ingest edited files on
   a debounce; this is not a per-edit step.
5. When Ix reports low confidence, say so, suggest re-running `ix map`, and never
   present it as established fact.

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
