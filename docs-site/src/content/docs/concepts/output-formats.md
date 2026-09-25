---
title: Output formats
description: When to use text, json or llm output, and how to set a default.
---

Query commands take `--format text|json|llm`:

| Format | Use it when | Shape |
|---|---|---|
| `text` | A person is reading | Tables and trees |
| `json` | You're chaining commands or pulling out a field | One JSON document |
| `llm` | An agent is reading | One `key=value` record per line, token-minimal |

`llm` is the smallest. For `ix context` it is roughly a ninth of the size of the same answer in `json`. Its wire
format is specified in [The llm output format](/reference/llm-format/).

## Set a default once

The format is resolved in this order:

1. The `--format` flag on the command
2. The `IX_FORMAT` environment variable
3. `format` in `~/.ix/config.yaml`, set with `ix config set format llm`
4. `text`

Set the environment variable or the config key and stop passing the flag. An explicit `--format` still wins on the
one call that needs something else. `ix config show` tells you when `IX_FORMAT` is overriding the stored value.

A command that doesn't implement the configured format keeps its own default. It won't fail on a format it can't
render.

## JSON is compact when piped

`--format json` prints a single line when stdout isn't a terminal (a pipe, a command substitution or an agent's
tool call) and indents only when you're reading it on screen. `--pretty` forces the indented form.

## Trimming output

| Flag | Effect |
|---|---|
| `--quiet` | Drops section titles, headers and advisory hints. Keeps warnings, errors and the `shown=`/`total=`/`truncated=` fields |
| `--fields name,path,lines` | Keeps only those fields on each row, in your order |
| `--limit <n>` | Caps the number of results |

## Confidence

Ix attaches confidence scores to its results. Treat low-confidence answers as leads, not facts, and re-run `ix map`
if the graph may be stale.
