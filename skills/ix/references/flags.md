# Ix Flag Reference

Every flag the OSS CLI registers, per command. Load this when you need a flag
that [commands.md](commands.md) does not show — that file routes a *goal* to a
command and stays deliberately short, and the flags that shape the answer live
here.

Generated from the registered command tree, not written by hand:

```bash
cd ix-cli && npm run build
node scripts/dump-cli-surface.mjs           # full JSON, one object per command
node scripts/dump-cli-surface.mjs --flags   # just the long flags, sorted
```

That script is the reason this file can be trusted: the previous state of the
docs covered 27 of the 76 implemented flags, because nothing connected the two
surfaces (#575).

## How to read the tables

- **Value** — `—` for a boolean switch, otherwise the placeholder the command
  takes, or the accepted choices when it validates them. A value outside a
  choice list is rejected, not silently ignored:
  `error: option '--format <fmt>' argument 'yaml' is invalid. Allowed choices
  are text, json, llm.`
- **Default** — the value in force when the flag is absent. `off` for a
  boolean, `—` when the command has no default and treats absence as "unset"
  (which is not always the same as zero).
- Both `--format` and `-y`/`--yes` style short forms are shown as
  `--long` / `-s` where one exists.
- Pro commands (`plan`, `task`, `goal`, `decide`, `bug`, `briefing`,
  `workflow`, ...) are not here: this file covers what `registerOssCommands`
  registers. See [output-formats.md](output-formats.md) for the Pro surface.

## Flags with behaviour worth knowing

- **`ix diff` refuses conflicting volume flags rather than picking a winner.**
  `--summary` ignores both `--limit` and `--full`, and `--full --limit` is
  rejected on its own; each combination errors with which flag to drop.
- **`ix reset` is global.** `--code` narrows *what kind* of data goes, not
  which workspace — see the Gotchas section of [commands.md](commands.md)
  before running it in a shared backend.
- **`--detailed` on `ix subsystems` requires `--list`**, and `--offset`
  disables the auto-pagination that `--limit` otherwise drives.
- **`--pick <n>` is 1-based** everywhere it appears, and is how you resolve an
  ambiguous target without re-running with a longer name.
- **`--no-recursive` and `--no-open` are negations of a default-on
  behaviour**, so their "off" default means the positive behaviour is active.

## Commands

### `ix callees <symbol>`

Show methods/functions called by the given symbol (cross-file).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--limit` | `<n>` | `50` | Max results to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix callers <symbol>`

Show methods/functions that call the given symbol (cross-file).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--limit` | `<n>` | `50` | Max results to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix config`

Show or update Ix configuration.

Subcommands: `show`, `get`, `set`.

No flags.

#### `ix config show`

Show current configuration.

No flags.

#### `ix config get <key>`

Get a config value (e.g. endpoint, user.name).

No flags.

#### `ix config set <key> <value>`

Set a config value (e.g. ix config set user.name 'Alice').

No flags.

### `ix conflicts`

List detected conflicts.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix contains <symbol>`

Show members contained by the given entity (class, module, file).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Filter target entity by file path (substring match) |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--limit` | `<n>` | `50` | Max results to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix context [target]`

Build a bounded, deterministic context bundle for a symbol, file, or entity (or resume/diff a saved investigation without a target).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--depth` | `compact\|standard\|full\|shallow\|deep` | — | Context-graph expansion depth (compact\|standard\|full\|shallow\|deep) |
| `--as-of-rev` | `<n>` | — | Historical context as of a graph revision |
| `--max-entities` | `<n>` | — | Maximum entities in the bundle (default: 50, clamped to 1-500) |
| `--max-relationships` | `<n>` | — | Maximum relationships in the bundle (default: 100, clamped to 1-1000) |
| `--max-evidence` | `<n>` | — | Maximum evidence items in the bundle (default: 25, clamped to 1-200) |
| `--max-chars` | `<n>` | — | Maximum characters of evidence output (default: 12000, clamped to 1000-1000000) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--out` | `<path>` | — | Write the JSON bundle to this file instead of stdout |
| `--save` | `<id>` | — | Persist the bundle as a resumable investigation state |
| `--resume` | `<id>` | — | Render a saved investigation state without a backend |
| `--diff` | `<id>` | — | Diff a saved investigation against a fresh build of the same target |
| `--list` | — | off | List saved investigations (no target, no backend) |

### `ix depends <symbol>`

Show upstream dependents of the given entity (full tree by default).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--depth` | `<n>` | — | Cap traversal depth |
| `--cap` | `<n>` | — | Cap number of nodes visited |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--include-tests` | — | off | Include test and fixture entities in results |
| `--tests-only` | — | off | Show only test and fixture entities |

### `ix diff <fromRev> <toRev> [target]`

Show diff between two revisions, optionally scoped to a file or entity.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--entity` | `<id>` | — | Filter by entity ID (deprecated, use positional target) |
| `--summary` | — | off | Show compact summary only (server-side, fast) |
| `--content` | — | off | Show detailed attribute changes for each entity |
| `--limit` | `<n>` | — | Max changes to return (default 100) |
| `--full` | — | off | Return all changes (no limit) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |

### `ix docker`

Manage the IX backend Docker containers.

Subcommands: `start`, `stop`, `status`, `logs`, `restart`.

No flags.

#### `ix docker start`

Start the IX backend (ArangoDB + Memory Layer).

No flags.

#### `ix docker stop`

Stop the IX backend containers.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--remove-data` | — | off | Also remove the current project's ArangoDB data volume |
| `--remove-all-data` | — | off | Remove all local Ix ArangoDB data volumes across repos |
| `--yes` | — | off | Skip confirmation prompt (for use with --remove-all-data) |

#### `ix docker status`

Show backend container and health status.

No flags.

#### `ix docker logs`

Tail backend container logs.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--follow` / `-f` | — | `true` | Follow log output |

#### `ix docker restart`

Restart the IX backend containers.

No flags.

### `ix doctor`

Check Ix system health — server, database, graph integrity.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix entity <id>`

Get entity details with claims and edges.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix explain <symbol>`

Explain an entity — infers role, importance, and structural context.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--raw` | — | off | Show raw metadata dump (legacy format) |

### `ix help [topic]`

Additional help topics. With no topic, prints the top-level help. `workflows`
(or `workflow`) and `advanced` are prose topics; any other topic is looked up as
a registered command and shows that command's help. The retired plurals `goals`
and `bugs` forward to `goal` and `bug`, whose help documents the subcommand that
absorbed them. An unrecognised topic exits non-zero.

No flags.

### `ix history <target>`

Show provenance chain for a file or entity.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix impact <target>`

System risk analysis — what behavior is at risk if this changes.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--depth` | `<n>` | `1` | Expansion depth for callers/importers (default 1, max 3) |
| `--limit` | `<n>` | `10` | Max top-impacted members to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix imported-by <symbol>`

Show what imports the given entity.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--limit` | `<n>` | `50` | Max results to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix imports <symbol>`

Show what the given entity imports.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--limit` | `<n>` | `50` | Max results to show |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix ingest [path]`

Ingest source files or GitHub data into the knowledge graph.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--path` | `<dir>` | — | Path to ingest (alternative to positional argument) |
| `--no-recursive` | — | off | Do not recurse into subdirectories (recursive is on by default) |
| `--github` | `<owner/repo>` | — | Ingest issues, PRs, and commits from a GitHub repository |
| `--token` | `<pat>` | — | GitHub personal access token |
| `--since` | `<date>` | — | Only fetch items updated after this date (ISO 8601) |
| `--limit` | `<n>` | `50` | Max items per category (default 50) |
| `--force` | — | off | Force re-ingest even if files are unchanged (useful after parser upgrades) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--root` | `<dir>` | — | Workspace root directory |
| `--debug` | — | `false` | Show phase timing breakdown |
| `--lang` | `<langs>` | — | Comma-separated languages to include (e.g. cpp,c or typescript). Aliases: c++=cpp, c#=csharp, py=python, ts=typescript, js=javascript |

### `ix init`

(deprecated) Initialize Ix — use ix map . instead.

No flags.

### `ix inventory`

List entities by kind with optional path scoping.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Entity kind to list (class, method, function, file, module, etc.) |
| `--path` | `<path>` | — | Filter by source file path substring |
| `--limit` | `<n>` | `50` | Max results |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix locate <symbol>`

Resolve a symbol to its position in the codebase and system hierarchy.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer results from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix map [path]`

Map the architectural hierarchy of a codebase.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm\|silent` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--level` | `<n>` | — | Show only regions at this level (1=finest, higher=coarser) |
| `--min-confidence` | `<n>` | `0` | Only show regions above this confidence threshold (0-1) |
| `--max-items` | `<n>` | `10` | Max items to show per section in text output (default: 10) |
| `--all-items` | — | off | Show all items in each section (overrides --max-items) |
| `--sort` | `importance\|confidence\|size\|alpha` | `importance` | Sort mode for text output (importance\|confidence\|size\|alpha) |
| `--graph` | — | off | Render the hierarchy as a graph/tree view (default) |
| `--list` | — | off | Render the ranked list view instead of the default graph/tree view |
| `--full` | — | off | Force full local map, bypassing automatic safety limits (advanced/testing) |
| `--verbose` | — | off | Show raw confidence/crosscut scores and signals, plus per-file ingest diagnostics (including why a patch failed to commit) |
| `--silent` | — | off | Suppress all output except a one-line summary (useful for LLM hooks) |

### `ix mcp`

Serve Ix tools over the Model Context Protocol (stdio).

Subcommands: `install`, `doctor`.

No flags.

#### `ix mcp install`

Register `ix mcp` with the AI clients installed on this machine.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--host` | `<ids...>` | — | Only these hosts (claude, codex, cursor, vscode, gemini, openclaw, opencode) |
| `--dry-run` | — | `false` | Report what would change without writing anything |
| `--force` | — | `false` | Replace a registration held by a different server |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

#### `ix mcp doctor`

Check that `ix mcp` is registered and launchable from each client.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--host` | `<ids...>` | — | Only these hosts |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix overview <target>`

Structural summary — what a target contains or what surrounds it.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--kind` | `<kind>` | — | Filter target entity by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix patches`

List recent patches.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--limit` | `<n>` | `50` | Maximum patches to return |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix query <question>`

[DEPRECATED] Broad NLP-style graph query — prefer bounded commands instead.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--as-of` | `<rev>` | — | Time-travel to a specific revision |
| `--depth` | `shallow\|standard\|deep` | `standard` | Query depth (shallow\|standard\|deep) |
| `--format` | `text\|json` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--unsafe` | — | off | Enable query (can produce large outputs) |

### `ix rank`

Rank entities by graph-derived importance (dependents, callers, importers, members).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--by` | `<metric>` | — | Metric to rank by (dependents, callers, importers, members) |
| `--kind` | `<kind>` | — | Entity kind to rank (e.g. class, method, module) |
| `--top` | `<n>` | `10` | Number of results to return |
| `--path` | `<path>` | — | Filter entities by source path substring |
| `--exclude-path` | `<path>` | — | Exclude entities whose source path contains this substring |
| `--exclude-kind` | `<kinds>` | — | Comma-separated kinds to exclude from results |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix read <target>`

Read raw file content, line ranges, or symbol source code.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--kind` | `<kind>` | — | Filter symbol by kind |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--root` | `<dir>` | — | Workspace root directory |

### `ix reset`

Wipe graph data.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--yes` / `-y` | — | off | Skip confirmation prompt |
| `--code` | — | off | Reset only code graph (files, functions, classes, regions); preserve goals, plans, tasks, bugs, and decisions |
| `--ingest` | — | off | Re-run ix map after wiping (rebuilds the code graph) |

### `ix savings`

Show token savings from Ix usage.

Subcommands: `reset`.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--detail` | — | off | Include per-command breakdown |
| `--model` | `opus\|sonnet\|haiku\|gpt-4o` | `opus` | Pricing model (opus\|sonnet\|haiku\|gpt-4o) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

#### `ix savings reset`

Reset lifetime savings totals.

No flags.

### `ix search <term>`

Search the knowledge graph by term — ranked by structural relevance.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--limit` | `<n>` | `10` | Max results |
| `--kind` | `<kind>` | — | Filter and boost results by node kind (e.g. class, function, decision) |
| `--language` | `<lang>` | — | Filter by language/file extension (e.g. scala, ts) |
| `--path` | `<path>` | — | Boost results from files matching this path substring |
| `--as-of` | `<rev>` | — | Search as of a specific revision |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--include-tests` | — | off | Include test and fixture entities in results |
| `--tests-only` | — | off | Show only test and fixture entities |
| `--semantic` | — | off | Use vector-similarity (embedding) search instead of keyword matching |

### `ix smells`

Detect architecture smells in the codebase.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--orphan-max-connections` | `<n>` | `0` | Max connections for orphan files |
| `--god-module-chunks` | `<n>` | `20` | Min chunks for god module |
| `--god-module-fan` | `<n>` | `15` | Min fan-in/out for god module |
| `--weak-max-neighbors` | `<n>` | `1` | Max neighbors for weak component |
| `--list` | — | off | List existing smell claims without rerunning |

### `ix stats`

Show graph statistics — node/edge counts by type.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |

### `ix status`

Show Ix backend health and status.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--root` | `<dir>` | — | Workspace root directory |

### `ix subsystems [target]`

Show the persisted architectural map saved by 'ix map'.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--list` | — | off | List stored subsystem health scores instead of the persisted architecture map |
| `--detailed` | — | off | Include member files and enriched call/import edges (requires --list) |
| `--limit` | `<n>` | — | Max regions per page in detailed mode (default: 200 when auto-paging) |
| `--offset` | `<n>` | — | Skip N regions in detailed mode (disables auto-pagination) |
| `--regions` | `<list>` | — | Comma-separated region IDs or names to scope detailed listing |
| `--edge-cap` | `<n>` | — | Max edges per direction per region in detailed mode |
| `--member-file-cap` | `<n>` | — | Max member files per region in detailed mode |
| `--target` | `<target>` | — | Scope subsystem output to a persisted architecture region |
| `--pick` | `<n>` | — | Resolve an ambiguous region target by numbered candidate |
| `--level` | `<n>` | — | Filter to level (1=module, 2=subsystem, 3=system) |
| `--min-confidence` | `<n>` | `0` | Only show regions above this confidence threshold (0-1) |
| `--max-items` | `<n>` | `10` | Max items to show per section in text output (default: 10) |
| `--all-items` | — | off | Show all items in each section (overrides --max-items) |
| `--sort` | `importance\|confidence\|size\|alpha` | `importance` | Sort mode for text output (importance\|confidence\|size\|alpha) |
| `--graph` | — | off | Render the hierarchy as a graph/tree view instead of the default ranked list |
| `--verbose` | — | off | Show raw confidence scores, crosscut scores, boundary ratios, and signals |
| `--explain` | — | off | Explain a scoped subsystem region in plain English |

### `ix text <term>`

Fast lexical/text search across the codebase (uses ripgrep).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--limit` | `<n>` | `20` | Max results |
| `--path` | `<dir>` | `.` | Restrict search to a workspace-relative directory |
| `--language` | `<lang>` | — | Filter by language (python, typescript, scala, etc.) |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--root` | `<dir>` | — | Workspace root directory |

### `ix trace <symbol>`

Follow how it connects.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--to` | `<target>` | — | Find path to target symbol |
| `--upstream` | — | off | Show who calls/imports this (same as depends) |
| `--downstream` | — | off | Show what this calls/imports (outward flow) |
| `--kind` | `<kind>` | — | Relationship kind: calls\|imports\|depends\|contains |
| `--depth` | `<n>` | — | Cap traversal depth |
| `--cap` | `<n>` | — | Cap number of nodes visited, per direction |
| `--pick` | `<n>` | — | Pick Nth candidate from ambiguous results (1-based) |
| `--path` | `<path>` | — | Prefer symbols from files matching this path substring |
| `--format` | `text\|json\|llm` | `text` | Output format — see [output-formats.md](output-formats.md) |
| `--include-tests` | — | off | Include test and fixture entities |
| `--tests-only` | — | off | Show only test and fixture entities |

### `ix upgrade`

Upgrade ix CLI, backend, and components to the latest version.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--check` | — | off | Only check for updates, don't install |

### `ix view`

Open the Ix System Compass visualizer.

Subcommands: `start`, `stop`, `status`.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--port` / `-p` | `<port>` | `8080` | Port to serve on |

#### `ix view start`

Start the visualizer (default).

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--no-open` | — | off | Don't auto-open browser |
| `--all` | — | off | Show every ingested workspace together (no workspace scoping) |

#### `ix view stop`

Stop the visualizer.

No flags.

#### `ix view status`

Show visualizer status.

No flags.

### `ix watch`

Watch files and auto-ingest on changes.

| Flag | Value | Default | Effect |
|---|---|---|---|
| `--path` | `<path>` | — | Restrict watching to a subdirectory |
| `--root` | `<dir>` | — | Workspace root directory |
