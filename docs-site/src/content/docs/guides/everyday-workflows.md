---
title: Everyday workflows
description: Recipes for the questions developers ask Ix most often.
---

Each recipe starts with the single command that usually answers the question, then the finer-grained commands to
dig further.

## "How does this part of the system work?"

```bash
ix overview IngestionService    # one-shot structural summary
ix contains IngestionService    # its members
ix callees parseFile            # what one of them calls
```

## "What depends on this?" / "What breaks if I change it?"

```bash
ix impact verify_token          # blast radius in one answer
ix callers verify_token         # direct callers
ix imported-by verify_token     # everything that imports it
ix depends verify_token --depth 2
```

## "Where is this defined?"

```bash
ix locate AuthProvider --kind class        # graph and text search together
ix search IngestionService --kind class    # by name, in the graph
ix text "verify_token" --language python   # literal text, via ripgrep
```

Pass `--kind` to `ix search`, which keeps results focused. A module-level constant is `--kind constant`, not
`function`.

## "Show me the code"

```bash
ix read verify_token            # a symbol's own span (paged at 400 lines)
ix read src/auth.py:10-50       # a line range
ix read src/auth.py --all       # a whole file (otherwise paged at 400 lines)
```

## "Which code carries the most weight?"

```bash
ix rank --by dependents --kind class --top 10
ix inventory --kind function --path auth.py    # everything of a kind in one place
```

## "How is the architecture holding up?"

```bash
ix smells                       # structural issues
ix subsystems --level 2         # subsystem scores
ix stats                        # graph statistics
```

## "What changed?"

```bash
ix history <entity-id>          # how one entity changed
ix diff 1 5 --summary           # changes between two graph revisions
```

## Give an agent a starting point

`ix context` builds a bounded, deterministic bundle about one target: the entity, its relationships, the evidence
behind them, the other files most closely connected to it, and the recent commits to its file. It's built to be pasted
into a prompt or read by an agent.

```bash
ix context IngestionService --format llm
ix context IngestionService --max-tokens 6000     # a larger evidence budget (default 3000)
ix context IngestionService --save ingest-review  # keep it to resume or diff later
ix context --from-issue issue.md                  # start from a bug report instead of a name
gh issue view 42 --json body -q .body | ix context --from-issue -
```

With `--from-issue`, Ix resolves the file paths (including those in stack traces and GitHub links) and code names the
issue mentions to up to three definitions, builds the bundle around the first, and ranks the other files by how well
they match the issue's text. When nothing resolves, it starts from the best-matching file.

## Tips

- Decompose a big question into several targeted commands. Commands answer structural questions, not free-form
  prose.
- Use `--limit` to cap result sets.
- When chaining commands, reuse the exact entity IDs from a previous `--format json` result.
- If a name is ambiguous, `--pick <n>` (1-based) chooses a candidate without retyping a longer name.
