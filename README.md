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
ix docker start    # starts the backend
```

### From source (contributors)

```bash
git clone https://github.com/ix-infrastructure/Ix.git
cd Ix
./setup.sh
```

### Prerequisites

- **Docker Desktop** — the backend runs as two containers (ArangoDB + Memory Layer). The installer will prompt you if Docker is missing.
- **Node.js 18+** — only needed for the source install. The curl installer downloads a pre-built CLI.

## Quick Start

```bash
# 1. Start the backend (if not already running)
ix docker start

# 2. Connect a project
cd ~/my-project
ix init
ix ingest ./src --recursive

# 3. Use it
ix overview MyService
ix impact MyService
ix search parseFile --kind function
ix callers parseFile
```

## Managing the Backend

```bash
ix docker start           # Start ArangoDB + Memory Layer
ix docker stop            # Stop containers (keeps data)
ix docker stop --remove-data  # Stop and wipe all data
ix docker status          # Health check
ix docker logs            # Tail container logs
ix docker restart         # Restart containers
```

## What It Supports

- **File ingestion**: `.py`, `.ts`, `.tsx`, `.scala`, `.sc`, `.json`, `.yaml`, `.yml`, `.toml`, `.md`
- **Graph navigation**: search, explain, callers/callees, imports/imported-by, contains, depends
- **Workflow commands**: impact analysis, hotspot ranking, one-shot overviews, scoped inventory
- **Decision tracking**: `ix decide`, `ix decisions`, `ix truth`
- **Planning**: `ix plan`, `ix task`, `ix bug`, `ix goal`
- **History**: `ix patches`, `ix history`, `ix diff`, `ix conflicts`
- **GitHub ingestion**: `ix ingest --github owner/repo`
- **Claude Code integration**: auto-ingest on file edits, graph-aware search intercept

## Core Commands

All commands support `--format json`.

```bash
# High-level workflow (start here)
ix overview UserService                          # one-shot summary
ix impact UserService                            # what depends on it
ix rank --by dependents --kind class --top 10    # most important classes
ix inventory --kind function --path "src/"       # list functions
ix briefing                                      # session resume

# Code navigation
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

# Planning & tracking
ix goal create "Support 100k file repos"
ix plan create "Scale ingestion" --goal <id>
ix plan task "Batch writes" --plan <id>
ix task update <id> --status done
ix decide "Use CONTAINS edge" --rationale "Normalize hierarchy"
ix bug create "Parser fails on decorators" --severity high

# GitHub ingestion
ix ingest --github owner/repo --since 2026-01-01 --limit 50
```

## Claude Code Plugin

The installer automatically sets up Claude Code hooks if `claude` is in your PATH. To install separately:

```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/install.sh | bash
```

What the hooks do:
- **PreToolUse** (Grep/Glob): Runs `ix text` and `ix locate` before native search, injecting graph-aware results as context
- **PostToolUse** (Write/Edit): Runs `ix ingest` on changed files so the graph stays current

To remove:
```bash
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/uninstall.sh | bash
```

## Uninstall

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/uninstall.sh | bash

# Windows
irm https://raw.githubusercontent.com/ix-infrastructure/Ix/main/uninstall.ps1 | iex

# Homebrew
brew uninstall ix
brew untap ix-infrastructure/ix
ix docker stop --remove-data
```

## Architecture

```
ix CLI (TypeScript)  →  Memory Layer (Scala/http4s)  →  ArangoDB
     local                   Docker :8090                Docker :8529
```

## CI/CD Pipeline

Two GitHub Actions workflows run automatically:

### CI (`ci.yml`) — runs on every PR and push to main

| Job | What it does |
|-----|-------------|
| **CLI** | `npm ci` → `npm run build` → `npm test` |
| **Backend** | `sbt compile` → `sbt test` → `sbt memoryLayer/assembly` |

Both jobs run in parallel. PRs must pass both before merging.

### Release (`release.yml`) — runs when you push a version tag

Triggered by: `git tag v0.2.0 && git push origin v0.2.0`

| Step | What it does |
|------|-------------|
| 1. Build JAR | `sbt memoryLayer/assembly` |
| 2. Docker image | Builds + pushes to `ghcr.io/ix-infrastructure/ix-memory-layer:0.3.0` and `:latest` |
| 3. Build CLI | `npm ci` → `npm run build` → stamps version |
| 4. Package tarballs | Creates `ix-0.3.0-{linux-amd64,darwin-amd64,darwin-arm64}.tar.gz` and `ix-0.3.0-windows-amd64.zip` |
| 5. GitHub Release | Creates release with all assets + install instructions |
| 6. Homebrew | Updates `homebrew/ix.rb` with new URL + SHA256, commits to main |

After the release completes, all install methods (`curl`, `brew`, PowerShell) automatically pick up the new version.

## Releasing a New Version

Versioning is fully automated via [release-please](https://github.com/googleapis/release-please). You don't pick version numbers or create tags manually.

### How it works

1. **You merge PRs to main** using conventional commit messages (`feat:`, `fix:`, `chore:`, etc.)
2. **release-please opens a "Release PR"** automatically — it reads your commits, determines the version bump, and writes a changelog
3. **You merge the Release PR** when you're ready to ship
4. **The tag is created automatically** → triggers the release pipeline → everything is built and published

That's it. You just write good commit messages and merge PRs.

### What commit prefixes do

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `fix:` | Patch (0.1.0 → 0.1.1) | `fix: parser fails on decorators` |
| `feat:` | Minor (0.1.0 → 0.2.0) | `feat: add ix docker command` |
| `feat!:` or `BREAKING CHANGE:` | Major (0.2.0 → 1.0.0) | `feat!: redesign CLI flags` |
| `chore:`, `docs:`, `refactor:` | No release | `docs: update README` |

### Example flow

```
1. You merge "feat: add ix docker command" to main
2. release-please auto-opens PR: "chore(main): release 0.2.0"
   - Contains CHANGELOG.md updates
   - Bumps version in package.json
3. You review and merge that PR
4. Tag v0.2.0 is created → release.yml runs → Docker image pushed,
   tarballs built, GitHub Release created, Homebrew updated
```

### Manual release (if needed)

You can also tag manually to bypass release-please:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## Developer Setup (from source)

```bash
git clone https://github.com/ix-infrastructure/Ix.git
cd Ix
./setup.sh
```

### Testing

```bash
# CLI tests
cd ix-cli && npm test

# Backend tests (requires ArangoDB on localhost:8529)
sbt memoryLayer/test
```

### Useful Scripts

| Script | Purpose |
|--------|---------|
| `./setup.sh` | Full local setup (backend + CLI + hooks) |
| `./scripts/backend.sh up/down/logs/clean` | Manage Docker backend |
| `./scripts/build-cli.sh` | Build the TypeScript CLI |
| `./scripts/connect.sh <dir>` | Connect a project + ingest |
| `./scripts/disconnect.sh <dir>` | Remove project config |

## License

Proprietary — IX Infrastructure.
