// Copyright 2026 Ix Infrastructure Inc.

/**
 * config.yaml: its shape, reading it (memoised), and writing it under the
 * config lock. Split out of `config.ts` (#943); `config.ts` re-exports
 * everything here.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, chmodSync, mkdirSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type * as Yaml from "yaml";
import { ixHome } from "./ix-home.js";
import { DEFAULT_ENDPOINT } from "./endpoint.js";
import { renameWithRetry, withConfigLock } from "./config-lock.js";

// `yaml` is ~70 modules, loaded the first time config.yaml is actually parsed
// or written rather than on import: every command imports this file, and
// `ix --version`, or any call made where there is no config.yaml, never needs
// it. Synchronous, because `loadConfig` is.
const requireYaml = createRequire(import.meta.url);
let yamlModule: typeof Yaml | undefined;
function yaml(): typeof Yaml {
  return (yamlModule ??= requireYaml("yaml") as typeof Yaml);
}

export interface WorkspaceConfig {
  workspace_id: string;
  workspace_name: string;
  root_path: string;
  default: boolean;
  /**
   * The workspace_id is pinned on purpose (e.g. shared by a team from clones at
   * different paths): silences the warning about it differing from the
   * path-derived id, and makes `--prune-stale-workspace` refuse to re-key the
   * root. Set by hand; the CLI never writes or removes it.
   */
  pinned?: boolean;
  /**
   * Old workspace ids `--prune-stale-workspace` re-keyed this root away from and
   * has not deleted yet (the re-ingest was not clean, or the delete failed), each
   * with the endpoint it was re-keyed against. The next `--prune-stale-workspace`
   * run against that endpoint retries the deletion.
   */
  pending_prune_of?: PendingPrune[];
}

/** One old workspace id awaiting an opted-in deletion; see WorkspaceConfig.pending_prune_of. */
export interface PendingPrune { workspace_id: string; endpoint: string }

// Roots already warned about for malformed pending_prune_of markers, so a
// process that re-reads config.yaml says it once.
const warnedMalformedPrunes = new Set<string>();

/**
 * The markers of a hand-edited `pending_prune_of` that name a workspace id and an
 * endpoint as strings. Anything else is skipped, never coerced: `String()` on a
 * missing id is "undefined", and on an unquoted all-digit id YAML has already
 * dropped its leading zeros -- either would aim a deletion at the wrong id.
 * Skipped markers are not written back on the next config save.
 */
function wellFormedPendingPrunes(raw: unknown, root: unknown): PendingPrune[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const ok = list.filter((p): p is PendingPrune =>
    typeof p === "object" && p !== null &&
    typeof (p as PendingPrune).workspace_id === "string" && (p as PendingPrune).workspace_id !== "" &&
    typeof (p as PendingPrune).endpoint === "string" && (p as PendingPrune).endpoint !== "")
    .map((p) => ({ workspace_id: p.workspace_id, endpoint: p.endpoint }));
  const skipped = list.length - ok.length;
  const key = String(root);
  if (skipped > 0 && !warnedMalformedPrunes.has(key)) {
    warnedMalformedPrunes.add(key);
    process.stderr.write(
      `Ignoring ${skipped} malformed pending_prune_of entr${skipped === 1 ? "y" : "ies"} for workspace ${key} in config.yaml ` +
      `(each needs a quoted workspace_id and an endpoint); nothing is deleted for ${skipped === 1 ? "it" : "them"}.\n`,
    );
  }
  return ok;
}

/** @internal Test hook: forget which roots were warned about malformed markers. */
export function resetMalformedPruneWarningsForTests(): void {
  warnedMalformedPrunes.clear();
}

export interface IxConfig {
  endpoint: string;
  format: string;
  workspace?: string;
  workspaces?: WorkspaceConfig[];
  /** Credentials for the local backend. See `getLocalToken`. */
  auth?: { local_token?: string };
}

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
  // One descriptor for the stat and the read, so the memo's key always
  // describes the bytes it was parsed from.
  let fd: number;
  try {
    fd = openSync(configPath, "r");
  } catch {
    return { ...defaultConfig };
  }
  let stat: { mtimeMs: number; size: number };
  let raw: string;
  try {
    stat = fstatSync(fd);
    if (configMemo && configMemo.path === configPath && configMemo.mtimeMs === stat.mtimeMs && configMemo.size === stat.size) {
      return structuredClone(configMemo.config);
    }
    raw = readFileSync(fd, "utf-8");
  } catch {
    return { ...defaultConfig };
  } finally {
    closeSync(fd);
  }
  let parsed: Partial<IxConfig> | null;
  const { parse } = yaml(); // outside the try: not a parse error if it fails
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
    parsed.workspaces = parsed.workspaces.map((w) => ({
      ...w,
      workspace_id: String(w.workspace_id),
      ...(w.pending_prune_of !== undefined ? { pending_prune_of: wellFormedPendingPrunes(w.pending_prune_of, w.root_path) } : {}),
    }));
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

/**
 * Read config.yaml, apply `mutate`, and write it back, with no other Ix
 * process writing it in between.
 *
 * `saveConfig` alone is atomic per write but last-writer-wins: eight `ix map`
 * runs registering eight new repositories each read the file, each appended
 * its own workspace, and each renamed its copy over the others' -- leaving one
 * or two of the eight. Under the lock each one reads what the previous one
 * wrote. A writer that cannot get the lock waits, breaks it if its holder is
 * gone, and otherwise fails with `ConfigLockError`; it never writes unlocked
 * (see config-lock.ts).
 *
 * `mutate` gets a fresh read, never the memoised one, and returns the config
 * to save, or undefined to leave the file as it is. It must be synchronous.
 */
export function updateConfig<T>(mutate: (config: IxConfig) => { save?: IxConfig; result: T }): T {
  const configPath = join(ixHome(), "config.yaml");
  return withConfigLock(configPath, `config write ${configPath}`, () => {
    configMemo = undefined;
    const { save, result } = mutate(loadConfig());
    if (save) saveConfig(save);
    return result;
  });
}

/**
 * Run `fn` holding the config lock, for a write that is not a plain
 * `updateConfig` -- creating the file, say. Synchronous only.
 */
export function withConfigWriteLock<T>(fn: () => T): T {
  const configPath = join(ixHome(), "config.yaml");
  return withConfigLock(configPath, `config write ${configPath}`, fn);
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

/**
 * Write `config` over config.yaml, keeping the keys OSS does not own. Takes the
 * config lock (re-entrantly, so `updateConfig` can call it), and re-reads the
 * file under it, so the keys it preserves are the current ones.
 */
export function saveConfig(config: IxConfig): void {
  const configDir = ixHome();
  const configPath = join(configDir, "config.yaml");
  withConfigLock(configPath, `config write ${configPath}`, () => writeConfigLocked(config, configDir, configPath));
}

function writeConfigLocked(config: IxConfig, configDir: string, configPath: string): void {
  // 0700, to match the 0600 the config itself is written with below: the file
  // holds credentials (Pro's instances carry a tunnel JWT and a long-lived IdP
  // refresh token), and a directory created at the default umask (typically
  // 0755) lets anyone on the host list the names beside it. `mode` applies only
  // to directories this call creates, so an existing ~/.ix keeps its own mode.
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const { parse } = yaml(); // outside the try: not a parse error if it fails
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
  //
  // On Windows the rename is MoveFileEx with REPLACE_EXISTING, which fails with
  // EPERM/EBUSY while another process has the target open -- an unlocked
  // reader, an indexer, antivirus -- so it is retried for a few seconds.
  const tmpPath = `${configPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, yaml().stringify(merged), { mode: 0o600 });
  try {
    renameWithRetry(tmpPath, configPath);
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
