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

export interface InstanceAuth {
  api_key: string;
  token: string;
  expires_at: string;
  org_id: string;
  plan: string;
}

export interface InstanceConfig {
  endpoint: string;
  auth?: InstanceAuth;
}

export interface IxConfig {
  endpoint: string;
  format: string;
  workspace?: string;
  workspaces?: WorkspaceConfig[];
  instances?: Record<string, InstanceConfig>;
  active?: string;
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

export function getActiveInstance(): InstanceConfig | undefined {
  const config = loadConfig();
  if (!config.active || !config.instances?.[config.active]) return undefined;
  return config.instances[config.active];
}

export function getEndpoint(): string {
  if (process.env.IX_ENDPOINT) return process.env.IX_ENDPOINT;
  const instance = getActiveInstance();
  if (instance) return instance.endpoint;
  return loadConfig().endpoint;
}

export function getAuthToken(): string | undefined {
  const instance = getActiveInstance();
  if (!instance?.auth) return undefined;
  const expiresAt = new Date(instance.auth.expires_at);
  if (expiresAt <= new Date()) return undefined;
  return instance.auth.token;
}

export function storeAuth(instanceName: string, auth: InstanceAuth): void {
  const config = loadConfig() as any;
  if (!config.instances?.[instanceName]) return;
  config.instances[instanceName].auth = auth;
  saveConfig(config);
}

export function clearAuth(instanceName: string): void {
  const config = loadConfig() as any;
  if (!config.instances?.[instanceName]) return;
  delete config.instances[instanceName].auth;
  saveConfig(config);
}

export async function refreshAuthIfNeeded(): Promise<string | undefined> {
  const config = loadConfig() as any;
  const instanceName = config.active;
  if (!instanceName || !config.instances?.[instanceName]) return undefined;

  const instance = config.instances[instanceName] as InstanceConfig;
  if (!instance.auth) return undefined;

  const expiresAt = new Date(instance.auth.expires_at);
  const now = new Date();
  const bufferMs = 2 * 60 * 1000;
  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    return instance.auth.token;
  }

  try {
    const resp = await fetch(`${instance.endpoint}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: instance.auth.api_key }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return undefined;
    const data = await resp.json() as { token: string; expires_at: string; org_id: string; plan: string };
    instance.auth.token = data.token;
    instance.auth.expires_at = data.expires_at;
    saveConfig(config);
    return data.token;
  } catch {
    return undefined;
  }
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

export function getActiveWorkspaceRoot(): string | undefined {
  const cwd = process.cwd();
  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return nearest.root_path;

  const cfg = loadConfig();
  if (cfg.workspace) {
    const named = loadWorkspaces().find(w => w.workspace_name === cfg.workspace);
    if (named) return named.root_path;
  }

  return getDefaultWorkspace()?.root_path;
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
