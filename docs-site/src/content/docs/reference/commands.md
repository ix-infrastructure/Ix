---
title: Command reference
description: Every ix command, grouped by the question it answers.
---

Run commands from inside a mapped repository. Each command's full list of options, accepted values and defaults is in
the [flag reference](/reference/flags/). `ix <command> --help` prints the same from the CLI.

## Start here

These commands combine several graph queries into one bounded answer. Reach for them first.

| Command | Answers | Example |
|---|---|---|
| `ix overview <target>` | A one-shot structural summary | `ix overview IngestionService` |
| `ix explain <symbol>` | What this is and what it touches | `ix explain IngestionService` |
| `ix impact <target>` | What breaks if this changes | `ix impact UserService` |
| `ix context [target]` | A bounded, deterministic context bundle | `ix context IngestionService` |
| `ix rank` | Which code carries the most weight | `ix rank --by dependents --kind class --top 10` |
| `ix inventory` | Everything of a kind, scoped | `ix inventory --kind function --path auth.py` |

## Finding and understanding code

| Command | Answers | Example |
|---|---|---|
| `ix search <term>` | Which entities match this name | `ix search IngestionService --kind class --limit 10` |
| `ix locate <symbol>` | Where this is defined (graph + text) | `ix locate AuthProvider --kind class` |
| `ix text <term>` | Where this text appears (ripgrep) | `ix text "verify_token" --language python --limit 20` |
| `ix read <target>` | The source of a symbol, file or range | `ix read src/auth.py:10-50` |
| `ix entity <id>` | Full details of one entity | `ix entity <id>` |

## Navigating relationships

| Command | Answers | Example |
|---|---|---|
| `ix callers <symbol>` | What calls this | `ix callers verify_token` |
| `ix callees <symbol>` | What this calls | `ix callees processPayment` |
| `ix trace <symbol>` | How a flow moves, up and down | `ix trace user_login_flow` |
| `ix contains <symbol>` | The members of a class or module | `ix contains IngestionService` |
| `ix imports <symbol>` | What this imports | `ix imports auth_provider.py` |
| `ix imported-by <symbol>` | What imports this | `ix imported-by AuthProvider` |
| `ix depends <symbol>` | Transitive dependents | `ix depends verify_token --depth 2` |

## History and change

| Command | Answers | Example |
|---|---|---|
| `ix history <target>` | How an entity changed | `ix history <entity-id>` |
| `ix diff <from> <to>` | What changed between two graph revisions | `ix diff 1 5 --summary` |
| `ix conflicts` | Contradictions in the graph | `ix conflicts` |
| `ix patches` | The patches that built the graph | `ix patches` |

## Architecture

| Command | Answers | Example |
|---|---|---|
| `ix smells` | Structural issues | `ix smells` |
| `ix subsystems [target]` | Subsystem scores | `ix subsystems --level 2` |
| `ix stats` | Graph statistics | `ix stats` |

## Building the graph

| Command | Does | Example |
|---|---|---|
| `ix map [path]` | Map a repository | `ix map .` |
| `ix watch` | Re-map on every change | `ix watch` |
| `ix ingest [path]` | Ingest files, or GitHub data | `ix ingest --github owner/repo --limit 50` |

`ix ingest` honors `--exclude <glob>` and an `.ixignore` file at the ingest root. `.ixignore` supports a subset of
`.gitignore` syntax: `#` comments, `*`, `?`, `**`, a leading `/` to anchor to the root, a trailing `/` for
directories, and bare names that match at any depth. There is no `!` negation.

## Setup and health

| Command | Does |
|---|---|
| `ix status` | Checks the backend is reachable |
| `ix doctor` | Checks server, database and graph integrity |
| `ix docker start` / `stop` / `restart` | Starts, stops or restarts the local backend containers |
| `ix docker status` / `logs` | Shows container health, or tails the backend's logs |
| `ix view` | Opens the [Compass](/guides/compass/) visualizer |
| `ix mcp` | Runs the [MCP server](/integrations/mcp/). `ix mcp install` registers it with your clients |
| `ix config show` / `get` / `set` | Reads and writes [configuration](/reference/configuration/) |
| `ix savings` | Reports tokens saved against reading files directly. `--detail` breaks it down by command |
| `ix savings reset` | Clears the saved totals. Can't be undone |
| `ix help [topic]` | Help on a command, or the `workflows` and `advanced` topics |
| `ix upgrade` | Upgrades the CLI, backend and components. `--check` only looks |
| `ix reset` | Clears graph data in **every** workspace. Re-map each repository afterwards |

## Ix Pro

Some commands (`plan`, `task`, `workflow`, `decide`, `goal`, `truth`, `bug`, `briefing` and their plurals) belong to
Ix Pro. Without Pro they print `The '<name>' command requires Ix Pro.` Everything else on this page is open source.

## Deprecated

- `ix query` returns oversized, low-signal answers. Use the targeted commands above instead.
- `ix init` is replaced by `ix map .`.
