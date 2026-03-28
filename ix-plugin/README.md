# Ix Memory — Claude Code Plugin

A Claude Code plugin that makes Claude always use Ix for codebase understanding —
injecting session context on every prompt, intercepting all searches and file reads
with graph-aware queries, and keeping the Ix graph current as Claude edits.

## What It Does

| Trigger | Hook | Effect |
|---------|------|--------|
| User sends any prompt | `UserPromptSubmit` → `ix-briefing.sh` | Injects compact session briefing (goals, bugs, decisions, tasks) into every prompt |
| Claude runs `Grep` or `Glob` | `PreToolUse` → `ix-intercept.sh` | Runs `ix text` + `ix locate` (or `ix inventory`) first; injects graph-aware results |
| Claude runs `Read` | `PreToolUse` → `ix-read.sh` | Runs `ix inventory` + `ix overview` for the file; injects entity context before Claude sees raw source |
| Claude runs `Bash` (grep/rg) | `PreToolUse` → `ix-bash.sh` | Detects grep/rg patterns and front-runs with `ix text` + `ix locate` |
| Claude runs `Write`, `Edit`, `MultiEdit`, or `NotebookEdit` | `PostToolUse` → `ix-ingest.sh` (async) | Ingests the changed file into the Ix graph silently in the background |
| Claude finishes responding | `Stop` → `ix-map.sh` (async) | Runs `ix map` to refresh the full architectural graph for the next session |

All hooks bail silently if `ix` is not in PATH or the Ix backend is unreachable.

## Why Hooks Instead of MCP

- **No user approval prompt** — hooks fire silently and automatically
- **Guaranteed execution** — every prompt, search, read, and edit is covered
- **Token-efficient** — Ix returns structured, bounded results vs. raw file content
- **Graph always current** — edits ingested immediately; full map refreshes at session end

## Installation

### From the repo (local)

```bash
bash ix-plugin/install.sh
```

### Via curl

```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/install.sh | bash
```

Restart Claude Code after installing. Verify hooks loaded with `/hooks`.

## Requirements

- `ix` CLI in PATH and Ix backend running (`ix status` should return ok)
- `jq` in PATH
- `ripgrep` (`rg`) in PATH — required by `ix text`

```bash
# Ubuntu/Debian
sudo apt install jq ripgrep

# macOS
brew install jq ripgrep
```

## Structure

```
ix-plugin/
  .claude-plugin/
    plugin.json          # manifest
  hooks/
    hooks.json           # hook event registration
    ix-briefing.sh       # UserPromptSubmit → ix briefing (session context)
    ix-intercept.sh      # PreToolUse: Grep|Glob → ix text + ix locate/inventory
    ix-read.sh           # PreToolUse: Read → ix inventory + ix overview
    ix-bash.sh           # PreToolUse: Bash (grep/rg) → ix text + ix locate
    ix-ingest.sh         # PostToolUse: Write|Edit|MultiEdit|NotebookEdit → ix ingest
    ix-map.sh            # Stop → ix map (full graph refresh)
  install.sh
  uninstall.sh
  README.md
```

## Hook Details

### ix-briefing.sh (UserPromptSubmit)

On every user prompt:
1. Runs `ix briefing --format json` (60s health cache to avoid per-prompt overhead)
2. Injects active goals, open bugs, recent decisions, and pending tasks as `additionalContext`
3. Claude always has project context without needing an explicit `ix briefing` call

### ix-intercept.sh (PreToolUse: Grep|Glob)

When Claude runs `Grep "verify_token"`:
1. Runs `ix text "verify_token" --limit 20 --format json` + `ix locate "verify_token" --limit 10 --format json` in parallel
2. Injects results as `additionalContext` — Claude uses them before Grep output arrives

For `Glob`, runs `ix inventory` (optionally filtered by path) instead.

### ix-read.sh (PreToolUse: Read)

When Claude reads a file:
1. Runs `ix inventory --path <file>` (all entities defined in the file)
2. Runs `ix overview <name>` (structural summary of the module)
3. Injects both as `additionalContext` — Claude understands the file's structure before seeing raw source

### ix-bash.sh (PreToolUse: Bash)

When Claude runs a `grep` or `rg` command:
1. Extracts the search pattern from the command string
2. Runs `ix text <pattern> --limit 20` + `ix locate <pattern> --limit 10` in parallel
3. Injects results as `additionalContext`

### ix-ingest.sh (PostToolUse: Write|Edit|MultiEdit|NotebookEdit)

After each file edit:
1. Reads `tool_input.file_path` from stdin
2. Runs `ix ingest <file>` silently in the background
3. Returns `additionalContext`: `[ix] Graph updated — ingested: <path>`

### ix-map.sh (Stop)

After Claude finishes each response:
1. Runs `ix map` in the background (detached, non-blocking)
2. Keeps the full architectural graph current for the next session

## Uninstall

```bash
bash ix-plugin/uninstall.sh
# or:
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/uninstall.sh | bash
```
