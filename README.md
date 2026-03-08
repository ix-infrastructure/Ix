# Ix Memory

Persistent, time-aware memory for LLM coding assistants. Ix builds a versioned knowledge graph from your codebase and gives LLMs structured context with confidence scores — so they answer from facts, not training data.

## What It Does

- **Ingests** source files (Python, TypeScript, YAML, JSON, TOML, Markdown) into a knowledge graph
- **Queries** return structured context: nodes, edges, claims, conflicts, and decisions — each with 6-factor confidence scores
- **Tracks decisions** with rationale linked to project intents, so future sessions know *why* things were built
- **Detects conflicts** when the graph contains contradictory claims
- **Versions everything** — every change is a patch with provenance, so you can diff and time-travel

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Java | 17+ | `java -version` |
| sbt | 1.x | `sbt --version` |
| Docker | 20+ | `docker --version` |
| Node.js | 18+ | `node --version` |
| npm | 9+ | `npm --version` |

## Quickstart

### 1. Start the backend

```bash
# Production mode (Docker handles everything)
./stack.sh

# Or dev mode (ArangoDB in Docker, Memory Layer via sbt for hot reload)
./dev.sh
cd memory-layer && sbt run   # in another terminal
```

The backend is ready when you see:
```
Ix Memory backend is ready at http://localhost:8090
```

### 2. Install CLI dependencies

```bash
cd ix-cli && npm install
```

### 3. Initialize Ix in your project

```bash
cd /path/to/your/project
npx tsx /path/to/ix-cli/src/cli/main.ts init
```

This checks the backend is running, creates `~/.ix/config.yaml`, and adds Ix rules to your `CLAUDE.md`.

### 4. Ingest your codebase

```bash
ix ingest ./src --recursive
```

### 5. Explore

```bash
ix search "UserService" --kind class
ix explain UserService
ix callers UserService
```

## CLI Commands

All commands accept `--format json` for machine-readable output.

### Core

| Command | Usage | Description |
|---------|-------|-------------|
| `ix status` | `ix status` | Check backend health |
| `ix ingest` | `ix ingest <path> [--recursive]` | Ingest source files |
| `ix search` | `ix search <term> [--limit N]` | Search nodes by term |
| `ix explain` | `ix explain <symbol>` | Understand an entity |
| `ix callers` | `ix callers <symbol>` | What calls a function |
| `ix callees` | `ix callees <symbol>` | What a function calls |
| `ix contains` | `ix contains <symbol>` | Members of a class/module |
| `ix imports` | `ix imports <symbol>` | What an entity imports |
| `ix depends` | `ix depends <symbol>` | Dependency impact analysis |
| `ix text` | `ix text <term>` | Fast lexical search (ripgrep) |
| `ix read` | `ix read <target>` | Read source code |
| `ix locate` | `ix locate <symbol>` | Find a symbol (graph + text) |
| `ix query` | `ix query <question> --unsafe` | [DEPRECATED] Broad graph query |

### Decisions & Intents

| Command | Usage | Description |
|---------|-------|-------------|
| `ix decide` | `ix decide <title> --rationale <text> [--intent-id <id>]` | Record a design decision |
| `ix truth list` | `ix truth list` | List all project intents |
| `ix truth add` | `ix truth add <statement> [--parent <id>]` | Add a project intent/goal |

### Inspection

| Command | Usage | Description |
|---------|-------|-------------|
| `ix entity` | `ix entity <id>` | Get entity details (node, claims, edges) |
| `ix history` | `ix history <entityId>` | Show provenance chain for an entity |
| `ix patches` | `ix patches` | List recent patches |
| `ix diff` | `ix diff <fromRev> <toRev> --entity <id>` | Show changes between revisions |
| `ix conflicts` | `ix conflicts` | List detected conflicts |

### Setup

| Command | Usage | Description |
|---------|-------|-------------|
| `ix init` | `ix init [--force]` | Initialize Ix in the current project |
| `ix mcp-install` | `ix mcp-install [--cursor\|--claude-code]` | Install MCP server config |
| `ix mcp-start` | `ix mcp-start` | Start the MCP server (stdio) |

## MCP Integration (Compatibility Only)

> **Note:** The CLI is now the canonical agent interface. MCP is retained for backward compatibility but is no longer the recommended integration path. Use `ix` CLI commands with `--format json` instead.

MCP server installation is still available if needed:

```bash
ix mcp-install --claude-code    # Claude Code
ix mcp-install --cursor         # Cursor
ix mcp-install                  # Claude Desktop
```

## Architecture

```
                    ┌──────────────────┐     ┌───────────┐
┌─────────────┐    │  Memory Layer    │────>│ ArangoDB  │
│  ix CLI     │───>│  (Scala/http4s)  │     │  (Graph)  │
│  (canonical)│    └──────────────────┘     └───────────┘
└─────────────┘              ▲
                    ┌────────┘
                    │
              ┌─────┴───────┐
              │  MCP Server │  (compatibility only)
              └─────────────┘
```

- **Memory Layer** — Scala 2.13, Cats Effect 3, http4s 0.23, Circe. Handles ingestion, parsing, graph operations, context assembly with 6-factor confidence scoring.
- **CLI + MCP** — TypeScript, Commander, MCP SDK. Thin client that talks to the Memory Layer REST API.
- **ArangoDB** — Multi-model database used as the graph store. All nodes, edges, claims, and patches stored here.

## Supported File Types

| Extension | Parser | What It Extracts |
|-----------|--------|------------------|
| `.py` | Tree-sitter | Modules, classes, functions, imports, calls |
| `.ts`, `.tsx` | Regex | Classes, functions, interfaces, imports, calls |
| `.json`, `.yaml`, `.yml`, `.toml` | Config | Config entries, nested keys, values |
| `.md` | Markdown | Document sections by heading hierarchy |

## Confidence Scoring

Every claim returned by `ix query` includes a 6-factor confidence breakdown:

| Factor | What It Measures |
|--------|-----------------|
| **Base Authority** | Source type weight (code > config > docs > inferred) |
| **Verification** | Whether the claim has been independently verified |
| **Recency** | How recently the source was observed |
| **Corroboration** | How many independent sources confirm the claim |
| **Conflict Penalty** | Reduction if the claim is part of a detected conflict |
| **Intent Alignment** | Whether the claim connects to a stated project goal |

Final score = `base × verification × recency × corroboration × conflict_penalty × intent_alignment`

## Scripts

| Script | Description |
|--------|-------------|
| `./stack.sh` | Build JAR + start full stack via Docker Compose |
| `./stack.sh down` | Stop the stack |
| `./stack.sh clean` | Stop + remove data volumes |
| `./stack.sh logs` | Tail container logs |
| `./dev.sh` | Start only ArangoDB (for dev — run `sbt run` separately) |
| `./dev.sh down` | Stop ArangoDB |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IX_ENDPOINT` | `http://localhost:8090` | Memory Layer URL (used by CLI and MCP) |
| `ARANGO_HOST` | `localhost` | ArangoDB host |
| `ARANGO_PORT` | `8529` | ArangoDB port |
| `ARANGO_DATABASE` | `ix_memory` | ArangoDB database name |
| `ARANGO_USER` | `root` | ArangoDB user |
| `ARANGO_PASSWORD` | (empty) | ArangoDB password |

## License

Proprietary — IX Infrastructure.
