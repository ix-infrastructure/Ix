# Upgrade & Versioning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `ix upgrade`, `ix server`, `ix --version`, schema migration framework, manifest system, and rollback/reset so users can self-manage Ix installations.

**Architecture:** CLI commands talk to local manifest files and GitHub Releases API. Server embeds a migration runner that auto-migrates on startup. Upgrade downloads new archives, backs up old state, and replaces binaries.

**Tech Stack:** TypeScript (CLI commands), Scala (migration framework), Node.js fs/child_process (server lifecycle)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `ix-cli/src/cli/commands/upgrade.ts` | `ix upgrade` command — check, download, verify, backup, replace, migrate |
| `ix-cli/src/cli/commands/server.ts` | `ix server start/stop/status` — server lifecycle management |
| `ix-cli/src/cli/commands/reset.ts` | `ix reset` — wipe database without upgrading |
| `ix-cli/src/cli/manifest.ts` | Read/write local manifest.json, fetch remote manifest |
| `ix-cli/src/cli/server-manager.ts` | Auto-start/stop server, PID file management, health checks |
| `ix-cli/src/cli/version-info.ts` | `ix --version` detailed output |
| `memory-layer/src/main/scala/ix/memory/db/migrations/Migration.scala` | Migration trait + runner |
| `memory-layer/src/main/scala/ix/memory/db/migrations/V001_InitialSchema.scala` | Initial schema migration |

### Modified Files

| File | Change |
|------|--------|
| `ix-cli/src/cli/main.ts` | Register upgrade, server, reset commands; add --version handler |
| `ix-cli/src/cli/config.ts` | Export XDG dirs for use by manifest and server-manager |
| `memory-layer/src/main/scala/ix/memory/Main.scala` | Run migration on startup, expose /v1/health and /v1/version |
| `memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala` | Add _ix_meta vertex type for schema version tracking |

---

## Chunk 1: Foundation — Manifest + Server Manager

### Task 1: Create manifest.ts — local and remote manifest operations

**Files:**
- Create: `ix-cli/src/cli/manifest.ts`

- [ ] **Step 1: Write manifest.ts**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./config.js";

export interface PlatformInfo {
  archive: string;
  sha256: string;
}

export interface RemoteManifest {
  version: string;
  channel: string;
  schemaVersion: number;
  released: string;
  platforms: Record<string, PlatformInfo>;
}

export interface LocalManifest {
  version: string;
  channel: string;
  installedAt: string;
  platform: string;
  schemaVersion: number;
  previousVersion?: string;
}

const GITHUB_ORG = "ix-infrastructure";
const GITHUB_REPO = "IX-Memory";

export function getManifestPath(): string {
  return join(getDataDir(), "manifest.json");
}

export function readLocalManifest(): LocalManifest | null {
  const p = getManifestPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function writeLocalManifest(manifest: LocalManifest): void {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

export async function fetchRemoteManifest(channel = "stable"): Promise<RemoteManifest> {
  const url = `https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release = await res.json();
  // Find manifest.json asset
  const asset = release.assets?.find((a: any) => a.name === "manifest.json");
  if (!asset) throw new Error("No manifest.json in latest release");
  const manifestRes = await fetch(asset.browser_download_url);
  return manifestRes.json();
}

export function detectPlatform(): string {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/manifest.ts
git commit -m "feat: add manifest.ts for local/remote manifest operations"
```

---

### Task 2: Create server-manager.ts — PID file, auto-start/stop, health checks

**Files:**
- Create: `ix-cli/src/cli/server-manager.ts`

- [ ] **Step 1: Write server-manager.ts**

Implements:
- `getServerPidPath()` → `getStateDir()/ix-server.pid`
- `getServerLogPath()` → `getStateDir()/ix-server.log`
- `getServerJarPath()` → `getDataDir()/server/ix-memory-layer.jar`
- `isServerRunning()` → read PID file, check if process alive (kill -0)
- `startServer()` → spawn `java -jar <jar>` in background, write PID, wait for health
- `stopServer()` → read PID, send SIGTERM, wait for exit, remove PID file
- `healthCheck()` → GET http://localhost:8090/v1/health with timeout
- `ensureServer()` → if not running, start; return when healthy
- `getServerVersion()` → GET http://localhost:8090/v1/version

Uses `child_process.spawn` with `detached: true` and `stdio: ['ignore', logFd, logFd]` for background server.

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/server-manager.ts
git commit -m "feat: add server-manager.ts for server lifecycle management"
```

---

### Task 3: Create server.ts command — ix server start/stop/status

**Files:**
- Create: `ix-cli/src/cli/commands/server.ts`

- [ ] **Step 1: Write server.ts**

Register subcommands:
- `ix server start` — start server if not running
- `ix server stop` — stop server gracefully
- `ix server status` — show running state, PID, uptime, version

Uses `server-manager.ts` functions. Follow the command pattern:
```typescript
import type { Command } from "commander";
export function registerServerCommand(program: Command): void { ... }
```

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/commands/server.ts
git commit -m "feat: add ix server start/stop/status commands"
```

---

## Chunk 2: Schema Migration Framework

### Task 4: Add _ix_meta schema and Migration trait

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala`
- Create: `memory-layer/src/main/scala/ix/memory/db/migrations/Migration.scala`
- Create: `memory-layer/src/main/scala/ix/memory/db/migrations/V001_InitialSchema.scala`

- [ ] **Step 1: Add _ix_meta to ArcadeSchema**

Add to `ensureSchema()`:
```scala
// _ix_meta vertex type for schema version tracking
if (!db.getSchema.existsType("ix_meta")) {
  val meta = db.getSchema.createVertexType("ix_meta")
  meta.createProperty("schemaVersion", classOf[java.lang.Integer])
  meta.createProperty("appVersion", classOf[java.lang.String])
  meta.createProperty("migratedAt", classOf[java.lang.String])
}
```

- [ ] **Step 2: Create Migration trait**

```scala
package ix.memory.db.migrations

import com.arcadedb.database.Database

trait Migration {
  def version: Int
  def description: String
  def migrate(db: Database): Unit
}
```

Add `MigrationRunner` object:
```scala
object MigrationRunner {
  val migrations: List[Migration] = List(V001_InitialSchema)

  def currentSchemaVersion(db: Database): Int = { /* read ix_meta */ }
  def targetSchemaVersion: Int = migrations.map(_.version).max
  def minSupportedSchema: Int = 1
  def maxSupportedSchema: Int = targetSchemaVersion

  def run(db: Database, appVersion: String): Unit = {
    val current = currentSchemaVersion(db)
    if (current > maxSupportedSchema)
      throw new RuntimeException(s"Database schema $current requires newer Ix. Run `ix upgrade`.")
    val pending = migrations.filter(_.version > current).sortBy(_.version)
    pending.foreach { m =>
      db.transaction(() => { m.migrate(db) })
      // Update ix_meta
    }
  }
}
```

- [ ] **Step 3: Create V001_InitialSchema**

Move existing schema creation from `ArcadeSchema.ensureSchema()` into the migration, so schema creation is migration-driven.

- [ ] **Step 4: Wire migration into Main.scala**

In `Main.scala`, after `ArcadeSchema.ensureSchema(client)`, call `MigrationRunner.run(client.raw, version)`.

Add `/v1/version` endpoint returning JSON with app version, schema version, platform.

Add `/v1/health` endpoint returning `{"status":"ok"}`.

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArcadeSchema.scala
git add memory-layer/src/main/scala/ix/memory/db/migrations/
git add memory-layer/src/main/scala/ix/memory/Main.scala
git commit -m "feat: add schema migration framework with V001 initial migration"
```

---

## Chunk 3: Upgrade Command

### Task 5: Create upgrade.ts — ix upgrade with check, download, backup, rollback, reset

**Files:**
- Create: `ix-cli/src/cli/commands/upgrade.ts`

- [ ] **Step 1: Write upgrade.ts**

The `ix upgrade` command with these flags:
- `--check` — show available version, don't install
- `--version <ver>` — install specific version
- `--channel <ch>` — use channel (default: stable)
- `--rollback` — revert to previous version
- `--reset` — upgrade + wipe database

**Upgrade flow:**
1. Read local manifest → current version, platform
2. Fetch remote manifest from GitHub Releases
3. Compare versions → if same, print "Up to date" and exit
4. If `--check`, print available version and exit
5. Download platform archive to `getCacheDir()/downloads/`
6. Verify SHA-256 checksum
7. Stop server if running (via server-manager)
8. Backup current jar → `getDataDir()/backups/ix-server-<old>.jar`
9. Backup DB → zip `getDataDir()/data/graph/` → `getDataDir()/backups/data-schema-v<N>.zip`
10. Extract new files (replace jar, cli)
11. Start server (triggers migration)
12. Health check
13. Update local manifest
14. Prune old backups (keep 3)

**Rollback flow:**
1. Read local manifest → previousVersion
2. Find backup jar and DB snapshot
3. Stop server
4. Restore from backups
5. Start server, health check
6. Update manifest

**Reset flow:**
1-6 same as upgrade
7. Skip DB backup
8. Delete data/graph/ directory
9. Extract new files, start server (fresh schema)

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/commands/upgrade.ts
git commit -m "feat: add ix upgrade command with rollback and reset support"
```

---

### Task 6: Create reset.ts — ix reset (standalone DB wipe)

**Files:**
- Create: `ix-cli/src/cli/commands/reset.ts`

- [ ] **Step 1: Write reset.ts**

`ix reset` command:
1. Confirm with user (unless `--force`)
2. Stop server
3. Delete `getDataDir()/data/graph/` directory
4. Start server (creates fresh schema)
5. Print success message

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/commands/reset.ts
git commit -m "feat: add ix reset command for database wipe"
```

---

## Chunk 4: Version Info + Wiring

### Task 7: Create version-info.ts and wire --version

**Files:**
- Create: `ix-cli/src/cli/version-info.ts`

- [ ] **Step 1: Write version-info.ts**

```typescript
export async function printVersionInfo(): Promise<void> {
  // Read package.json for CLI version
  // Try to reach server for server version, schema version
  // Detect platform
  // Print formatted output:
  // ix 1.5.0 (stable)
  //   server: 1.5.0
  //   schema: 5
  //   arcade: 26.1.1
  //   platform: darwin-arm64
}
```

If server is not running, show partial info with "(server not running)" for server-specific fields.

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/version-info.ts
git commit -m "feat: add detailed ix --version output"
```

---

### Task 8: Wire all new commands into main.ts

**Files:**
- Modify: `ix-cli/src/cli/main.ts`

- [ ] **Step 1: Update main.ts**

1. Import and register new commands:
   - `registerUpgradeCommand`
   - `registerServerCommand`
   - `registerResetCommand`

2. Add `--version` handler that calls `printVersionInfo()` instead of just printing the version string

3. Update HELP_HEADER with new command categories:
   - Server Management: `server start`, `server stop`, `server status`
   - Upgrade & Maintenance: `upgrade`, `reset`

- [ ] **Step 2: Commit**

```bash
git add ix-cli/src/cli/main.ts
git commit -m "feat: register upgrade, server, reset commands in CLI"
```

---

### Task 9: Update README with user guide

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add install/upgrade/server sections to README**

Add the user guide sections from the design spec:
- Install (curl, PowerShell, CMD, Homebrew)
- Getting Started
- Upgrade
- Rollback
- Reset
- Version Info
- Server Management
- Diagnostics

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add install, upgrade, and server management user guide to README"
```
