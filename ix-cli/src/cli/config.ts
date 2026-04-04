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
  workspace?: string;
  workspaces?: WorkspaceConfig[];
}

const defaultConfig: IxConfig = {
  endpoint: "http://localhost:8090",
  format: "text",
};

export function loadConfig(): IxConfig {
  const configPath = join(homedir(), ".ix", "config.yaml");
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
  const configPath = join(homedir(), ".ix", "config.yaml");
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
  // 3. Named workspace from `ix config set workspace <name>`
  const cfg = loadConfig();
  if (cfg.workspace) {
    const named = loadWorkspaces().find(w => w.workspace_name === cfg.workspace);
    if (named) return named.root_path;
  }
  // 4. Configured default workspace
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) return defaultWs.root_path;
  // 5. Git root
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {}
  // 6. cwd fallback
  return cwd;
}
