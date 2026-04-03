import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";

export interface InstanceConfig {
  endpoint: string;
}

export interface WorkspaceConfig {
  workspace_id: string;
  workspace_name: string;
  root_path: string;
  default: boolean;
  instance?: string;
}

export interface IxConfig {
  endpoint: string;
  format: string;
  active?: string;
  instances?: Record<string, InstanceConfig>;
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

/**
 * Resolve the backend endpoint. Priority:
 * 1. IX_ENDPOINT env var
 * 2. --instance flag (set via setInstanceOverride from Pro/Cloud)
 * 3. Workspace-bound instance (current directory)
 * 4. Active instance in config
 * 5. config.endpoint (default: localhost:8090)
 */
let _instanceOverride: string | undefined;

export function setInstanceOverride(name: string | undefined): void {
  _instanceOverride = name;
}

export function getEndpoint(): string {
  if (process.env.IX_ENDPOINT) return process.env.IX_ENDPOINT;

  const config = loadConfig();
  const instances = config.instances ?? {};

  // --instance flag (set by Pro/Cloud plugin)
  if (_instanceOverride) {
    const inst = instances[_instanceOverride];
    if (!inst) {
      console.error(`Unknown instance: ${_instanceOverride}`);
      console.error(`Available: ${Object.keys(instances).join(", ") || "(none)"}`);
      process.exit(1);
    }
    return inst.endpoint;
  }

  // Workspace-bound instance
  const cwd = process.cwd();
  const ws = findWorkspaceForCwd(cwd);
  if (ws?.instance && instances[ws.instance]) {
    return instances[ws.instance].endpoint;
  }

  // Active instance
  if (config.active && instances[config.active]) {
    return instances[config.active].endpoint;
  }

  return config.endpoint;
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
