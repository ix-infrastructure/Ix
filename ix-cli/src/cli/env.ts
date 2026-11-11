// Copyright 2026 Ix Infrastructure Inc.

/**
 * Every `IX_*` environment variable the CLI reads (#948), with one parser for
 * flags and one for numbers.
 *
 * `ENV_VARS` is the source of the variable table on the configuration
 * reference (`scripts/check-env-registry.mjs --write`), and the gate in that
 * script fails CI when code under src/ names an `IX_*` variable that is not
 * registered here. So: a new variable is a new entry here, read through
 * `envFlag` / `envNumber` (or `flagValue` / `numberValue` for a reader that
 * takes the raw string as a parameter), and the docs table is regenerated.
 *
 * Flags (`parseFlag`): unset or empty means the variable's default; `0`,
 * `false` and `no` (any case, surrounding spaces ignored) mean off; any other
 * value means on.
 *
 * Numbers (`parseNumber`): surrounding spaces are ignored, and the rest must be
 * a number `Number()` reads in full: never a numeric prefix, so `15m` is not
 * 15 and keeps the default, as does a negative value. `int` variables take
 * whole numbers only (past MAX_SAFE_INTEGER, MAX_SAFE_INTEGER); `ms` variables
 * also take fractions. Each entry says whether 0 is a value (often "off") or
 * falls back to the default, what an empty value means, and the most it takes.
 *
 * This module imports nothing: anything may read the environment through it,
 * however early in start-up.
 */

/** Which docs list a variable: the configuration reference, or none. */
type Visibility = "public" | "internal";

interface BaseSpec {
  /** One line for the configuration reference. */
  description: string;
  visibility: Visibility;
  /** The default as the docs show it, where the value alone would not say it. */
  defaultText?: string;
}

export interface FlagSpec extends BaseSpec {
  type: "flag";
  /** Unset, or undefined when "unset" is a third state of its own. */
  default: boolean | undefined;
}

export interface NumberSpec extends BaseSpec {
  /** `int`: whole numbers. `ms`: milliseconds, fractions allowed. */
  type: "int" | "ms";
  default: number | undefined;
  /** Whether 0 is a value. When it is not, 0 falls back to the default. */
  zero: boolean;
  /** What an empty (or all-space) value means; the default when absent. */
  empty?: number;
  /** The most it takes. Above it: `max` when `clamp`, else the default. */
  max?: number;
  clamp?: boolean;
}

export interface StringSpec extends BaseSpec {
  type: "string";
}

export interface EnumSpec extends BaseSpec {
  type: "enum";
  values: readonly string[];
}

export type EnvSpec = FlagSpec | NumberSpec | StringSpec | EnumSpec;

export const ENV_VARS = {
  // ── Where Ix keeps things, and which backend it talks to ──────────────────
  IX_HOME: {
    type: "string", visibility: "public", defaultText: "`~/.ix`",
    description: "Relocates everything under `~/.ix`, configuration included. Useful for giving a CI job or a second install its own state. It's read at use, not at install, so move `~/.ix` there rather than expecting the old configuration to be found",
  },
  IX_ENDPOINT: {
    type: "string", visibility: "public", defaultText: "`endpoint` in config.yaml, else `http://localhost:8090`",
    description: "The backend URL. Overrides `endpoint` in the config file",
  },
  IX_TOKEN: {
    type: "string", visibility: "public", defaultText: "the stored local token",
    description: "Bearer token sent to a local backend (localhost or another loopback address) on every request. Overrides the stored local token (see [Local token](#local-token)). Never sent to any other endpoint",
  },
  IX_LOCAL_TOKEN: {
    type: "string", visibility: "public", defaultText: "unset",
    description: "Read by the local backend, not the CLI: the token it requires on every request. `ix docker start --local-token` writes it to `~/.ix/backend/.env` (see [Local token](#local-token))",
  },
  IX_FORMAT: {
    type: "enum", values: ["text", "json", "llm"], visibility: "public", defaultText: "`format` in config.yaml, else `text`",
    description: "Default output format. Overrides the config file. `--format` overrides it",
  },
  IX_LOCK_DIR: {
    type: "string", visibility: "public", defaultText: "`<IX_HOME>/locks`",
    description: "Where the CLI keeps the lock files that stop two `ix map` runs (or two stitches) on one workspace at once. For a read-only `IX_HOME`",
  },

  // ── Diagnostics ───────────────────────────────────────────────────────────
  IX_DEBUG: {
    type: "flag", default: false, visibility: "public",
    description: "Prints full stack traces on errors, and one stderr line per backend request with the `X-Correlation-Id` it sent (the backend tags its request and slow-query logs with it). Every request of one `ix` run shares the id's prefix",
  },
  IX_PARSE_DEBUG: {
    type: "flag", default: false, visibility: "public",
    description: "Read by the parser, which takes only `1`: prints why a file's parse failed on stderr",
  },

  // ── Exit codes and output ─────────────────────────────────────────────────
  IX_STRICT_TARGETS: {
    type: "flag", default: false, visibility: "public",
    description: "What `--strict` does, for every graph command: an ambiguous target exits 2 and a name found only as text exits 3, rather than being answered",
  },
  IX_LEGACY_EXIT_CODES: {
    type: "flag", default: false, visibility: "public",
    description: "Makes every non-zero exit 1, as before exits 2, 3 and 4 had their own meanings",
  },
  IX_NO_UPDATE_CHECK: {
    type: "flag", default: false, visibility: "public",
    description: "Turns off the check for a newer release that `ix` runs when a person is watching (text output on a terminal)",
  },
  IX_STDIN_IDLE_MS: {
    type: "ms", default: 300_000, zero: true, visibility: "public",
    description: "How long a command reading text from stdin waits for the pipe to send anything more before it fails, rather than hanging on a pipe left open. `0` turns it off",
  },
  IX_MISS_PROBE: {
    type: "flag", default: true, visibility: "public",
    description: "When a name is not in the graph, `ix` searches the files for it to say why (not mapped yet, stale, or only text). `0` skips that search, for a tree too large even for one bounded search",
  },

  // ── Reads ─────────────────────────────────────────────────────────────────
  IX_READ_DEADLINE_MS: {
    type: "ms", default: 60_000, zero: true, visibility: "public",
    description: "How long one command's reads may take in all before it fails, so a hung backend fails a query in a minute rather than after each request's 2-minute timeout. The clock restarts after each write the command makes. `ix map`, `ix ingest` and `ix stats` have no read deadline. `0` turns it off. A read that meets a refused or dropped connection, or a 502/503/504, is retried once; writes are not, except as `IX_COMMIT_CONFLICT_RETRIES` and `IX_COMMIT_TRANSIENT_RETRY_MS` describe",
  },
  IX_GRAPH_HEALTH: {
    type: "flag", default: true, visibility: "public",
    description: "Read commands check whether the workspace's graph looks hollowed by another ingest and say so. `0` turns the check off",
  },
  IX_GRAPH_HEALTH_TIMEOUT_MS: {
    type: "ms", default: 2000, zero: false, visibility: "public",
    description: "How long that check may take before the answer goes out without it",
  },
  IX_SMELLS_WAIT: {
    type: "int", default: undefined, zero: false, max: 300, clamp: true, visibility: "public",
    defaultText: "20 (json, llm), 300 (text)",
    description: "Seconds `ix smells` waits for a fresh analysis before showing the stored results; at most 300. `--wait` overrides it. Ignored under MCP",
  },

  // ── ix map: when it runs and how long it may take ─────────────────────────
  IX_MAP_DEADLINE_MS: {
    type: "ms", default: 900_000, zero: true, empty: 0, visibility: "public",
    description: "The wall-clock budget of one `ix map` or `ix ingest`; past it every request is aborted and the command exits. `0` or empty turns it off",
  },
  IX_MAP_LOCK_MAX_MS: {
    type: "ms", default: 1_200_000, zero: false, visibility: "public",
    description: "How long a map or stitch lock may go untouched before the next run treats it as abandoned and takes it",
  },
  IX_STITCH_COOLDOWN_MS: {
    type: "ms", default: 900_000, zero: true, visibility: "public",
    description: "How long `ix map` declines to start a cross-repo stitch after one that may still be running on the backend. `0` turns the cooldown off",
  },
  IX_STITCH_WAIT_MS: {
    type: "ms", default: 30_000, zero: true, visibility: "public",
    description: "How long `ix map` waits for a stitch that is still in flight to finish before skipping its own",
  },
  IX_AUTO_MAP: {
    type: "flag", default: false, visibility: "public",
    description: "Set by editor and agent hooks: marks an `ix map` as automatic. An automatic run ingests and defers computing the map, and is skipped against a remote backend",
  },
  IX_AUTO_MAP_CLOUD: {
    type: "flag", default: false, visibility: "public",
    description: "Lets an automatic `ix map` (`IX_AUTO_MAP`) run against a remote backend too",
  },
  IX_MAP_EAGER: {
    type: "flag", default: false, visibility: "public",
    description: "Makes an automatic `ix map` compute the map after an incremental edit too, for a hook that reads regions straight from `ix map`",
  },
  IX_MAP_BACKGROUND_REFRESH: {
    type: "flag", default: true, visibility: "public",
    description: "Read commands start a background `ix map` when the map is stale. `0` turns that off: they answer from the last map and say it is stale",
  },
  IX_MAP_REFRESH_DEBOUNCE_MS: {
    type: "ms", default: 30_000, zero: true, empty: 0, visibility: "public",
    description: "How long after one background refresh another may start. `0` or empty means no wait",
  },
  IX_MAP_BACKGROUND_TIMEOUT_MS: {
    type: "ms", default: 300_000, zero: false, visibility: "public",
    description: "The background refresh's hard time limit, so a wedged refresh cannot hold the map lock",
  },
  IX_CONFIG_LOCK_WAIT_MS: {
    type: "ms", default: 30_000, zero: false, visibility: "public",
    description: "How long a write to `config.yaml` waits for another process's write to finish before failing",
  },
  IX_CONFIG_LOCK_STALE_MS: {
    type: "ms", default: 30_000, zero: false, visibility: "public",
    description: "How long the `config.yaml` lock may go untouched before it is presumed abandoned",
  },

  // ── ix map / ix ingest: parsing ───────────────────────────────────────────
  IX_PARSE_BUDGET_MS: {
    type: "ms", default: 10_000, zero: true, visibility: "public",
    description: "How long `ix map` / `ix ingest` may spend parsing one file before skipping it and naming it in the summary. A skipped file is tried again on every run, and `ix status` warns about it until it is in the graph. `0` turns the budget off",
  },
  IX_PARSE_WORKERS: {
    type: "int", default: 8, zero: false, visibility: "public",
    description: "Most parse workers `ix map` / `ix ingest` starts (never more than the cores less one). Workers start as files need them, one per 50 files",
  },
  IX_PARSE_STREAM_CHUNK: {
    type: "int", default: 500, zero: false, visibility: "public",
    description: "Files parsed per batch before the batch is committed. For tests: a small value makes a small run behave like a large one",
  },

  // ── ix map / ix ingest: commits ───────────────────────────────────────────
  IX_COMMIT_CONCURRENCY: {
    type: "int", default: 8, zero: false, visibility: "public",
    description: "Commit requests `ix map` / `ix ingest` keeps in flight at once. Lower it to go easier on a struggling backend",
  },
  IX_COMMIT_HTTP_MAX_FILES: {
    type: "int", default: 1000, zero: false, visibility: "public",
    description: "Most files one commit request carries",
  },
  IX_COMMIT_MAX_OPS: {
    type: "int", default: 45_000, zero: false, visibility: "public",
    description: "Most graph operations one commit request carries: the backend's transaction grows with them",
  },
  IX_COMMIT_FAILURE_LIMIT: {
    type: "int", default: 5, zero: true, visibility: "public",
    description: "Consecutive failed commits before `ix map` stops. It stops after one when the backend reports its database unreachable. `0` never stops",
  },
  IX_COMMIT_CONFLICT_RETRIES: {
    type: "int", default: 6, zero: true, visibility: "public",
    description: "Retries of one commit after a lock conflict or a dropped connection. `0` turns these retries off. It does not affect the 502/503/504/429 retries; see `IX_COMMIT_TRANSIENT_RETRY_MS`",
  },
  IX_COMMIT_TRANSIENT_RETRY_MS: {
    type: "ms", default: 5000, zero: true, visibility: "public",
    description: "The total time one bulk commit may spend retrying after a 502, 503, 504 or 429, counting both the requests and the waits between them (at most three retries, and at most one after a 504). A bulk is sent again only if another request as long as the one that failed still fits, so a slow bulk goes straight to the per-file fallback. `Retry-After` is honoured up to that limit; a longer value is cut to it. `0` turns these retries off",
  },
  IX_COMMIT_BASE_REV_RETRIES: {
    type: "int", default: 8, zero: false, visibility: "public",
    description: "Re-sends of a commit after another writer on the same backend moved the graph revision under it",
  },
  IX_BULK_DELETES: {
    type: "flag", default: undefined, visibility: "public", defaultText: "decided by the backend's release",
    description: "Whether the backend's bulk commit route takes patches that delete nodes. Set it on or off for a backend build that reports no release",
  },
  IX_RECONCILE_ON_FORCE: {
    type: "flag", default: false, visibility: "public",
    description: "Makes an `ix map --force` (or `ix ingest --force`) also remove nodes an earlier extractor wrote and the current one no longer does, at the files' current content. `ix map` does this by itself on the run after an extractor change, on a backend from 1.0.33 that applies deletes in bulk. Set this to finish a cleanup that run could not do (an older backend, since upgraded) or did not finish (its budget ran out): it reads only what was left. Without a record of what was left, it reads the patch of the extractor before the current one for every file",
  },
  IX_ORPHAN_SWEEP_MAX_MS: {
    type: "ms", default: 60_000, zero: true, visibility: "public",
    description: "Time budget of that cleanup in one run. Files past it are committed without the cleanup and named for the next `IX_RECONCILE_ON_FORCE=1` run",
  },
  IX_ORPHAN_SWEEP_MAX_REQUESTS: {
    type: "int", default: 25_000, zero: true, visibility: "public",
    description: "Request budget of that cleanup in one run: one stored-patch read per file, one node read per 1000 candidates",
  },
  IX_PATCH_ACTOR: {
    type: "string", visibility: "public", defaultText: "`ix/ingestion` (`ix/github-ingest` for `ix ingest --github`)",
    description: "The `actor` stamped on each graph patch `ix map` / `ix ingest` sends. Set it to empty (`IX_PATCH_ACTOR=`) for a backend that authenticates writers and stamps the verified principal itself: such a backend rejects a non-empty actor that differs from the principal with 403 `body actor ... conflicts with verified principal`. Any other value is sent as the actor",
  },

  // ── MCP, hooks and start-up ───────────────────────────────────────────────
  IX_MCP_SUBPROCESS: {
    type: "flag", default: false, visibility: "public",
    description: "Runs each MCP tool call in its own `ix` process",
  },
  IX_LOAD_ALL_COMMANDS: {
    type: "flag", default: false, visibility: "public",
    description: "Loads every command module on each call, as releases before the start-up fast path did. Without Ix Pro installed, `ix <command>` normally loads only that command; with Ix Pro installed every call already loads everything, so this changes nothing there. If a command misbehaves on an install without Pro, try it again with this set: a difference between the two is a bug worth reporting",
  },
  IX_HOOK_TIMEOUT_MS: {
    type: "ms", default: 3000, zero: false, visibility: "public",
    description: "How long `ix hook post-edit` may take before it gives up and prints nothing",
  },
  IX_HOOK_DEBUG: {
    type: "flag", default: false, visibility: "public",
    description: "Makes `ix hook post-edit` say on stderr why it printed what it did",
  },
  IX_HOOK_LOG: {
    type: "string", visibility: "public", defaultText: "unset",
    description: "A file `ix hook post-edit` appends one JSON line to per call, saying what it did and why",
  },
  IX_HOOK_STATE_DIR: {
    type: "string", visibility: "public", defaultText: "`<IX_HOME>/hook-state`",
    description: "Where `ix hook post-edit` remembers which edited symbols it already reported this session",
  },

  // ── Internal: set by Ix itself, or test seams ─────────────────────────────
  IX_CALLER: {
    type: "enum", values: ["mcp"], visibility: "internal",
    description: "Set to `mcp` by the MCP runner while a command's output is for an MCP client",
  },
  IX_MCP_CHILD: {
    type: "flag", default: false, visibility: "internal",
    description: "Set by `ix mcp` on the `ix` processes it starts; turns off the update check there",
  },
  IX_MAP_FULL_INGEST: {
    type: "flag", default: false, visibility: "internal",
    description: "Set by `ix watch`: its `ix map` runs send full patches rather than topology only",
  },
  IX_MAP_COALESCE_EXIT_CODE: {
    type: "int", default: undefined, zero: false, max: 255, visibility: "internal",
    description: "Set by `ix watch`: the exit code (1-255) of an `ix map` that joined a run already in progress, so the caller can tell it from success",
  },
  IX_BUNDLED_COMPOSE: {
    type: "string", visibility: "internal",
    description: "Test seam, honoured only under NODE_ENV=test: the compose file `ix docker` treats as the one this release ships",
  },
  IX_VIEW_PROXY_TIMEOUT_MS: {
    type: "ms", default: 600_000, zero: false, visibility: "internal",
    description: "Test seam, honoured only under NODE_ENV=test, read by the `ix view` server script itself: its backend proxy timeout",
  },
  IX_VIEW_BACKEND_URL: {
    type: "string", visibility: "internal",
    description: "Test seam, honoured only under NODE_ENV=test, read by the `ix view` server script: the backend it proxies to",
  },
  IX_VIEW_MAP_MAIN: {
    type: "string", visibility: "internal",
    description: "Test seam, honoured only under NODE_ENV=test, read by the `ix view` server script: the CLI entry it runs for a remap",
  },
  IX_VIEW_BACKEND_TOKEN: {
    type: "string", visibility: "internal",
    description: "Set by `ix view start` for the server script it launches: the backend token, kept out of argv",
  },
} as const satisfies Record<`IX_${string}`, EnvSpec>;

type Registry = typeof ENV_VARS;
export type EnvName = keyof Registry;
type NamesOfType<T extends EnvSpec["type"]> = {
  [K in EnvName]: Registry[K]["type"] extends T ? K : never;
}[EnvName];
export type FlagName = NamesOfType<"flag">;
export type NumberName = NamesOfType<"int" | "ms">;

/** A flag's value: a boolean, or undefined too when its default is "unset". */
type FlagValue<N extends FlagName> = Registry[N]["default"] extends boolean ? boolean : boolean | undefined;
/** A number's value: a number, or undefined too when it has no default. */
type NumberValue<N extends NumberName> = Registry[N]["default"] extends number ? number : number | undefined;

type Env = Readonly<Record<string, string | undefined>>;

const OFF = new Set(["0", "false", "no"]);

/**
 * The one flag parser: undefined for unset or empty, false for `0`, `false`
 * or `no` (any case, surrounding spaces ignored), true for anything else.
 */
export function parseFlag(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  return !OFF.has(value);
}

/** How `parseNumber` reads one variable; a `NumberSpec` is one. */
export type NumberRule = Pick<NumberSpec, "type" | "zero" | "empty" | "max" | "clamp">;

/**
 * The one number parser: the value `rule` reads `raw` as, or undefined when
 * it is unset or not a value (the caller's default applies).
 *
 * `Number()`, never `parseInt`: `parseInt` reads any numeric prefix, so `15m`
 * was 15 ms and `1e3` was 1. What `Number()` reads in full (`1000`, `1e3`,
 * `2.5`) is the value; anything else (`15m`, `-1`, `abc`) is not one.
 */
export function parseNumber(raw: string | undefined, rule: NumberRule): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === "") return rule.empty;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (rule.type === "int" && !Number.isInteger(n)) return undefined;
  if (n === 0) return rule.zero ? 0 : undefined;
  if (rule.max !== undefined && n > rule.max) return rule.clamp ? rule.max : undefined;
  // Not exact past MAX_SAFE_INTEGER, but unmistakably "as many as there can be".
  if (rule.type === "int" && n > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return n;
}

function spec<N extends EnvName>(name: N): Registry[N] {
  return ENV_VARS[name];
}

/** A flag's value from `raw` (for readers that take the raw string as a parameter). */
export function flagValue<N extends FlagName>(name: N, raw: string | undefined): FlagValue<N> {
  return (parseFlag(raw) ?? (spec(name) as FlagSpec).default) as FlagValue<N>;
}

/** A flag's value from the environment. */
export function envFlag<N extends FlagName>(name: N, env: Env = process.env): FlagValue<N> {
  return flagValue(name, env[name]);
}

/** A number's value from `raw` (for readers that take the raw string as a parameter). */
export function numberValue<N extends NumberName>(name: N, raw: string | undefined): NumberValue<N> {
  const rule = spec(name) as NumberSpec;
  return (parseNumber(raw, rule) ?? rule.default) as NumberValue<N>;
}

/** A number's value from the environment. */
export function envNumber<N extends NumberName>(name: N, env: Env = process.env): NumberValue<N> {
  return numberValue(name, env[name]);
}

/** A registered number's default, for modules that export it as a constant. */
export function numberDefault<N extends NumberName>(name: N): Registry[N]["default"] {
  return spec(name).default;
}
