# Ix Install, Upgrade & Versioning System Design

**Date:** 2026-03-12
**Status:** Approved
**Scope:** Cross-platform installation, `ix upgrade` command, schema migration, versioning, ArcadeDB migration

---

## Overview

Replace the current Docker-based deployment (ArangoDB + Scala server in containers) with a single embedded JVM process (Scala server + ArcadeDB in-process). Provide cross-platform install scripts, a self-upgrade command, schema migration framework, and versioning system.

**Goal:** A user runs one command to install Ix. One command to upgrade. No Docker. No manual setup. Works on macOS, Linux, Windows, WSL.

---

## Architecture Change

```
BEFORE:
  ix CLI (Node.js) → HTTP :8090 → Scala server (Docker) → HTTP :8529 → ArangoDB (Docker)
  Requires: Docker, 2 containers, 2 network hops

AFTER:
  ix CLI (Node.js) → HTTP :8090 → Scala server (single JVM process, ArcadeDB embedded)
  Requires: nothing — ix manages everything
```

ArcadeDB is an Apache 2.0 embedded graph database. Property graph model, Cypher/Gremlin/SQL queries, index-free adjacency for O(1) traversals, WAL-based ACID persistence. Runs in-process — no separate server, no network, no Docker.

---

## Version System

Three version numbers tracked independently:

| Version | Where It Lives | What It Tracks |
|---------|---------------|----------------|
| App version | `package.json` + `build.sbt` (synced) | The release — `1.2.0` |
| DB schema version | `_ix_meta` vertex in ArcadeDB graph | Schema shape — `1`, `2`, `3`... |
| Compatibility range | Hardcoded in server binary | Min/max schema version this binary supports |

### Semver Rules

- **MAJOR** — breaking CLI syntax, breaking API, destructive schema migration
- **MINOR** — new commands, new endpoints, additive schema migrations
- **PATCH** — bug fixes, performance, no schema changes
- **Pre-release** — channel tags: `1.2.0-beta.1`
- **Build metadata** — traceability: `1.2.0+git.abc1234`

### Version Compatibility on Startup

```
Server starts:
  1. Read _ix_meta → schemaVersion = 3
  2. Is 3 within supported range [2..5]? → yes
  3. Is 3 < target (5)? → run migrations 4 and 5
  4. DB now at schema 5, proceed

Server starts against schema from newer Ix:
  1. Read _ix_meta → schemaVersion = 7
  2. Is 7 within supported range [2..5]? → NO
  3. Error: "Database requires Ix 1.6.0+. Run `ix upgrade`."
```

### `ix --version` Output

```
ix 1.5.0 (stable)
  server: 1.5.0
  schema: 5
  arcade: 26.3.1
  platform: darwin-arm64
```

---

## Directory Layout

### macOS / Linux (XDG-compliant)

```
~/.local/bin/
  ix                              # CLI entry point

~/.local/share/ix/
  server/
    ix-server.jar                 # Fat JAR (Scala server + ArcadeDB, ~35MB)
    jre/                          # Bundled Java 21 runtime (~45MB)
  backups/
    ix-server-1.4.0.jar           # Previous version (rollback)
    data-schema-v3.zip            # DB snapshot before last migration
  data/
    graph/                        # ArcadeDB data files
  manifest.json                   # Installed version metadata

~/.config/ix/
  config.toml                     # User settings (channel, endpoint override)
  workspaces.toml                 # Registered project workspaces

~/.local/state/ix/
  ix-server.pid                   # Server PID file
  ix-server.log                   # Server log (rotated)

~/.cache/ix/
  downloads/                      # Cached release archives
```

### Windows

```
%LOCALAPPDATA%\ix\bin\ix.exe
%LOCALAPPDATA%\ix\server\ix-server.jar
%LOCALAPPDATA%\ix\server\jre\
%LOCALAPPDATA%\ix\data\graph\
%LOCALAPPDATA%\ix\backups\
%APPDATA%\ix\config.toml
%APPDATA%\ix\workspaces.toml
```

---

## Manifests

### Remote Manifest (GitHub Releases)

Uploaded as a release asset alongside platform archives. Source of truth for what's available.

```json
{
  "version": "1.5.0",
  "channel": "stable",
  "schemaVersion": 5,
  "released": "2026-03-12T10:00:00Z",
  "platforms": {
    "darwin-arm64": {
      "archive": "ix-1.5.0-darwin-arm64.tar.gz",
      "sha256": "a1b2c3d4..."
    },
    "darwin-amd64": {
      "archive": "ix-1.5.0-darwin-amd64.tar.gz",
      "sha256": "e5f6a7b8..."
    },
    "linux-arm64": { "archive": "...", "sha256": "..." },
    "linux-amd64": { "archive": "...", "sha256": "..." },
    "windows-amd64": { "archive": "...", "sha256": "..." },
    "windows-arm64": { "archive": "...", "sha256": "..." }
  }
}
```

### Local Manifest (~/.local/share/ix/manifest.json)

Tracks what's currently installed. Written by installer, updated by `ix upgrade`.

```json
{
  "version": "1.5.0",
  "channel": "stable",
  "installedAt": "2026-03-12T10:00:00Z",
  "platform": "darwin-arm64",
  "schemaVersion": 5,
  "previousVersion": "1.4.0"
}
```

---

## Installation

### macOS, Linux, WSL

```bash
curl -fsSL https://ix.dev/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://ix.dev/install.ps1 | iex
```

### Windows CMD

```cmd
curl -fsSL https://ix.dev/install.cmd -o install.cmd && install.cmd && del install.cmd
```

### Homebrew

```bash
brew install ix
```

### Install Script Behavior

1. Detect OS (`Darwin`/`Linux`) and arch (`arm64`/`amd64`)
2. Fetch remote `manifest.json` from latest GitHub Release
3. Download platform archive (`ix-<version>-<os>-<arch>.tar.gz`)
4. Verify SHA-256 checksum
5. Extract to `~/.local/share/ix/` (server + JRE) and `~/.local/bin/ix` (CLI)
6. Add `~/.local/bin` to PATH in shell rc file if not present
7. Write local `manifest.json`
8. Run `ix --version` to verify

Flags:
- `bash -s -- --no-modify-path` — skip PATH modification
- `bash -s -- --version 1.2.0` — install specific version
- `bash -s -- --channel beta` — install from beta channel

### Homebrew Formula

- Downloads platform archive from GitHub Releases (same archives as curl install)
- Extracts server + JRE to `$(brew --prefix)/lib/ix/`
- Symlinks CLI to `$(brew --prefix)/bin/ix`
- Does NOT run migrations — that happens on next `ix` command (server auto-start)

---

## Upgrade

### Commands

```bash
ix upgrade                # upgrade to latest stable
ix upgrade --check        # check what's available, don't install
ix upgrade --version 1.6.0   # install specific version
ix upgrade --channel beta    # switch to beta channel
ix upgrade --rollback     # revert to previous version
ix upgrade --reset        # upgrade + wipe database (fresh start)
```

### Upgrade Flow

```
ix upgrade
  1. Read local manifest → current version, platform, channel
  2. Fetch remote manifest from GitHub Releases for selected channel
  3. Compare versions → same? "Up to date." exit
  4. Download platform archive to ~/.cache/ix/downloads/
  5. Verify SHA-256 checksum → mismatch? abort
  6. Stop server if running (read PID, graceful shutdown)
  7. Backup current state:
     - Copy ix-server.jar → backups/ix-server-<old-version>.jar
     - Snapshot DB → backups/data-schema-v<N>.zip
  8. Extract new files (replace jar, jre, CLI binary)
  9. Start server (triggers schema migration on startup)
  10. Health check → GET /v1/health
      - Failed? Offer rollback
  11. Update local manifest (new version, previousVersion)
  12. Prune old backups (keep last 3)
```

### Rollback

Reverts to the previous version. Used when an upgrade introduced a bug.

```
ix upgrade --rollback
  1. Read local manifest → previousVersion
  2. Find backup jar + DB snapshot
  3. Stop server
  4. Restore jar from backup
  5. Restore DB files from snapshot
  6. Start server
  7. Health check
  8. Update local manifest
```

Rollback restores the binary AND the database to the exact state before the upgrade. Any data created after the upgrade is lost.

### Reset

Wipes the database entirely. Used when the graph is corrupted or you want a fresh start.

```
ix upgrade --reset
  1-6. Same as normal upgrade
  7. Skip DB backup (user chose to wipe)
  8. Extract new files
  8.5. Delete ~/.local/share/ix/data/graph/ entirely
  9. Server starts fresh, creates empty schema
  10-12. Same as normal upgrade
```

Reset deletes all graph data — nodes, edges, claims, decisions, plans, bugs. Config and workspace registrations are preserved. Re-ingest with `ix ingest ./src --recursive`.

---

## Schema Migration System

### Storage

Schema version stored as a `_ix_meta` vertex type in the ArcadeDB graph:

```json
{
  "schemaVersion": 5,
  "appVersion": "1.5.0",
  "migratedAt": "2026-03-12T10:00:00Z"
}
```

### Migration Files

Scala files embedded in the server jar:

```
memory-layer/src/main/scala/ix/memory/db/migrations/
  V001_InitialSchema.scala
  V002_AddClaimsType.scala
  V003_AddPatchesType.scala
  V004_AddBugNodeKind.scala
  V005_AddCompositeIndexes.scala
```

Each implements:

```scala
trait Migration {
  def version: Int
  def description: String
  def migrate(db: ArcadeDatabase): Unit
}
```

### Migration Rules

- **Forward-only** — no down migrations. Rollback restores from backup.
- **Additive by default** — new types, indexes, properties don't break old data.
- **Destructive migrations** (rename, remove) bump MAJOR version.
- **Each migration runs in a transaction** — failure leaves DB at previous version.
- **Migrations are idempotent** — check if type/index exists before creating.

### Schema Change Classification

| Change | Schema bump | App version bump |
|--------|------------|-----------------|
| New vertex/edge type | +1 | MINOR |
| New index | +1 | MINOR |
| New property on existing type | +1 | MINOR |
| Rename type/property | +1 | MAJOR |
| Remove type/property | +1 | MAJOR |
| Query logic change (no schema) | none | PATCH or MINOR |

---

## Server Lifecycle

The CLI auto-manages the server process:

- **Auto-start:** Any `ix` command checks PID file → health check → spawns server if not running
- **Background process:** Server runs in background, not a daemon/service
- **Auto-shutdown:** Server stops after 30 min idle (configurable)
- **Manual control:** `ix server start`, `ix server stop`, `ix server status`

---

## Release Pipeline

### Local: `./scripts/release.sh 1.5.0`

1. Validate clean git tree, on main branch, version > current
2. Bump versions in `build.sbt` and `package.json`
3. Commit: `release: 1.5.0`
4. Tag: `v1.5.0`
5. Push to GitHub with tags

### CI: GitHub Actions on tag `v*`

Build matrix for 6 platforms:
- `darwin-arm64`, `darwin-amd64`
- `linux-arm64`, `linux-amd64`
- `windows-amd64`, `windows-arm64`

For each platform:
1. `sbt assembly` → ix-server.jar (built once, same across platforms)
2. `npm run build` → ix CLI
3. Download platform JRE (Adoptium Temurin 21)
4. Package archive (tar.gz or zip)
5. Compute SHA-256 checksum

Then:
6. Generate `manifest.json` with all platform checksums
7. Create GitHub Release with all archives + manifest
8. PR to Homebrew tap with updated formula

---

## Release Artifacts

```
GitHub Release: v1.5.0
  ix-1.5.0-darwin-arm64.tar.gz
  ix-1.5.0-darwin-amd64.tar.gz
  ix-1.5.0-linux-arm64.tar.gz
  ix-1.5.0-linux-amd64.tar.gz
  ix-1.5.0-windows-amd64.zip
  ix-1.5.0-windows-arm64.zip
  manifest.json
```

Each archive contains:
```
ix-1.5.0-darwin-arm64/
  ix                    # CLI binary
  ix-server.jar         # Fat JAR (server + ArcadeDB)
  jre/                  # Bundled Java 21 runtime
```

---

## Codebase Changes

### New Files

| File | Purpose |
|------|---------|
| `ix-cli/src/cli/commands/upgrade.ts` | Upgrade command |
| `ix-cli/src/cli/commands/server.ts` | Server lifecycle (start/stop/status) |
| `ix-cli/src/cli/manifest.ts` | Read/write local manifest, XDG paths |
| `memory-layer/.../db/ArcadeClient.scala` | ArcadeDB embedded client |
| `memory-layer/.../db/ArcadeGraphQueryApi.scala` | Cypher-based graph queries |
| `memory-layer/.../db/ArcadeGraphWriteApi.scala` | Graph write operations |
| `memory-layer/.../db/ArcadeSchema.scala` | Schema init + migration runner |
| `memory-layer/.../db/migrations/V001_InitialSchema.scala` | Initial migration |
| `install.sh` | macOS/Linux/WSL installer |
| `install.ps1` | Windows PowerShell installer |
| `install.cmd` | Windows CMD wrapper |
| `.github/workflows/release.yml` | CI release pipeline |

### Modified Files

| File | Change |
|------|--------|
| `memory-layer/.../Main.scala` | Wire ArcadeDB instead of ArangoDB |
| `ix-cli/src/cli/main.ts` | Add upgrade + server commands, auto-start logic |
| `ix-cli/src/cli/config.ts` | XDG directory paths, manifest read/write |
| `ix-cli/package.json` | Version field (synced with build.sbt) |
| `build.sbt` | Add ArcadeDB dependency, remove ArangoDB driver |
| `homebrew/ix.rb` | Archive-based install (no npm build step) |
| `scripts/release.sh` | Rewrite for multi-platform manifest release |

### Removed Files

| File | Reason |
|------|--------|
| `docker-compose.yml` | No longer needed |
| `memory-layer/Dockerfile` | No longer needed |
| `scripts/backend.sh` | Replaced by `ix server` command |
| `memory-layer/.../db/ArangoClient.scala` | Replaced by ArcadeClient |
| `memory-layer/.../db/ArangoGraphQueryApi.scala` | Replaced by ArcadeGraphQueryApi |
| `memory-layer/.../db/ArangoGraphWriteApi.scala` | Replaced by ArcadeGraphWriteApi |
| `memory-layer/.../db/ArangoSchema.scala` | Replaced by ArcadeSchema |
| `memory-layer/.../db/BulkWriteApi.scala` | Merged into ArcadeGraphWriteApi |

### Unchanged

- All 40+ existing CLI commands
- MCP server
- All parsers (Python, TypeScript, Scala, Config, Markdown)
- Ingestion pipeline (GraphPatchBuilder, BulkIngestionService, ParserRouter, FileDiscovery, Fingerprint)
- Context pipeline (ContextService, GraphSeeder, GraphExpander, ClaimCollector, ConfidenceScorer, RelevanceScorer, ContextRanker, ConflictDetector)
- `GraphQueryApi` / `GraphWriteApi` traits (interfaces unchanged)
- Data model (Node, Edge, Claim, Patch, Provenance, StructuredContext)

---

## README User Guide

### Install

macOS, Linux, WSL:

```bash
curl -fsSL https://ix.dev/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://ix.dev/install.ps1 | iex
```

Windows CMD:

```cmd
curl -fsSL https://ix.dev/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Homebrew:

```bash
brew install ix
```

### Getting Started

```bash
cd your-project
ix init                          # register workspace, set up MCP
ix ingest ./src --recursive      # parse codebase into knowledge graph
ix overview YourMainClass        # explore what Ix knows
```

### Upgrade

```bash
ix upgrade                       # upgrade to latest stable version
ix upgrade --check               # see what's available without installing
ix upgrade --version 1.6.0       # install a specific version
ix upgrade --channel beta        # switch to beta channel
```

### Rollback

If an upgrade caused issues, revert to the previous version:

```bash
ix upgrade --rollback
```

This restores both the binary and database to their state before the last upgrade.

### Reset

Start fresh with an empty database:

```bash
ix upgrade --reset               # upgrade and wipe database
ix reset                         # wipe database without upgrading
```

After a reset, re-ingest your codebase:

```bash
ix ingest ./src --recursive
```

### Version Info

```bash
ix --version
```

```
ix 1.5.0 (stable)
  server: 1.5.0
  schema: 5
  arcade: 26.3.1
  platform: darwin-arm64
```

### Server Management

The server starts automatically when you run any `ix` command. For manual control:

```bash
ix server status                 # check if server is running
ix server start                  # start manually
ix server stop                   # stop the server
```

The server auto-shuts down after 30 minutes of inactivity.

### Diagnostics

```bash
ix doctor                        # full health check
ix status                        # backend health + graph freshness
ix stats                         # graph node/edge counts
```

---

## Best Practices Applied

| Practice | Standard | How Applied |
|----------|----------|-------------|
| Semantic Versioning | semver.org | MAJOR.MINOR.PATCH with pre-release tags |
| XDG Base Directory | freedesktop.org | Config, data, state, cache in standard locations |
| Checksum Verification | SHA-256 | Every download verified against manifest |
| Atomic Install | Deno/Rustup pattern | Download to temp, verify, then replace |
| Forward-Only Migration | Flyway pattern | No down migrations, backup + rollback instead |
| Backup Before Migrate | Database best practice | DB snapshot before every schema migration |
| POSIX Install Script | `#!/bin/sh`, `set -eu` | Max portability, no bash-isms |
| Auto-Start Server | Ollama pattern | CLI spawns server on demand |
| Release Channels | Rust train model | stable/beta channels via manifest |
| Version Compatibility | Matrix pattern | CLI checks server version, server checks schema version |
