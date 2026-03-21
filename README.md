# Ix Memory

Persistent, versioned knowledge graph for codebases. Gives LLM assistants structured memory across conversations.

## Install

Pick one method. All install the same thing: the `ix` CLI + a local Docker backend.

### curl (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/install.sh | bash
```

### PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/ix-infrastructure/Ix/main/install.ps1 | iex
```

### Homebrew (macOS / Linux)

```bash
brew tap ix-infrastructure/ix https://github.com/ix-infrastructure/Ix
brew install ix
ix docker start
```

### Prerequisites

- **Docker Desktop** — the backend runs as two containers (ArangoDB + Memory Layer). The installer will prompt you if Docker is missing.

## Quick Start

```bash
# 1. Start the backend
ix docker start

# 2. Connect a project
cd ~/my-project
ix init
ix ingest ./src

# 3. Use it
ix overview MyService
ix impact MyService
ix search parseFile --kind function
ix callers parseFile
```

## Managing the Backend

```bash
ix docker start               # Start ArangoDB + Memory Layer
ix docker stop                # Stop containers (keeps data)
ix docker stop --remove-data  # Stop and wipe all data
ix docker status              # Health check
ix docker logs                # Tail container logs
ix docker restart             # Restart containers
```

## Commands

All commands support `--format json`.

### Workflow Commands (start here)

```bash
ix overview UserService                          # one-shot summary
ix impact UserService                            # what depends on it
ix rank --by dependents --kind class --top 10    # most important classes
ix inventory --kind function --path "src/"       # list functions
```

### Code Navigation

```bash
ix search IngestionService --kind class
ix explain IngestionService
ix callers parseFile
ix callees parseFile
ix imports IngestionService
ix imported-by IngestionService
ix contains IngestionService
ix depends IngestionService --depth 2
ix read src/main/scala/ix/memory/Main.scala:1-80
ix text "commitPatch" --language ts --limit 20
```

### Planning and Tracking (Pro)

These commands require [Ix Pro](https://github.com/ix-infrastructure/Ix).

```bash
ix goal create "Support 100k file repos"
ix plan create "Scale ingestion" --goal <id>
ix plan task "Batch writes" --plan <id>
ix task update <id> --status done
ix decide "Use CONTAINS edge" --rationale "Normalize hierarchy"
ix bug create "Parser fails on decorators" --severity high
ix briefing                                      # session resume
```

### GitHub Ingestion

```bash
ix ingest --github owner/repo --since 2026-01-01 --limit 50
```

Auth resolution: `--token <pat>` → `GITHUB_TOKEN` env → `gh auth token`

## Claude Code Plugin

Automatically installed if `claude` is in your PATH. To install separately:

```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/install.sh | bash
```

What the hooks do:
- **On search** (Grep/Glob): injects graph-aware results before the native tool runs
- **On edit** (Write/Edit): auto-ingests changed files to keep the graph current

## Supported File Types

**Code** — `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.scala`, `.sc`, `.go`, `.java`, `.c`, `.cpp`, `.cs`, `.rb`, `.rs`, `.php`, `.kt`, `.swift`

**Config & Docs** — `.json`, `.yaml`, `.yml`, `.toml`, `.md`

## Uninstall

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/uninstall.sh | bash

# Windows
irm https://raw.githubusercontent.com/ix-infrastructure/Ix/main/uninstall.ps1 | iex

# Homebrew
brew uninstall ix && brew untap ix-infrastructure/ix
ix docker stop --remove-data
```

## Architecture

```
ix CLI (TypeScript)  →  Memory Layer (Scala/http4s)  →  ArangoDB
     local                   Docker :8090                Docker :8529
```

## License

This project is licensed under the [Apache License 2.0](LICENSE).
