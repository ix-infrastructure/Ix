import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { IxClient } from "../client/api.js";
import { getEndpoint, loadConfig, saveConfig, findWorkspaceForCwd, getDefaultWorkspace, type WorkspaceConfig } from "./config.js";

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

/**
 * Ensure the current directory (or given path) is registered as a workspace.
 * Returns the workspace name. Does nothing if already registered.
 */
function getOrCreateWorkspace(cwd: string): { ws: WorkspaceConfig; created: boolean } {
  const rootPath = resolve(cwd);
  const config = loadConfig();
  const existing = (config.workspaces ?? []).find(w => w.root_path === rootPath);
  if (existing) return { ws: existing, created: false };

  const workspaces = config.workspaces ?? [];
  const hasDefault = workspaces.some(w => w.default);
  const ws: WorkspaceConfig = {
    workspace_id: randomUUID().slice(0, 8),
    workspace_name: basename(rootPath),
    root_path: rootPath,
    default: !hasDefault,
  };
  config.workspaces = [...workspaces, ws];
  saveConfig(config);
  return { ws, created: true };
}

export function ensureWorkspaceRegistered(cwd = process.cwd()): { registered: boolean; name: string } {
  const { ws, created } = getOrCreateWorkspace(cwd);
  return { registered: created, name: ws.workspace_name };
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
 * Full lazy bootstrap. Call at the top of map/watch actions.
 * Prints user-friendly output only on first run (when something was created).
 */
export async function bootstrap(cwd = process.cwd()): Promise<void> {
  const createdConfig = ensureLocalConfig();
  const { registered, name } = ensureWorkspaceRegistered(cwd);

  if (createdConfig || registered) {
    console.log(chalk.bold("Ix\n"));
    if (createdConfig) console.log(chalk.dim(`Created default config.`));
    if (registered)    console.log(chalk.dim(`Registered workspace "${name}".`));
    console.log();
  }

  await ensureBackendAvailable();
}
