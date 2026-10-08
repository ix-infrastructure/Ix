// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync, writeFileSync, existsSync, rmSync, chmodSync, renameSync, realpathSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { IxClient } from "../client/api.js";
import { ixHome } from "./ix-home.js";
import { isLocalEndpoint } from "./backend-version.js";
import { acquireLockAt, namedLockPath } from "./single-flight.js";

/**
 * The key of a project root's per-root state files. Canonical first: `ix
 * ingest <path>` resolves its root with `canonicalWorkspacePath`, and a caller
 * that spelled the same root differently -- a symlink, macOS's /tmp, a Windows
 * 8.3 name like RUNNER~1 -- found no baseline under its own spelling and
 * re-ingested everything, every time.
 */
function rootKey(projectRoot: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(projectRoot)).digest("hex").slice(0, 12);
}

/**
 * Path to the per-project ingest mtime cache (the "skip unchanged files on re-map"
 * pre-filter). Keyed on a hash of the project root. Single source of truth shared by
 * ingest (load/save), reset, and watch (clear) — all three MUST agree on this path.
 */
export function ingestMtimeCachePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_mtimes_${key}.json`);
}

/**
 * Path to the progress of an unfinished re-ingest for a new extractor (see
 * `loadRebuildProgress`). Cleared with the mtime cache, since it describes the
 * same graph.
 */
export function ingestRebuildPath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_rebuild_${key}.json`);
}

/** Path to the architecture-map completion marker for one project root. */
export function mapBaselinePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_baseline_${key}.json`);
}

/**
 * Path to the last `/v1/map` response for one project root, which a map that
 * ingested nothing reuses instead of asking again (see `map-result-cache.ts`).
 * Cleared with the map baseline, since both describe the same hierarchy.
 */
export function mapResultCachePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_result_${key}.json`);
}

/**
 * Path to the cached answer to "is this workspace stitched into a System?".
 *
 * Kept beside the ingest mtime cache and keyed the same way. See
 * `readStitchScope` for why this is on disk rather than in memory.
 */
export function stitchScopeCachePath(workspaceId: string): string {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return join(ixHome(), `stitch_scope_${key}.json`);
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
    mkdirSync(ixHome(), { recursive: true });
    writeFileSync(path, JSON.stringify({ workspaceId, systemId }) + "\n", "utf8");
  } catch { /* non-critical */ }
}

/** Drop the cached stitch answer. Called wherever the mtime cache is cleared. */
export function clearStitchScopeCache(workspaceId: string): void {
  try { rmSync(stitchScopeCachePath(workspaceId), { force: true }); } catch { /* non-critical */ }
}

/** Drop the cached `/v1/map` response, so the next map asks the backend. Best-effort. */
export function clearMapResultCache(projectRoot: string): void {
  try { rmSync(mapResultCachePath(projectRoot), { force: true }); } catch { /* non-critical */ }
}

/**
 * Remove the architecture-map completion marker, and the cached map response
 * with it: whatever made the marker wrong makes the cached hierarchy wrong too.
 * Leaves the source ingest baseline alone. Best-effort.
 */
export function clearMapBaseline(projectRoot: string): void {
  try { rmSync(mapBaselinePath(projectRoot), { force: true }); } catch { /* non-critical */ }
  clearMapResultCache(projectRoot);
}

/**
 * Remove all local graph baselines so the next map re-ingests every file.
 *
 * Reset and workspace migration invalidate both the source graph and the
 * hierarchy. A failed hierarchy build clears only `clearMapBaseline` instead.
 */
export function clearIngestMtimeCache(projectRoot: string): void {
  try { rmSync(ingestMtimeCachePath(projectRoot), { force: true }); } catch { /* non-critical */ }
  try { rmSync(ingestRebuildPath(projectRoot), { force: true }); } catch { /* non-critical */ }
  clearMapBaseline(projectRoot);
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
  /** Credentials for the local backend. See `getLocalToken`. */
  auth?: { local_token?: string };
}

/** The backend a config with no `endpoint` (or no config at all) points at. */
export const DEFAULT_ENDPOINT = "http://localhost:8090";

const defaultConfig: IxConfig = {
  endpoint: DEFAULT_ENDPOINT,
  format: "text",
};

/**
 * config.yaml exists and does not parse. Thrown rather than answered with the
 * defaults: falling back silently ran every command against the default
 * endpoint with no workspaces, and the first registration then saved over the
 * file. The error boundary prints the path and the parser's message.
 */
export class ConfigParseError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`${path} is not valid YAML: ${detail}`);
    this.name = "ConfigParseError";
  }
}

/**
 * The last parse of config.yaml, keyed by the file's mtime and size. A command
 * loads the config a dozen times or more, and with many workspaces each YAML
 * parse costs milliseconds; the key catches a write by another process, and
 * `saveConfig` drops it for this one.
 */
let configMemo: { path: string; mtimeMs: number; size: number; config: IxConfig } | undefined;

export function loadConfig(): IxConfig {
  const configPath = join(ixHome(), "config.yaml");
  // A copy, here and below: callers edit what they get back and save it.
  // Handing out the shared default let `getOrCreateWorkspace` write its new
  // workspace into it, so every later load in the process that found no
  // config file -- a fresh IX_HOME, a deleted file -- inherited workspaces
  // that were never in either.
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(configPath);
  } catch {
    return { ...defaultConfig };
  }
  if (configMemo && configMemo.path === configPath && configMemo.mtimeMs === stat.mtimeMs && configMemo.size === stat.size) {
    return structuredClone(configMemo.config);
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return { ...defaultConfig };
  }
  let parsed: Partial<IxConfig> | null;
  try {
    parsed = parse(raw) as Partial<IxConfig> | null;
  } catch (err) {
    throw new ConfigParseError(configPath, (err instanceof Error ? err.message : String(err)).split("\n")[0]!);
  }
  if (parsed === null || parsed === undefined) parsed = {}; // an empty file
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigParseError(configPath, "the top level is not a mapping of settings");
  }
  // Normalize workspace_id to a string. saveConfig quotes an all-digit path-hash
  // id, but a hand-edited or legacy unquoted value parses from YAML as a number,
  // which then silently breaks string id comparisons (e.g. migration detection
  // would re-key a workspace that is already on the correct id).
  if (Array.isArray(parsed.workspaces)) {
    parsed.workspaces = parsed.workspaces.map((w) => ({ ...w, workspace_id: String(w.workspace_id) }));
  }
  const config = { ...defaultConfig, ...parsed };
  configMemo = { path: configPath, mtimeMs: stat.mtimeMs, size: stat.size, config: structuredClone(config) };
  return config;
}

/**
 * The `format` setting alone, for command registration, which runs before
 * anything else on every invocation -- `ix --version` included. A full parse
 * of a config with a thousand workspaces is ~60 ms, all of it for one scalar
 * that sits on its own top-level line, so this reads that line. A memoised
 * parse is used when there is one. Undefined when the file or the key is
 * missing or unreadable: registration never fails on the config.
 */
export function readConfiguredFormat(): string | undefined {
  const configPath = join(ixHome(), "config.yaml");
  if (configMemo?.path === configPath) {
    try {
      const st = statSync(configPath);
      if (st.mtimeMs === configMemo.mtimeMs && st.size === configMemo.size) return configMemo.config.format;
    } catch { return undefined; }
  }
  let raw: string;
  try { raw = readFileSync(configPath, "utf-8"); } catch { return undefined; }
  const m = /^format:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))[ \t]*(?:#.*)?$/m.exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Test hook: forget the memoised parse. */
export function resetConfigMemo(): void {
  configMemo = undefined;
}

/** How long a config write waits for another process's before going ahead anyway. */
const CONFIG_LOCK_WAIT_MS = 5_000;

/**
 * Read config.yaml, apply `mutate`, and write it back, with no other Ix
 * process writing it in between.
 *
 * `saveConfig` alone is atomic per write but last-writer-wins: eight `ix map`
 * runs registering eight new repositories each read the file, each appended
 * its own workspace, and each renamed its copy over the others' -- leaving one
 * or two of the eight. Under the lock each one reads what the previous one
 * wrote. The lock is the single-flight link lock, so a crashed holder is
 * detected by its dead pid; past {@link CONFIG_LOCK_WAIT_MS} the write goes
 * ahead unlocked rather than hang a command.
 *
 * `mutate` gets a fresh read, never the memoised one, and returns the config
 * to save, or undefined to leave the file as it is.
 */
export function updateConfig<T>(mutate: (config: IxConfig) => { save?: IxConfig; result: T }): T {
  const configPath = join(ixHome(), "config.yaml");
  const lock = waitForLock(namedLockPath("config", configPath), `config write ${configPath}`);
  try {
    configMemo = undefined;
    const { save, result } = mutate(loadConfig());
    if (save) saveConfig(save);
    return result;
  } finally {
    lock?.release();
  }
}

function waitForLock(path: string, label: string): { release(): void } | null {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const handle = acquireLockAt(path, label);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    // A synchronous wait: registration runs inside synchronous callers.
    Atomics.wait(pause, 0, 0, 5 + Math.floor(Math.random() * 20));
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
  "auth",
]);

export function saveConfig(config: IxConfig): void {
  const configDir = ixHome();
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
    } catch (err) {
      // Refuse rather than start from `{}`: that rewrote the file with only
      // this call's fields, silently dropping every other workspace, a custom
      // endpoint and extension state such as Pro's credentials -- all over
      // one typo in a hand edit.
      throw new Error(
        `${configPath} is not valid YAML, so Ix will not overwrite it. ` +
        `Fix or remove the file and run the command again. (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
        { cause: err },
      );
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
  configMemo = undefined;
}

export function getEndpoint(): string {
  return process.env.IX_ENDPOINT || loadConfig().endpoint;
}

/**
 * The bearer token the client sends to `endpoint`, if any.
 *
 * IX_TOKEN is the user's explicit choice and goes to whatever endpoint is
 * configured. The stored `auth.local_token` belongs to the backend `ix docker`
 * runs on this machine, so it is sent only to a loopback endpoint: pointing
 * IX_ENDPOINT at another host must not hand that host the local credential.
 */
export function getLocalToken(endpoint: string = getEndpoint()): string | undefined {
  const explicit = process.env.IX_TOKEN?.trim();
  if (explicit) return explicit;
  if (!isLocalEndpoint(endpoint)) return undefined;
  return storedLocalToken();
}

/** The token in config.yaml's `auth.local_token`, if one is stored. */
export function storedLocalToken(): string | undefined {
  const stored = loadConfig().auth?.local_token;
  return typeof stored === "string" && stored.trim() ? stored.trim() : undefined;
}

/**
 * The stored local token, generated (32 random bytes, hex) and saved first if
 * there is none. Only `ix docker start --local-token` calls this: the token is
 * opt-in until a release turns it on by default.
 */
export function ensureLocalToken(): string {
  const existing = storedLocalToken();
  if (existing) return existing;
  return updateConfig((config) => {
    const stored = config.auth?.local_token;
    if (typeof stored === "string" && stored.trim()) return { result: stored.trim() };
    const token = randomBytes(32).toString("hex");
    return { save: { ...config, auth: { ...config.auth, local_token: token } }, result: token };
  });
}

/** Forget the stored local token. */
export function clearLocalToken(): void {
  updateConfig((config) => {
    if (!config.auth?.local_token) return { result: undefined };
    const { local_token: _dropped, ...rest } = config.auth;
    const next: IxConfig = { ...config };
    if (Object.keys(rest).length > 0) next.auth = rest;
    else delete next.auth;
    return { save: next, result: undefined };
  });
}

// Kept for @ix/pro, which imports it. The factory itself is the synchronous
// `createClient` in client/factory.ts; this wrapper loads it lazily because
// that module imports `getEndpoint` from this one.
export async function createClient(): Promise<IxClient> {
  const factory = await import("../client/factory.js");
  return factory.createClient();
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

export function canonicalWorkspacePath(input: string): string {
  const resolved = resolvePath(input);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}

/**
 * Is a path contained by one specific root after resolving symlinks on both
 * sides? This is stricter than `isReadablePath`, which deliberately allows all
 * registered workspace roots for cross-workspace reads.
 */
export function isPathInsideResolvedRoot(root: string, candidate: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolvePath(p); } };
  return isPathInside(root, candidate) && isPathInside(real(root), real(candidate));
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
  return readableRoots(explicitRoot).some(
    root => isPathInsideResolvedRoot(root, candidate),
  );
}

/**
 * Is `dir` the root of a linked git worktree (`git worktree add`)? Its `.git`
 * is a file pointing at the main repository's `.git/worktrees/<name>`, a git
 * directory that holds a `commondir` file -- git's own mark of a linked
 * worktree. A submodule's `.git` file points at a full git directory with no
 * `commondir`, even when it lives under `.git/worktrees/<wt>/modules/` (a
 * submodule checked out in a worktree), and is not one: a submodule is part
 * of the repository that contains it.
 */
export function isLinkedWorktreeRoot(dir: string): boolean {
  try {
    // Read, not stat-then-read: a .git directory throws EISDIR here, which is
    // the "not a linked worktree" answer anyway.
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, ".git"), "utf-8"))?.[1];
    // Relative when written with worktree.useRelativePaths (git 2.48+).
    return !!gitdir && existsSync(join(resolvePath(dir, gitdir), "commondir"));
  } catch {
    return false;
  }
}

export function selectWorkspaceForCwd(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceConfig | undefined {
  const canonicalCwd = canonicalWorkspacePath(cwd);
  const match = workspaces
    .map(workspace => ({ workspace, root: canonicalWorkspacePath(workspace.root_path) }))
    .filter(({ root }) => isPathInside(root, canonicalCwd))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!match) return undefined;
  // A linked worktree nested inside a registered repository (Claude Code puts
  // them at <repo>/.claude/worktrees/<name>) is a separate checkout, usually
  // on another branch. Answering for it from the enclosing repo's workspace
  // read and mapped the wrong tree; it is unmapped until it is registered,
  // exactly like a sibling worktree. Lexically below the match, so a few stats.
  for (let dir = canonicalCwd; dir !== match.root; dir = dirname(dir)) {
    if (isLinkedWorktreeRoot(dir)) return undefined;
    if (dirname(dir) === dir) break;
  }
  return match.workspace;
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

export function resolveWorkspaceRoot(explicitRoot?: string, cwd = process.cwd()): string {
  // 1. Explicit --root
  if (explicitRoot) return explicitRoot;
  // 2. Nearest initialized workspace containing cwd
  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return nearest.root_path;
  // 3. Named workspace from `ix config set workspace <name>`
  const cfg = loadConfig();
  if (cfg.workspace) {
    const named = loadWorkspaces().find(w => w.workspace_name === cfg.workspace);
    if (named) return named.root_path;
  }
  // 4. Git root: the repository the caller is standing in. Ahead of the
  //    default workspace for the reason `resolveMapRoot` gives: `default: true`
  //    marks whichever repo was mapped first, so ranking it above a local
  //    repository made `ix text` in an unmapped checkout search an unrelated
  //    one. (Graph reads from such a directory refuse outright; see
  //    `requireReadWorkspaceId`.)
  const gitRoot = gitRootFor(cwd);
  if (gitRoot) return gitRoot;
  // 5. Configured default workspace, for a cwd with no local context at all
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) return defaultWs.root_path;
  // 6. cwd fallback
  return cwd;
}

/**
 * The git top-level containing `cwd`, or undefined outside a repository.
 *
 * stderr is discarded: outside a repo git writes "fatal: not a git repository"
 * to it, and this is a probe, not a failure the user needs to see.
 */
export function gitRootFor(cwd: string): string | undefined {
  try {
    // -c: never run a core.fsmonitor command the repository's config names.
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch { return undefined; }
}
