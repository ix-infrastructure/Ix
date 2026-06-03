import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { IxClient } from "../client/api.js";
import { getEndpoint, loadConfig, saveConfig, findWorkspaceForCwd, getDefaultWorkspace, type WorkspaceConfig } from "./config.js";
import { workspaceIdForPath } from "./system.js";

export interface BootstrapResult {
  createdConfig: boolean;
  registeredWorkspace: boolean;
  workspaceName: string;
}

/**
 * Ensure ~/.ix/config.yaml exists. Creates it silently if missing.
 * Returns true if it was just created.
 */
export function ensureLocalConfig(): boolean {
  const configDir = join(homedir(), ".ix");
  const configPath = join(configDir, "config.yaml");
  if (existsSync(configPath)) return false;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, `endpoint: ${getEndpoint()}\nformat: text\n`);
  return true;
}

// Roots whose workspace_id was re-keyed to the path-based id during THIS process.
// getOrCreateWorkspace is called more than once per `ix map` (bootstrap() registers,
// then ingest resolves the id); the first call does the actual re-key, so without
// this the second call would report migrated=false and the ingest would skip the
// forced re-ingest. Keyed by resolved root path.
const migratedRootsThisRun = new Set<string>();

/**
 * Ensure the current directory (or given path) is registered as a workspace.
 * Returns the workspace name. Does nothing if already registered.
 */
function getOrCreateWorkspace(cwd: string): { ws: WorkspaceConfig; created: boolean; migrated: boolean } {
  const rootPath = resolve(cwd);
  const config = loadConfig();
  const pathId = workspaceIdForPath(rootPath);
  const existing = (config.workspaces ?? []).find(w => w.root_path === rootPath);
  if (existing) {
    // Migrate a legacy random workspace_id to the path-based id (Ix#225 gap 2) so
    // an already-registered repo converges with co-ingest. This changes the
    // workspace_id that node identity folds, so the next map must re-ingest under
    // the new id (the caller forces that — see ingest's migration handling). Old
    // nodes under the random id are left as orphans until a reset.
    if (existing.workspace_id !== pathId) {
      existing.workspace_id = pathId;
      saveConfig(config);
      migratedRootsThisRun.add(rootPath);
      return { ws: existing, created: false, migrated: true };
    }
    return { ws: existing, created: false, migrated: migratedRootsThisRun.has(rootPath) };
  }

  const workspaces = config.workspaces ?? [];
  const hasDefault = workspaces.some(w => w.default);
  const ws: WorkspaceConfig = {
    // Path-based id (NOT random): a repo mapped standalone must get the same
    // workspace_id it gets as a member of a system, so its node identity is
    // byte-identical across both. Shared with repoWorkspaceIdFor via system.ts.
    workspace_id: pathId,
    workspace_name: basename(rootPath),
    root_path: rootPath,
    default: !hasDefault,
  };
  config.workspaces = [...workspaces, ws];
  saveConfig(config);
  return { ws, created: true, migrated: false };
}

export function ensureWorkspaceRegistered(cwd = process.cwd()): { registered: boolean; name: string } {
  const { ws, created } = getOrCreateWorkspace(cwd);
  return { registered: created, name: ws.workspace_name };
}

/**
 * Like ensureWorkspaceId, but also reports whether the workspace_id was just
 * migrated from a legacy random id to the path-based id. The map/ingest flow uses
 * `migrated` to force a full re-ingest under the new id.
 */
export function ensureWorkspaceIdState(cwd = process.cwd()): { workspaceId: string; migrated: boolean } {
  const { ws, migrated } = getOrCreateWorkspace(cwd);
  return { workspaceId: ws.workspace_id, migrated };
}

/**
 * Resolve the stable workspace id for a root, registering the workspace (and
 * persisting a fresh id) on first use. This id is folded into node identity by
 * core-ingestion, so it must be stable for a given workspace root and distinct
 * across roots — that is what keeps two workspaces with the same relative layout
 * from colliding on a shared backend.
 */
export function ensureWorkspaceId(cwd = process.cwd()): string {
  return getOrCreateWorkspace(cwd).ws.workspace_id;
}

/**
 * Resolve the workspace id for a READ, without creating one. Returns the id of the
 * nearest registered workspace containing cwd, else the default workspace, else
 * undefined — meaning an unscoped/global read, preserving back-compat for callers
 * run outside any registered workspace.
 */
export function resolveWorkspaceId(cwd = process.cwd()): string | undefined {
  return (findWorkspaceForCwd(cwd) ?? getDefaultWorkspace())?.workspace_id;
}

/**
 * Ensure the backend is reachable. If not, auto-start via ix docker start.
 */
export async function ensureBackendAvailable(): Promise<void> {
  const client = new IxClient(getEndpoint());
  try {
    await client.health();
  } catch {
    try {
      execFileSync("ix", ["docker", "start"], { stdio: "inherit", timeout: 120000 });
    } catch {
      throw new Error("Failed to start Ix backend. Run: ix docker start");
    }
  }
}

/**
 * Emit the one-time "Ix / Created config / Registered workspace" setup notice.
 *
 * These are side-effect messages, not program output, so they go to stderr —
 * keeping stdout clean for `--format json|llm` consumers (a banner on stdout
 * corrupts the first machine-readable response after a workspace is registered).
 */
export function emitSetupNotice(createdConfig: boolean, registered: boolean, name: string): void {
  if (!createdConfig && !registered) return;
  console.error(chalk.bold("Ix\n"));
  if (createdConfig) console.error(chalk.dim(`Created default config.`));
  if (registered)    console.error(chalk.dim(`Registered workspace "${name}".`));
  console.error();
}

/**
 * Full lazy bootstrap. Call at the top of map/watch actions.
 * Prints user-friendly output only on first run (when something was created).
 */
export async function bootstrap(cwd = process.cwd()): Promise<void> {
  const createdConfig = ensureLocalConfig();
  const { registered, name } = ensureWorkspaceRegistered(cwd);

  emitSetupNotice(createdConfig, registered, name);

  await ensureBackendAvailable();
}
