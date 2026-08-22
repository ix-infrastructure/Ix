import { readFileSync, writeFileSync, existsSync, rmSync, chmodSync, renameSync, realpathSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { IxClient } from "../client/api.js";

/**
 * Path to the per-project ingest mtime cache (the "skip unchanged files on re-map"
 * pre-filter). Keyed on a hash of the project root. Single source of truth shared by
 * ingest (load/save), reset, and watch (clear) — all three MUST agree on this path.
 */
export function ingestMtimeCachePath(projectRoot: string): string {
  const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return join(homedir(), ".ix", `ingest_mtimes_${key}.json`);
}

/**
 * Path to the cached answer to "is this workspace stitched into a System?".
 *
 * Kept beside the ingest mtime cache and keyed the same way. See
 * `readStitchScope` for why this is on disk rather than in memory.
 */
export function stitchScopeCachePath(workspaceId: string): string {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return join(homedir(), ".ix", `stitch_scope_${key}.json`);
}

/**
 * The stitched system for a workspace, as last answered by the backend.
 *
 * `ensureReadScope` memoized this per process, which is no cache at all for a
 * CLI: every `ix` invocation is a fresh process, so every aggregate read paid
 * the lookup again. On a large graph that lookup is ~1.5 s — for `ix smells`,
 * three times the cost of the work it precedes.
 *
 * Returns `undefined` when there is nothing usable on disk, which is also what
 * a malformed or unreadable file returns: this is a cache, so every failure
 * means "ask the backend", never "fail the command".
 *
 * There is deliberately no TTL. A workspace's system changes when it is mapped
 * or ingested, and both of those clear this file (`clearStitchScopeCache`), so
 * a timer would only add a window in which the answer is wrong for no reason.
 */
export function readStitchScope(workspaceId: string): { systemId: string | null } | undefined {
  try {
    const raw = JSON.parse(readFileSync(stitchScopeCachePath(workspaceId), "utf-8"));
    if (raw?.workspaceId !== workspaceId) return undefined; // hash collision or hand-edit
    if (raw.systemId !== null && typeof raw.systemId !== "string") return undefined;
    return { systemId: raw.systemId };
  } catch {
    return undefined;
  }
}

/** Record the backend's answer. Best-effort: a cache that cannot be written is not an error. */
export function writeStitchScope(workspaceId: string, systemId: string | null): void {
  try {
    const path = stitchScopeCachePath(workspaceId);
    mkdirSync(join(homedir(), ".ix"), { recursive: true });
    writeFileSync(path, JSON.stringify({ workspaceId, systemId }) + "\n", "utf8");
  } catch { /* non-critical */ }
}

/** Drop the cached stitch answer. Called wherever the mtime cache is cleared. */
export function clearStitchScopeCache(workspaceId: string): void {
  try { rmSync(stitchScopeCachePath(workspaceId), { force: true }); } catch { /* non-critical */ }
}

/** Remove the ingest mtime cache so the next map re-ingests every file. Best-effort. */
export function clearIngestMtimeCache(projectRoot: string): void {
  try { rmSync(ingestMtimeCachePath(projectRoot), { force: true }); } catch { /* non-critical */ }
}

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
    // Normalize workspace_id to a string. saveConfig quotes an all-digit path-hash
    // id, but a hand-edited or legacy unquoted value parses from YAML as a number,
    // which then silently breaks string id comparisons (e.g. migration detection
    // would re-key a workspace that is already on the correct id).
    if (Array.isArray(parsed.workspaces)) {
      parsed.workspaces = parsed.workspaces.map((w) => ({ ...w, workspace_id: String(w.workspace_id) }));
    }
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
  const configDir = join(homedir(), ".ix");
  const configPath = join(configDir, "config.yaml");
  // 0700, to match the 0600 the config itself is written with below: the file
  // holds credentials (Pro's instances carry a tunnel JWT and a long-lived IdP
  // refresh token), and a directory created at the default umask (typically
  // 0755) lets anyone on the host list the names beside it. `mode` applies only
  // to directories this call creates, so an existing ~/.ix keeps its own mode.
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
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
  // Atomic write: serialize to a private (0600) temp file in the SAME directory,
  // then rename it over the target. The config holds credentials (Pro's instances
  // carry a tunnel JWT and a long-lived IdP refresh token), so this avoids both a
  // partially-written/looser-mode window and the read-modify-write race (CodeQL
  // js/file-system-race). Same-dir keeps the rename atomic; rename replaces on
  // POSIX and Windows alike, and inherits the temp's 0600 mode (tightening any
  // pre-existing group/world-readable config).
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, stringify(merged), { mode: 0o600 });
  try {
    renameSync(tmpPath, configPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  try {
    chmodSync(configPath, 0o600); // belt-and-suspenders if umask altered the temp mode
  } catch {
    // chmod can fail on exotic filesystems; the temp's create-mode is the primary guard.
  }
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
  return config.workspaces ?? []; // workspace_id already normalized to string in loadConfig
}

/**
 * Is `candidate` `root` itself, or somewhere underneath it?
 *
 * The `relative()` form is the one this file already used to pick a workspace
 * for a cwd. It handles the two cases a `startsWith` prefix test gets wrong: a
 * `..` traversal comes back with leading `..` segments, and on Windows a path on
 * a different drive comes back absolute. Both sides are resolved first so a
 * relative input cannot slip past.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The roots a read command may open a file from: the workspace this invocation
 * resolves to, plus every workspace the user has registered with `ix init`.
 *
 * Registered workspaces are included because reads legitimately span them — a
 * stitched system, or `ix view --all` — and every one of them is a path the user
 * put in their own config. What is NOT in the list is the rest of the disk.
 */
export function readableRoots(explicitRoot?: string): string[] {
  const roots = [resolveWorkspaceRoot(explicitRoot), ...loadWorkspaces().map(w => w.root_path)];
  return [...new Set(roots.filter(Boolean).map(r => resolvePath(r)))];
}

/**
 * May `ix read` open this file?
 *
 * Symlinks are resolved on both sides before comparing, so a link planted inside
 * a workspace cannot be used to hand back a file outside it. Resolving both sides
 * is what keeps that from backfiring: workspace roots are themselves often
 * symlinks (macOS `/tmp`, a checkout reached through one), and comparing a real
 * path against a symlinked root would reject perfectly ordinary reads.
 * `realpathSync` is best-effort — if either side cannot be resolved, the lexical
 * path stands in, which is the same answer for everything that is not a link.
 */
export function isReadablePath(candidate: string, explicitRoot?: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolvePath(p); } };
  const realCandidate = real(candidate);
  return readableRoots(explicitRoot).some(
    root => isPathInside(root, candidate) && isPathInside(real(root), realCandidate),
  );
}

export function selectWorkspaceForCwd(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceConfig | undefined {
  return workspaces
    .filter(workspace => isPathInside(workspace.root_path, cwd))
    .sort((a, b) => b.root_path.length - a.root_path.length)[0];
}

export function findWorkspaceForCwd(cwd: string): WorkspaceConfig | undefined {
  return selectWorkspaceForCwd(loadWorkspaces(), cwd);
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
