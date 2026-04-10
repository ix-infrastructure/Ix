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

// NEEDS HEAVY REVIEW: "needs heavy review as didnt verify this change for additional bug for all of this, this could be completely wrong"
//
// Resolve a source_uri from the graph (which is now a workspace-relative
// POSIX path under the client-agnostic backend design) back to an absolute
// host filesystem path. If the input is already absolute (e.g. legacy graphs
// or external absolute paths), it is returned as-is. Used by any command that
// needs to actually open a file off disk (ix read, ix explain, ...).
export function absoluteFromSourceUri(sourceUri: string, explicitRoot?: string): string {
  if (!sourceUri) return sourceUri;
  // Treat both POSIX abs (`/`) and Windows abs (`C:\`) as already resolved.
  if (sourceUri.startsWith("/") || /^[A-Za-z]:[\\/]/.test(sourceUri)) return sourceUri;
  const root = resolveWorkspaceRoot(explicitRoot);
  // POSIX-normalize the relative segment before joining.
  const normalized = sourceUri.replace(/\\/g, "/");
  return require("node:path").resolve(root, normalized);
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
