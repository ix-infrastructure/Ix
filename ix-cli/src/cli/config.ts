import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";

export interface WorkspaceConfig {
  workspace_id: string;
  workspace_name: string;
  root_path: string;
  default: boolean;
}

export interface IxConfig {
  endpoint: string;
  format: string;
  workspaces?: WorkspaceConfig[];
}

const defaultConfig: IxConfig = {
  endpoint: "http://localhost:8090",
  format: "text",
};

const isWindows = process.platform === "win32";

export function getDataDir(): string {
  if (process.env.IX_DATA_DIR) return process.env.IX_DATA_DIR;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "ix");
  if (isWindows) return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ix", "data");
  return join(homedir(), ".local", "share", "ix");
}

export function getConfigDir(): string {
  if (process.env.IX_CONFIG_DIR) return process.env.IX_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "ix");
  if (isWindows) return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "ix");
  return join(homedir(), ".config", "ix");
}

export function getStateDir(): string {
  if (process.env.IX_STATE_DIR) return process.env.IX_STATE_DIR;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "ix");
  if (isWindows) return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ix", "state");
  return join(homedir(), ".local", "state", "ix");
}

export function getCacheDir(): string {
  if (process.env.IX_CACHE_DIR) return process.env.IX_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "ix");
  if (isWindows) return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ix", "cache");
  return join(homedir(), ".cache", "ix");
}

export function loadConfig(): IxConfig {
  const configPath = join(getConfigDir(), "config.yaml");
  if (!existsSync(configPath)) return defaultConfig;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as Partial<IxConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return defaultConfig;
  }
}

export function saveConfig(config: IxConfig): void {
  const configPath = join(getConfigDir(), "config.yaml");
  writeFileSync(configPath, stringify(config));
}

export function getEndpoint(): string {
  return process.env.IX_ENDPOINT || loadConfig().endpoint;
}

export function loadWorkspaces(): WorkspaceConfig[] {
  const config = loadConfig();
  return config.workspaces ?? [];
}

export function findWorkspaceForCwd(cwd: string): WorkspaceConfig | undefined {
  const workspaces = loadWorkspaces();
  return workspaces
    .filter(w => cwd.startsWith(w.root_path))
    .sort((a, b) => b.root_path.length - a.root_path.length)[0];
}

export function getDefaultWorkspace(): WorkspaceConfig | undefined {
  return loadWorkspaces().find(w => w.default);
}

export function resolveWorkspaceRoot(explicitRoot?: string): string {
  // 1. Explicit --root
  if (explicitRoot) return explicitRoot;
  // 2. Nearest initialized workspace containing cwd
  const cwd = process.cwd();
  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return nearest.root_path;
  // 3. Configured default workspace
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) return defaultWs.root_path;
  // 4. Git root
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {}
  // 5. cwd fallback
  return cwd;
}
