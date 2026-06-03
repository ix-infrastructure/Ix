import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { IxClient } from "../client/api.js";

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

// Keys the OSS schema owns. For these, the in-memory `config` argument is
// the source of truth — including absence (a missing key means "delete from
// disk"). Anything outside this set is owned by extension packages (e.g.
// Pro's `active` / `instances`) or by user hand-edits, and is preserved
// untouched by OSS writes.
//
// Keep this in sync with the IxConfig interface above. New OSS fields must
// be added here, otherwise OSS code can't delete or unset them.
const OSS_OWNED_KEYS = new Set<keyof IxConfig>([
  "endpoint",
  "format",
  "workspace",
  "workspaces",
]);

export function saveConfig(config: IxConfig): void {
  const configPath = join(homedir(), ".ix", "config.yaml");
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = parse(readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  // Drop OSS-owned keys from the disk snapshot — the in-memory `config`
  // is authoritative for those. Keep everything else (extension fields,
  // user-added fields) so OSS writes never clobber them.
  const preserved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!OSS_OWNED_KEYS.has(k as keyof IxConfig)) preserved[k] = v;
  }
  const merged: Record<string, unknown> = { ...preserved, ...(config as unknown as Record<string, unknown>) };
  writeFileSync(configPath, stringify(merged));
}

export function getEndpoint(): string {
  return process.env.IX_ENDPOINT || loadConfig().endpoint;
}

// Single-place factory for IxClient instances. Pro commands and future OSS
// code paths should prefer this over `new IxClient(getEndpoint())` so auth
// and endpoint resolution can evolve in one spot.
export async function createClient(): Promise<IxClient> {
  return new IxClient(getEndpoint());
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
  return resolvePath(root, normalized);
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
