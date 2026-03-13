# Ix Memory

Ix Memory is a local, versioned knowledge graph for codebases.

It has two runtime parts:
- `memory-layer` (Scala HTTP API)
- `ix-cli` (TypeScript CLI; canonical interface)

The primary interface is `ix` CLI commands.

## What It Supports Today

- File ingestion: `.py`, `.ts`, `.tsx`, `.scala`, `.sc`, `.json`, `.yaml`, `.yml`, `.toml`, `.md`
- Graph navigation: search, explain, callers/callees, imports/imported-by, contains, depends
- High-level workflow: impact analysis, hotspot ranking, one-shot overviews, scoped inventory
- Decision and intent tracking: `ix decide`, `ix decisions`, `ix truth ...`
- Provenance + history: `ix patches`, `ix history`, `ix diff`, `ix conflicts`
- GitHub ingestion: `ix ingest --github owner/repo` (issues/PRs/commits/comments)

## Install

macOS, Linux, WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.ps1 | iex
```

Windows CMD:

```cmd
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Homebrew:

```bash
brew tap ix-infrastructure/ix https://github.com/ix-infrastructure/IX-Memory
brew install ix
```

## Getting Started

```bash
cd your-project
ix init                          # register workspace, set up MCP
ix ingest ./src --recursive      # parse codebase into knowledge graph
ix overview YourMainClass        # explore what Ix knows
```

## Upgrade

```bash
ix upgrade                       # upgrade to latest stable version
ix upgrade --check               # see what's available without installing
ix upgrade --version 1.6.0       # install a specific version
ix upgrade --channel beta        # switch to beta channel
```

## Rollback

If an upgrade caused issues, revert to the previous version:

```bash
ix upgrade --rollback
```

This restores both the binary and database to their state before the last upgrade.

## Reset

Start fresh with an empty database:

```bash
ix reset                         # wipe database (with confirmation)
ix reset --force                 # wipe without confirmation
ix upgrade --reset               # upgrade and wipe database
```

After a reset, re-ingest your codebase:

```bash
ix ingest ./src --recursive
```

## Version Info

```bash
ix --version
```

```
ix 1.5.0 (stable)
  server: 1.5.0
  schema: 5
  platform: darwin-arm64
```

## Server Management

The server starts automatically when you run any `ix` command. For manual control:

```bash
ix server status                 # check if server is running
ix server start                  # start manually
ix server stop                   # stop the server
```

The server auto-shuts down after 30 minutes of inactivity.

## Diagnostics

```bash
ix status                        # backend health + graph freshness
ix stats                         # graph node/edge counts
```

---

## Prerequisites

| Tool | Version |
|---|---|
| Java | 17+ |
| sbt | 1.x |
| Docker | 20+ |
| Node.js | 18+ |
| npm | 9+ |

## Install And Start

From repo root:

```bash
./setup.sh
```

What this does:
- Starts backend services (`arangodb` + `memory-layer`) via `scripts/backend.sh`
- Builds CLI (`ix-cli`) via `scripts/build-cli.sh`
- Installs a global `ix` command at `~/.local/bin/ix`
- Ensures `~/.local/bin` is on your PATH in `~/.bashrc` / `~/.zshrc`

Optional flags:

```bash
./setup.sh --skip-backend
./setup.sh --skip-global-ix
```

### Verify

```bash
./scripts/backend.sh check
ix status
```

If `ix` is not found in your current shell, reload your shell or run:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Connect A Project

### Fast path

```bash
./scripts/connect.sh /path/to/your/project
```

### Manual path

```bash
cd /path/to/your/project
ix init
ix ingest ./src --recursive
```

## Core Usage

All commands support `--format json`.

```bash
# Start with high-level workflow commands
ix overview UserService                          # one-shot summary
ix impact UserService                            # what depends on it
ix rank --by dependents --kind class --top 10    # most important classes
ix inventory --kind function --path "src/"       # list functions

# Low-level primitives for fine-grained inspection
ix search IngestionService --kind class --format json
ix explain IngestionService --format json
ix callers parseFile --format json
ix callees parseFile --format json
ix imports IngestionService --format json
ix imported-by IngestionService --format json
ix contains IngestionService --format json
ix depends IngestionService --depth 2 --format json
ix read src/main/scala/ix/memory/Main.scala:1-80
ix text "commitPatch" --language ts --limit 20 --format json
```

## GitHub Ingestion

```bash
ix ingest --github owner/repo --since 2026-01-01 --limit 50 --format json
```

Auth resolution order:
1. `--token <pat>`
2. `GITHUB_TOKEN`
3. `gh auth token`

## Planning & Tasks

| Command | Usage | Description |
|---------|-------|-------------|
| `ix goal create` | `ix goal create <statement>` | Create a project goal |
| `ix goal list` | `ix goal list` | List all goals |
| `ix plan create` | `ix plan create <title> --goal <id>` | Create a plan linked to a goal |
| `ix plan task` | `ix plan task <title> --plan <id>` | Add a task to a plan |
| `ix plan status` | `ix plan status <plan-id>` | Show plan progress and next task |
| `ix plan next` | `ix plan next <plan-id>` | Get the next actionable task |
| `ix task update` | `ix task update <id> --status done` | Update task status |

## Useful Scripts

| Script | Purpose |
|---|---|
| `./setup.sh` | Start backend + build CLI + install global `ix` |
| `./scripts/backend.sh up` | Start backend |
| `./scripts/backend.sh down` | Stop backend |
| `./scripts/backend.sh logs` | Tail logs |
| `./scripts/backend.sh clean` | Remove volumes/data |
| `./scripts/build-cli.sh` | Build CLI |
| `./scripts/connect.sh <dir>` | Connect project + ingest |
| `./scripts/disconnect.sh <dir>` | Remove project config |
| `./scripts/ingest.sh [path]` | Ingest helper |

## Testing

CLI:

```bash
cd ix-cli
npm test
```

Backend:

```bash
# Requires ArangoDB running on localhost:8529
sbt memoryLayer/test
```

## Known Notes

- Many Scala tests require a live ArangoDB instance; if it is down, DB/API/E2E specs fail.
- `TreeSitterPythonParser` still contains a TODO for full AST traversal fallback behavior.
- `ix query` remains available but is deprecated in help text and templates.
- `connect.sh` sets up project config; CLI remains canonical.

## Architecture

```text
ix-cli  --->  memory-layer (http4s)  --->  ArangoDB
```

## License

Proprietary — IX Infrastructure.
