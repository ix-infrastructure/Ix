// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { createClient } from "../client/factory.js";
import { renderBanner } from "./banner.js";
import { canonicalWorkspacePath, getEndpoint, gitRootFor, loadConfig, loadWorkspaces, findWorkspaceForCwd, updateConfig, withConfigWriteLock, type IxConfig, type PendingPrune, type WorkspaceConfig } from "./config.js";
import { WorkspaceNotMappedError, workspaceNotMappedHint } from "./errors.js";
import { ixHome } from "./ix-home.js";
import { stderr } from "./stderr.js";
import { workspaceIdForPath } from "./system.js";
import { IX_CALLER_ENV } from "./next-step.js";
import { isLocalEndpoint } from "./backend-version.js";

export interface BootstrapResult {
  createdConfig: boolean;
  registeredWorkspace: boolean;
  workspaceName: string;
}

/**
 * Ensure `$IX_HOME/config.yaml` (default `~/.ix/config.yaml`) exists. Creates
 * it silently if missing. Returns true if it was just created.
 */
export function ensureLocalConfig(): boolean {
  const configDir = ixHome();
  const configPath = join(configDir, "config.yaml");
  mkdirSync(configDir, { recursive: true });
  // Under the config lock like every other write, so a registration that has
  // just read "no file" is not overtaken by this one.
  const created = withConfigWriteLock(() => {
    try {
      // 'wx' creates the file atomically and throws EEXIST if it already exists,
      // avoiding the existsSync-then-write TOCTOU (CodeQL js/file-system-race).
      writeFileSync(configPath, `endpoint: ${getEndpoint()}\nformat: text\n`, { flag: "wx" });
      return true;
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      throw err;
    }
  });
  if (created) noteRelocatedConfig(configPath);
  return created;
}

/**
 * A config was just created under `$IX_HOME` while a `~/.ix/config.yaml`
 * exists. That is the one user-visible consequence of config following
 * IX_HOME: someone who exported it as a custom install root before config
 * honoured it now finds the CLI on the default endpoint with no workspaces,
 * and nothing else says why. Say why, on stderr, at the moment it happens --
 * which is exactly once, because the file is created exactly once.
 *
 * Nothing is migrated automatically: two live copies of a credential-bearing
 * file is worse than one clear message about which one is in use.
 */
function noteRelocatedConfig(configPath: string): void {
  if (!process.env.IX_HOME) return;
  const legacy = join(homedir(), ".ix", "config.yaml");
  if (legacy === configPath || !existsSync(legacy)) return;
  stderr(chalk.yellow(
    `IX_HOME is set: using ${configPath}. Your existing ${legacy} was not migrated -- ` +
    `copy it there, or unset IX_HOME to keep using it.`,
  ));
}

// Roots whose workspace_id was re-keyed to the path-based id during THIS process,
// mapped to the OLD (pre-migration) id. getOrCreateWorkspace is called more than once
// per `ix map` (bootstrap() registers, then ingest resolves the id); the first call
// does the actual re-key, so without this the second call would report migrated=false
// (and ingest would skip the forced re-ingest). Keyed by resolved root path. A re-key
// only happens on `--prune-stale-workspace` (adoptPathId).
const migratedRootsThisRun = new Map<string, string>();

// Roots already warned about in this process for a registered workspace_id that
// differs from the path-derived one, so a run that resolves the id several times
// prints the warning once.
const warnedPinnedRoots = new Set<string>();

/**
 * `setDefault: false` keeps a new registration from becoming the default workspace (ingest).
 *
 * `adoptPathId: true` (`--prune-stale-workspace`) re-keys a registered workspace whose
 * workspace_id differs from its path-derived id. Without it the registered id is kept:
 * it may be pinned on purpose (a team sharing one graph from clones at different
 * absolute paths, or a tool that keys on it), and re-keying it silently made the next
 * clean ingest delete that id's whole workspace for everyone on the backend.
 *
 * `quiet: true` suppresses the warning about such an id (`--silent`, machine formats:
 * a hook would print it on every run). `pinned: true` on the workspace does so always.
 */
export interface RegisterOptions { setDefault?: boolean; adoptPathId?: boolean; quiet?: boolean }

interface WorkspaceState { ws: WorkspaceConfig; created: boolean; migrated: boolean; previousWorkspaceId?: string }

/** The recorded, not-yet-deleted old ids of a workspace (see WorkspaceConfig.pending_prune_of). */
export function pendingPrunesOf(ws: Pick<WorkspaceConfig, "pending_prune_of"> | undefined): PendingPrune[] {
  return Array.isArray(ws?.pending_prune_of) ? ws.pending_prune_of : [];
}

/** The one-line warning for a registered id that is not the path-derived one. */
export function pinnedWorkspaceIdWarning(rootPath: string, pinnedId: string, pathId: string): string {
  return `Workspace ${rootPath} is registered with workspace_id ${pinnedId}, not the path-derived ${pathId}. ` +
    `Keeping ${pinnedId}. If it is pinned on purpose, add "pinned: true" to it in config.yaml to silence this. ` +
    `If not, and the backend is your own local one, ix map --prune-stale-workspace switches to ${pathId} ` +
    `and deletes ${pinnedId}'s graph.`;
}

function warnPinnedOnce(ws: WorkspaceConfig, rootPath: string, pathId: string, quiet: boolean): void {
  if (quiet || ws.pinned === true || warnedPinnedRoots.has(rootPath)) return;
  warnedPinnedRoots.add(rootPath);
  stderr(chalk.yellow(pinnedWorkspaceIdWarning(rootPath, ws.workspace_id, pathId)));
}

/** @internal Test hook: forget the per-process re-key and warning memos. */
export function resetWorkspaceIdMemosForTests(): void {
  migratedRootsThisRun.clear();
  warnedPinnedRoots.clear();
}

/**
 * Ensure the current directory (or given path) is registered as a workspace.
 * Returns the workspace name. Does nothing if already registered.
 */
function getOrCreateWorkspace(cwd: string, opts: RegisterOptions = {}): WorkspaceState {
  const rootPath = canonicalWorkspacePath(resolve(cwd));
  const pathId = workspaceIdForPath(rootPath);
  // The common case, already registered under its own root, needs no write and
  // so no lock -- whatever its id, unless the caller asked to re-key it.
  const known = (loadConfig().workspaces ?? []).find(w => w.root_path === rootPath);
  if (known && (known.workspace_id === pathId || !opts.adoptPathId)) {
    if (known.workspace_id !== pathId) warnPinnedOnce(known, rootPath, pathId, opts.quiet === true);
    const previousWorkspaceId = migratedRootsThisRun.get(rootPath);
    return { ws: known, created: false, migrated: previousWorkspaceId !== undefined, previousWorkspaceId };
  }
  // Read, change and write under the config lock, so parallel registrations
  // each see the one before (see updateConfig).
  return updateConfig((config) => {
    let save: typeof config | undefined;
    const state = registerIn(config, rootPath, () => { save = config; }, opts.setDefault ?? true, opts.adoptPathId === true, opts.quiet === true);
    return { save, result: state };
  });
}

/** The registration itself, on a config read under the lock; `changed` marks it for saving. */
function registerIn(config: IxConfig, rootPath: string, changed: () => void, setDefault: boolean, adoptPathId: boolean, quiet: boolean): WorkspaceState {
  const pathId = workspaceIdForPath(rootPath);
  const existing = (config.workspaces ?? []).find(w => canonicalWorkspacePath(w.root_path) === rootPath);
  if (existing) {
    const pathChanged = existing.root_path !== rootPath;
    existing.root_path = rootPath;
    if (existing.workspace_id !== pathId) {
      if (!adoptPathId) {
        // A registered id that is not the path-derived one is honoured: it is
        // either pinned on purpose or a legacy random id, and the CLI cannot
        // tell which. Re-keying is `--prune-stale-workspace`, never automatic.
        warnPinnedOnce(existing, rootPath, pathId, quiet);
        if (pathChanged) changed();
        const previousWorkspaceId = migratedRootsThisRun.get(rootPath);
        return { ws: existing, created: false, migrated: previousWorkspaceId !== undefined, previousWorkspaceId };
      }
      // Opted in: migrate to the path-based id (Ix#225 gap 2) so the repo
      // converges with co-ingest. This changes the workspace_id that node
      // identity folds, so the next map must re-ingest under the new id (the
      // caller forces that). The old id is recorded in the SAME write as the
      // re-key, with the endpoint it belonged to: if the re-ingest is not clean
      // or the delete fails, the next `--prune-stale-workspace` retries it,
      // rather than leaving a graph nothing in this config points at any more.
      // Deleting it is gated separately (staleWorkspaceCleanup).
      const previousWorkspaceId = existing.workspace_id;
      const endpoint = getEndpoint();
      const pending = pendingPrunesOf(existing);
      if (!pending.some(p => p.workspace_id === previousWorkspaceId && p.endpoint === endpoint)) {
        existing.pending_prune_of = [...pending, { workspace_id: previousWorkspaceId, endpoint }];
      }
      existing.workspace_id = pathId;
      delete existing.pinned;
      changed();
      migratedRootsThisRun.set(rootPath, previousWorkspaceId);
      return { ws: existing, created: false, migrated: true, previousWorkspaceId };
    }
    if (pathChanged) changed();
    const previousWorkspaceId = migratedRootsThisRun.get(rootPath);
    return { ws: existing, created: false, migrated: previousWorkspaceId !== undefined, previousWorkspaceId };
  }

  const workspaces = config.workspaces ?? [];
  const hasDefault = workspaces.some(w => w.default);
  const ws: WorkspaceConfig = {
    // Path-based id (NOT random): a repo mapped standalone must get the same
    // workspace_id it gets as a member of a system, so its node identity is
    // byte-identical across both. Shared with repoWorkspaceIdFor via system.ts.
    workspace_id: pathId,
    workspace_name: basename(rootPath),
    root_path: rootPath,
    default: setDefault && !hasDefault,
  };
  config.workspaces = [...workspaces, ws];
  changed();
  return { ws, created: true, migrated: false };
}

/**
 * Drop one recorded old id from `root`'s pending prunes, once it is deleted.
 */
export function clearPendingPrune(root: string, prune: PendingPrune): void {
  const rootPath = canonicalWorkspacePath(resolve(root));
  updateConfig((config) => {
    const ws = (config.workspaces ?? []).find(w => canonicalWorkspacePath(w.root_path) === rootPath);
    if (!ws) return { save: undefined, result: undefined };
    const rest = pendingPrunesOf(ws).filter(p => !(p.workspace_id === prune.workspace_id && p.endpoint === prune.endpoint));
    if (rest.length > 0) ws.pending_prune_of = rest;
    else delete ws.pending_prune_of;
    return { save: config, result: undefined };
  });
}

/**
 * The rule for deleting an old workspace id, which only `--prune-stale-workspace` asks for.
 *
 * A workspace_id is a key on a backend that other people may share, and nothing on the
 * backend records who owns one. So the CLI deletes one only when all of these hold:
 *
 * - the user opted in for this run (`--prune-stale-workspace`); nothing deletes on its own;
 * - the id was recorded by a re-key of THIS root in THIS config (`pending_prune_of`),
 *   and is not the id the root uses now;
 * - it was recorded against the endpoint configured now;
 * - no other workspace in this config still uses it;
 * - the ingest under the new id completed cleanly;
 * - the endpoint is loopback (`isLocalEndpoint`). On any other endpoint the CLI cannot
 *   establish that the id is the caller's own -- a teammate may have it pinned -- so it
 *   never deletes there, flag or no flag.
 *
 * "Loopback" is about the configured URL, not about whose backend answers it: an
 * `ssh -L` tunnel, `kubectl port-forward` or local proxy to a shared backend passes.
 * Do not use the flag through one.
 */
export type StaleWorkspaceKeepReason =
  | "not_opted_in" | "current_id" | "non_local_endpoint" | "endpoint_changed" | "shared_in_config" | "ingest_unclean";
export type StaleWorkspaceCleanup =
  | { action: "delete"; workspaceId: string }
  | { action: "keep"; reason: StaleWorkspaceKeepReason; workspaceId: string };

export function staleWorkspaceCleanup(input: {
  prune: PendingPrune;
  currentWorkspaceId: string;
  pruneOptIn: boolean;
  endpoint: string;
  ingestClean: boolean;
  /** Workspace ids the caller's config registers for roots OTHER than this one. */
  otherRegisteredIds: readonly string[];
}): StaleWorkspaceCleanup {
  const old = input.prune.workspace_id;
  const keep = (reason: StaleWorkspaceKeepReason): StaleWorkspaceCleanup => ({ action: "keep", reason, workspaceId: old });
  if (!input.pruneOptIn) return keep("not_opted_in");
  if (old === input.currentWorkspaceId) return keep("current_id");
  if (!isLocalEndpoint(input.endpoint)) return keep("non_local_endpoint");
  if (input.prune.endpoint !== input.endpoint) return keep("endpoint_changed");
  if (input.otherRegisteredIds.includes(old)) return keep("shared_in_config");
  if (!input.ingestClean) return keep("ingest_unclean");
  return { action: "delete", workspaceId: old };
}

/**
 * Refuse `--prune-stale-workspace` up front against a non-loopback endpoint, before
 * anything is re-keyed: the deletion it exists for is never allowed there (see
 * {@link staleWorkspaceCleanup}).
 */
export function assertStaleWorkspacePruneAllowed(endpoint: string): void {
  if (isLocalEndpoint(endpoint)) return;
  throw new Error(
    "--prune-stale-workspace deletes a workspace's graph and only runs against a local (loopback) backend; " +
    "the configured endpoint is not one. Nothing was changed.",
  );
}

export function ensureWorkspaceRegistered(cwd = process.cwd(), opts: RegisterOptions = {}): { registered: boolean; name: string } {
  const { ws, created } = getOrCreateWorkspace(cwd, opts);
  return { registered: created, name: ws.workspace_name };
}

/**
 * Like ensureWorkspaceId, but also reports whether the workspace_id was just migrated
 * to the path-based id (and, if so, the previous id), and the old ids still awaiting
 * an opted-in deletion. A re-key only happens with `adoptPathId`
 * (`--prune-stale-workspace`). The map/ingest flow uses `migrated` to force a full
 * re-ingest under the new id and `pendingPrune` for the local-only cleanup afterward.
 */
export function ensureWorkspaceIdState(cwd = process.cwd(), opts: RegisterOptions = {}): {
  workspaceId: string; migrated: boolean; previousWorkspaceId?: string; created: boolean; name: string; pendingPrune: PendingPrune[];
} {
  const { ws, migrated, previousWorkspaceId, created } = getOrCreateWorkspace(cwd, opts);
  return { workspaceId: ws.workspace_id, migrated, previousWorkspaceId, created, name: ws.workspace_name, pendingPrune: pendingPrunesOf(ws) };
}

/**
 * The workspace state for `root` WITHOUT registering a new one: an existing
 * workspace exactly as ensureWorkspaceIdState returns it, or, for a root not
 * registered yet, the id it would get with `pending: true` and nothing written.
 *
 * For `ix ingest <path>`, which must not register a workspace until something
 * was actually ingested into it. Every registered workspace is a root `ix read`
 * may open files from, so registering first let a failed ingest of any path --
 * the backend down, or a path nobody meant to ingest -- widen what reads can
 * open, permanently. The caller registers with `ensureWorkspaceIdState(root,
 * { setDefault })` once a commit has landed -- `setDefault: false` for a loose
 * directory, so it never becomes the default -- and never for a loose file.
 */
export function workspaceStateFor(root: string, opts: Pick<RegisterOptions, "adoptPathId" | "quiet"> = {}): {
  workspaceId: string; migrated: boolean; previousWorkspaceId?: string; created: boolean; name: string; pending: boolean; pendingPrune: PendingPrune[];
} {
  const rootPath = canonicalWorkspacePath(resolve(root));
  const registered = (loadConfig().workspaces ?? []).some(w => canonicalWorkspacePath(w.root_path) === rootPath);
  if (registered) return { ...ensureWorkspaceIdState(rootPath, { adoptPathId: opts.adoptPathId, quiet: opts.quiet }), pending: false };
  return { workspaceId: workspaceIdForPath(rootPath), migrated: false, created: true, name: basename(rootPath), pending: true, pendingPrune: [] };
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
 * Resolve the workspace id for a READ, without creating one: the nearest
 * registered workspace containing cwd, else a workspace pinned by name with
 * `ix config set workspace <name>`, else undefined.
 *
 * Deliberately NOT the `default: true` workspace. That flag is set on whichever
 * repo happened to be mapped first, not chosen, and falling back to it answered
 * reads from an unrelated repository with nothing on screen saying so (the
 * ix-bench runner found agents in an unregistered worktree getting another
 * repo's `ix context`). Undefined is not "read everything" either: graph reads
 * refuse it through {@link requireReadWorkspaceId}.
 */
export function resolveWorkspaceId(cwd = process.cwd()): string | undefined {
  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return nearest.workspace_id;
  const pinned = loadConfig().workspace;
  if (pinned) return loadWorkspaces().find(w => w.workspace_name === pinned)?.workspace_id;
  return undefined;
}

/**
 * The workspace a graph read is scoped to, or a {@link WorkspaceNotMappedError}
 * naming the directory and how to map it. For every command whose answer comes
 * from the graph; commands that do not need one (`text`, `status`, `doctor`,
 * `view --all`, `map` itself) never call this.
 */
export function requireReadWorkspaceId(cwd = process.cwd()): string {
  const id = resolveWorkspaceId(cwd);
  if (id) return id;
  // git prints its top-level with forward slashes on Windows; the hint is
  // for a person to read and paste, so it gets the platform's own form.
  const gitRoot = gitRootFor(cwd);
  throw new WorkspaceNotMappedError(cwd, workspaceNotMappedHint(cwd, gitRoot && resolve(gitRoot)));
}

/**
 * Whether an unreachable `endpoint` is the backend `ix docker start` brings up.
 *
 * That command always starts the standalone compose on localhost:8090. For any
 * other endpoint -- a remote, a second local backend on another port -- it
 * starts containers the command then never talks to (and may collide with
 * someone else's on 8090), while the real endpoint stays down.
 */
export function canAutoStartBackend(endpoint: string): boolean {
  if (!isLocalEndpoint(endpoint)) return false;
  try {
    return new URL(endpoint).port === "8090";
  } catch {
    return false;
  }
}

/**
 * Ensure the backend is reachable. If not, auto-start via ix docker start.
 */
export async function ensureBackendAvailable(): Promise<void> {
  const endpoint = getEndpoint();
  const client = createClient({ endpoint });
  // Loaded here, not at the top: every graph command imports this file, and
  // `upgrade.js` (with the release-download code behind it) is needed only on
  // this path. Outside the try, so a module that fails to load is not taken
  // for a backend that is down.
  const { readBackendHealth } = await import("./commands/upgrade.js");
  try {
    // Through readBackendHealth so this probe records the release the backend
    // reports, like every other health fetch. `ix init` never reaches the
    // ingest path, so without this it would never record at all.
    await readBackendHealth(client);
  } catch {
    if (!canAutoStartBackend(endpoint)) {
      throw new Error(`Ix backend at ${endpoint} is not reachable.`);
    }
    // Never from inside `ix mcp`: a tool call would start Docker containers
    // on the user's machine without anyone asking, with the child's output
    // inherited onto the server's stdio. Say what to run instead.
    if (process.env[IX_CALLER_ENV] === "mcp") {
      throw new Error(`Ix backend at ${endpoint} is not reachable (backend_unreachable). Start it with: ix docker start`);
    }
    try {
      // This CLI's own entry point under this node, not `ix` off PATH: on
      // Windows `ix` is `ix.cmd`, which execFile cannot launch without a shell,
      // and PATH may name a different install.
      execFileSync(process.execPath, [process.argv[1], "docker", "start"], { stdio: "inherit", timeout: 120000 });
    } catch {
      throw new Error("Failed to start Ix backend. Run: ix docker start");
    }
  }
}

/**
 * Emit the one-time "Ix / Created config / Registered workspace" setup notice.
 *
 * These are side-effect messages, not program output, so they go to stderr —
 * keeping stdout clean for `--format json|llm` consumers (a banner on stdout
 * corrupts the first machine-readable response after a workspace is registered).
 */
export function emitSetupNotice(createdConfig: boolean, registered: boolean, name: string): void {
  if (!createdConfig && !registered) return;
  // The logo banner (rendered from assets/logo.png at print time) when the
  // terminal can show it; the plain text heading otherwise. Both stderr only —
  // stdout stays clean for --format json|llm consumers.
  const banner = renderBanner();
  if (banner) console.error(banner);
  else console.error(chalk.bold("Ix\n"));
  if (createdConfig) console.error(chalk.dim(`Created default config.`));
  if (registered)    console.error(chalk.dim(`Registered workspace "${name}".`));
  console.error();
}

/**
 * Full lazy bootstrap. Call at the top of map/watch actions.
 * Prints user-friendly output only on first run (when something was created).
 */
export async function bootstrap(cwd = process.cwd(), opts: Pick<RegisterOptions, "adoptPathId" | "quiet"> = {}): Promise<void> {
  const createdConfig = ensureLocalConfig();
  const { registered, name } = ensureWorkspaceRegistered(cwd, { adoptPathId: opts.adoptPathId, quiet: opts.quiet });

  emitSetupNotice(createdConfig, registered, name);

  await ensureBackendAvailable();
}
