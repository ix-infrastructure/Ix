import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { IxClient } from "../client/api.js";
import { getEndpoint, loadConfig, saveConfig, type WorkspaceConfig } from "./config.js";

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
export function ensureWorkspaceRegistered(cwd = process.cwd()): { registered: boolean; name: string } {
  const rootPath = resolve(cwd);
  const name = basename(rootPath);
  const config = loadConfig();
  const existing = (config.workspaces ?? []).find(w => w.root_path === rootPath);
  if (existing) return { registered: false, name: existing.workspace_name };

  const workspaces = config.workspaces ?? [];
  const hasDefault = workspaces.some(w => w.default);
  const newWs: WorkspaceConfig = {
    workspace_id: randomUUID().slice(0, 8),
    workspace_name: name,
    root_path: rootPath,
    default: !hasDefault,
  };
  config.workspaces = [...workspaces, newWs];
  saveConfig(config);
  return { registered: true, name };
}

/**
 * Ensure the backend is reachable. Throws with a friendly message if not.
 */
export async function ensureBackendAvailable(): Promise<void> {
  const endpoint = getEndpoint();
  const client = new IxClient(endpoint);
  try {
    await client.health();
  } catch {
    throw new Error(
      `Ix backend not reachable at ${endpoint}\n` +
      `  Run: ix docker start`
    );
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
