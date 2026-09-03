import { type Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { clearMapBaseline, getEndpoint } from "../config.js";
import { roundFloat } from "../format.js";
import { llmLine, llmError } from "../llm.js";
import { bootstrap, resolveWorkspaceId } from "../bootstrap.js";
import { formatFetchError } from "../errors.js";
import { ingestFiles, type IngestFilesSummary } from "./ingest.js";
import { detectSystem } from "../system.js";
import { getRemoteRunner, isCloudReady } from "../remote.js";
import { acquireMapLock } from "../single-flight.js";
import { canRenderProgress } from "../stderr.js";
import { loadIngestBaseline } from "../ingest-baseline.js";
import { saveMapBaseline } from "../map-baseline.js";
import { resolveMapRoot } from "../map-root.js";

// Hard wall-clock budget for a single `ix map`. Past this, the shared deadline
// signal aborts every in-flight request and the command exits, so a single
// invocation can never grind for hours against an unhealthy backend. Tunable
// via IX_MAP_DEADLINE_MS; 0 disables the budget.
const DEFAULT_MAP_DEADLINE_MS = 15 * 60 * 1000;

function mapDeadlineSignal(): AbortSignal | undefined {
  const raw = process.env.IX_MAP_DEADLINE_MS;
  const budget = raw !== undefined ? Number.parseInt(raw, 10) : DEFAULT_MAP_DEADLINE_MS;
  if (!Number.isFinite(budget) || budget <= 0) return undefined; // disabled
  return AbortSignal.timeout(budget);
}

// Whether an automatically-triggered map should be skipped. Background refresh
// (the editor/agent hooks that re-map on change) is a local-only convenience:
// against a remote backend it would push a write on every change from every
// client, so it is skipped there and remote ingestion stays deliberate. Manual
// `ix map` never sets IX_AUTO_MAP, so it is never skipped. IX_AUTO_MAP_CLOUD=1
// opts the automatic path back in for users who do want remote auto-refresh.
export function shouldSkipAutoMap(opts: { auto: boolean; cloudReady: boolean }): boolean {
  if (!opts.auto || !opts.cloudReady) return false;
  if (process.env.IX_AUTO_MAP_CLOUD === "1") return false;
  return true;
}

/** Optional exit code for callers that must distinguish coalescing from success. */
export function requestedMapCoalesceExitCode(
  raw = process.env.IX_MAP_COALESCE_EXIT_CODE,
): number | undefined {
  if (raw === undefined) return undefined;
  const code = Number(raw);
  return Number.isInteger(code) && code >= 1 && code <= 255 ? code : undefined;
}

export function applyRequestedMapCoalesceExitCode(
  raw = process.env.IX_MAP_COALESCE_EXIT_CODE,
  apply: (code: number) => void = code => { process.exitCode = code; },
): boolean {
  const code = requestedMapCoalesceExitCode(raw);
  if (code === undefined) return false;
  apply(code);
  return true;
}

/** Watch opts into full patches; ordinary `ix map` keeps its topology-only ingest. */
export function mapModeForIngest(raw = process.env.IX_MAP_FULL_INGEST): boolean {
  return raw !== "1";
}

export interface MapRegion {
  id: string;
  label: string;
  label_kind: string;
  level: number;
  file_count: number;
  child_region_count: number;
  parent_id: string | null;
  cohesion: number;
  external_coupling: number;
  boundary_ratio: number;
  confidence: number;
  crosscut_score: number;
  dominant_signals: string[];
  interface_node_count: number;
  children?: MapRegion[];
}

interface MapPreflight {
  cost: {
    file_count: number;
    directory_count: number;
    directory_quadratic: number;
    symbol_estimate: number;
    edge_estimate: number;
  };
  capacity: {
    cpu_cores: number;
    heap_max_bytes: number;
    heap_free_bytes: number;
    container_memory: number | null;
    disk_free_bytes: number | null;
  };
  risk: string;
  mode: string;
  warnings: string[];
  duration_ms: number;
}

interface MapPersistence {
  region_nodes: number;
  file_edges: number;
  region_edges: number;
  delete_ops: number;
  total_ops: number;
}

export interface MapResult {
  file_count: number;
  region_count: number;
  levels: number;
  map_rev: number;
  regions: MapRegion[];
  hierarchy: MapRegion[];
  outcome?: string;
  preflight?: MapPreflight;
  persistence?: MapPersistence;
}

/**
 * The backend's MapOutcome labels that mean "a map was produced" (MapTypes.scala).
 *
 * The other two it can send — `local_map_too_large` and `local_map_not_recommended`
 * — are guardrail refusals that legitimately carry no regions, so they are left
 * out: an empty response is the expected shape there, not a contradiction.
 *
 * `coupling_unchanged` belongs in this set even though it sounds like a skip.
 * The backend answers it with the cached map from the last build's revision
 * (`map.copy(outcome = CouplingUnchanged)`), not an empty delta — so an empty
 * one is a real empty hierarchy being served from cache, which is exactly the
 * state worth catching on a retry.
 */
const COMPLETED_MAP_OUTCOMES = new Set([
  "full_local_completed",
  "fast_local_completed",
  "incremental_completed",
  "coupling_unchanged",
]);

/**
 * A completed map cannot legitimately contain no files immediately after a
 * clean ingest found supported source files. Treat that contradiction as a
 * failure instead of telling hooks and agents that an empty hierarchy is
 * current.
 */
export function describeEmptyCompletedMap(
  result: Pick<MapResult, "file_count" | "region_count" | "regions" | "outcome">,
  ingest: Pick<IngestFilesSummary, "filesDiscovered" | "patchesApplied" | "parseErrors" | "commitErrors"> | undefined,
): string | undefined {
  if (!ingest || ingest.filesDiscovered <= 0 || ingest.parseErrors > 0 || ingest.commitErrors > 0) {
    return undefined;
  }
  if (!result.outcome || !COMPLETED_MAP_OUTCOMES.has(result.outcome)) return undefined;
  if (result.file_count !== 0 || result.region_count !== 0 || result.regions.length !== 0) return undefined;

  const sourceFiles = ingest.filesDiscovered;
  const patches = ingest.patchesApplied;
  return `Backend reported ${result.outcome}, but mapped 0 files after local ingest found ${sourceFiles} supported source ${sourceFiles === 1 ? "file" : "files"} (${patches} ${patches === 1 ? "patch" : "patches"} committed). The source graph was ingested, but no architecture hierarchy was created. The active backend may not map this source language yet. The source ingest baseline was preserved, so the next 'ix map' can reuse unchanged files.`;
}

/**
 * A completed response that counted files but produced no regions is not a
 * hierarchy either. #524: a two-file mixed PHP/JSON workspace maps
 * `full_local_completed` with `file_count: 1` and `region_count: 0`, and the
 * one class it did count then reports `hasMapData: false`.
 *
 * The signal is the absent region set, deliberately NOT a coverage ratio of
 * mapped files to discovered files. `filesDiscovered` counts every supported
 * extension — .md, .json, .yaml, .css — while a hierarchy only ever covers
 * files the backend can couple, so a healthy map routinely covers a small
 * minority of them: #534 records 381 files of ~7,400 on a real PHP workspace.
 * Any ratio threshold rejects that map on every run, and a rejection clears
 * the completion marker, so the workspace could never record one again.
 */
export function describeRegionlessCompletedMap(
  result: Pick<MapResult, "file_count" | "region_count" | "regions" | "outcome">,
  ingest: Pick<IngestFilesSummary, "filesDiscovered" | "patchesApplied" | "parseErrors" | "commitErrors"> | undefined,
): string | undefined {
  if (!ingest || ingest.filesDiscovered < 2 || ingest.parseErrors > 0 || ingest.commitErrors > 0) {
    return undefined;
  }
  if (!result.outcome || !COMPLETED_MAP_OUTCOMES.has(result.outcome)) return undefined;
  // file_count 0 is the empty-map case above, which has its own diagnosis.
  if (result.file_count <= 0) return undefined;
  if (result.region_count !== 0 || result.regions.length !== 0) return undefined;

  const sourceFiles = ingest.filesDiscovered;
  const patches = ingest.patchesApplied;
  return `Backend reported ${result.outcome}, but produced 0 regions while mapping ${result.file_count} of ${sourceFiles} supported source files after a clean local ingest (${patches} ${patches === 1 ? "patch" : "patches"} committed). The source graph was ingested, but no architecture hierarchy was created for it. The source ingest baseline was preserved, so the next 'ix map' can reuse unchanged files.`;
}

/**
 * Report files the local ingest could not turn into a patch.
 *
 * `ingestFiles` counts these into `parseErrors` and writes a `[patch build
 * error]` line per file, but `ix map` runs it in a silent/machine format on
 * every path that matters, so the count is the only surviving signal — and
 * until #554 nothing read it. Both completed-map sanity checks above
 * deliberately bail out when `parseErrors > 0`, which left a partial map as
 * the one failure mode `ix map` never mentioned.
 *
 * Deliberately not phrased as "the map is incomplete": the same run goes on to
 * persist a completed map baseline, so `ix doctor` answers "Completed map for
 * this workspace" right after this line prints. That is correct — a file the
 * parser cannot handle is normal and must not turn doctor red for ever (#530,
 * #536) — so the warning states what is missing rather than contradicting the
 * health signal beside it.
 *
 * Exported for tests; returns the message rather than writing it so the
 * formatting is assertable without capturing stderr.
 */
export function describeDroppedFiles(
  ingest: Pick<IngestFilesSummary, "parseErrors" | "commitErrors"> | undefined,
): string | undefined {
  if (!ingest) return undefined;
  const parse = ingest.parseErrors;
  const commit = ingest.commitErrors;
  if (parse <= 0 && commit <= 0) return undefined;

  const parts: string[] = [];
  if (parse > 0) parts.push(`${parse} ${parse === 1 ? "file" : "files"} failed to build a patch`);
  if (commit > 0) parts.push(`${commit} ${commit === 1 ? "patch" : "patches"} failed to commit`);
  return `${parts.join(" and ")} — those files are absent from the graph. Re-run with 'ix ingest' to see the per-file errors.`;
}

function emitDroppedFileWarning(
  ingest: Pick<IngestFilesSummary, "parseErrors" | "commitErrors"> | undefined,
): void {
  const message = describeDroppedFiles(ingest);
  if (message) process.stderr.write(chalk.yellow(`  ${message}\n`));
}

/**
 * A completed map with no usable hierarchy invalidates the architecture
 * completion baseline. Keeping it would make `ix status` report
 * mapCompleted=true for a hierarchy that does not exist. The next run may
 * hash-skip unchanged files, so detection is based on discovered supported
 * sources rather than only newly committed patches.
 *
 * Both rejections clear only the architecture marker: the source ingest that
 * produced the graph was clean, and clearing its baseline too is what forced a
 * full reparse on every retry (#534).
 */
export function invalidateBaselineForIncompleteCompletedMap(
  result: Pick<MapResult, "file_count" | "region_count" | "regions" | "outcome">,
  ingest: Pick<IngestFilesSummary, "filesDiscovered" | "patchesApplied" | "parseErrors" | "commitErrors"> | undefined,
  projectRoot: string,
  invalidate: (root: string) => void = clearMapBaseline,
): string | undefined {
  const message = describeEmptyCompletedMap(result, ingest)
    ?? describeRegionlessCompletedMap(result, ingest);
  if (message) invalidate(projectRoot);
  return message;
}

/**
 * Persist hierarchy completion only when a non-empty map was actually produced.
 *
 * "Non-empty" is the whole result, deliberately not the region count alone. A
 * single-file workspace maps `1 files · 0s/0ss/0m regions` and that is
 * finished, not partial — there is no hierarchy to build over one file, and no
 * later `ix map` will produce one. Refusing to record it leaves `ix status`
 * reading map_complete=false and `ix doctor` unhealthy for ever, with the
 * suggested fix being the command that just ran.
 *
 * The regionless-with-real-source case is already rejected upstream by
 * `describeRegionlessCompletedMap`, which returns before this is reached, and
 * which knows the discovered-file count this function does not.
 */
export function persistCompletedMapBaseline(
  result: Pick<MapResult, "file_count" | "region_count" | "regions" | "outcome">,
  projectRoot: string,
): boolean {
  if (result.outcome && !COMPLETED_MAP_OUTCOMES.has(result.outcome)) return false;
  if (result.file_count === 0 && result.region_count === 0 && result.regions.length === 0) return false;
  const sourceBaseline = loadIngestBaseline(projectRoot);
  if (!sourceBaseline) return false;
  return saveMapBaseline(projectRoot, sourceBaseline.currentRev);
}

type MapSortMode = "importance" | "confidence" | "size" | "alpha";
export interface MapTextRenderOptions {
  level?: string;
  minConfidence: string;
  maxItems: string;
  allItems?: boolean;
  sort: string;
  graph?: boolean;
  list?: boolean;
  verbose?: boolean;
}

export function registerMapCommand(program: Command): void {
  program
    .command("map [path]")
    .description("Map the architectural hierarchy of a codebase")
    .option("--format <fmt>", "Output format (text|json|llm|silent)", "text")
    .option("--level <n>", "Show only regions at this level (1=finest, higher=coarser)")
    .option("--min-confidence <n>", "Only show regions above this confidence threshold (0-1)", "0")
    .option("--max-items <n>", "Max items to show per section in text output (default: 10)", "10")
    .option("--all-items", "Show all items in each section (overrides --max-items)")
    .option("--sort <mode>", "Sort mode for text output (importance|confidence|size|alpha)", "importance")
    .option("--graph", "Render the hierarchy as a graph/tree view (default)")
    .option("--list", "Render the ranked list view instead of the default graph/tree view")
    .option("--full", "Force full local map, bypassing automatic safety limits (advanced/testing)")
    .option("--verbose", "Show raw confidence/crosscut scores and signals, plus per-file ingest diagnostics (including why a patch failed to commit)")
    .option("--silent", "Suppress all output except a one-line summary (useful for LLM hooks)")
    .addHelpText(
      "after",
      `
Runs Louvain community detection on the weighted file coupling graph to infer
a multi-level architectural hierarchy. Persists results to the graph as Region
nodes with IN_REGION edges (top-down: system → subsystem → module → file → symbol).

Levels:
  1 = module       (fine-grained, ~5-20 files)
  2 = subsystem    (mid-level, ~20-100 files)
  3 = system       (top-level architectural regions)

Advanced:
  --full    Override automatic local safety limits and force the full local map
            path. Bypasses automatic downgrade to fast mode and the persistence
            safety guardrail. Intended for testing and performance diagnosis.
  --silent  Skip the full map rendering. Prints one summary line to stderr and
            exits. Ideal for LLM hooks and automated workflows where the full
            output would waste context tokens.

Examples:
  ix map .
  ix map --format json
  ix map --silent
  ix map --level 2
  ix map --min-confidence 0.5
  ix map --max-items 10
  ix map --sort confidence
  ix map --graph
  ix map --list
  ix map --all-items
  ix map . --full
  ix map . --full --verbose`
    )
    .action(async (pathArg: string | undefined, opts: { format: string; level?: string; minConfidence: string; maxItems: string; allItems?: boolean; sort: string; graph?: boolean; list?: boolean; full?: boolean; verbose?: boolean; silent?: boolean }) => {
      let cwd: string;
      try {
        cwd = resolveMapRoot(pathArg);
      } catch (err: any) {
        const message = err?.message ?? "Invalid map path";
        if (opts.format === "json") {
          console.log(JSON.stringify({ error: "invalid_map_path", message }, null, 2));
        } else if (opts.format === "llm") {
          console.log(llmError("invalid_map_path", message));
        } else {
          console.error(chalk.red("Error:"), message);
        }
        process.exitCode = 1;
        return;
      }

      const silent = opts.silent === true || opts.format === "silent";

      // Single-flight: refuse to stack. Background refresh can fire `ix map`
      // repeatedly (e.g. once per change); if a map is slow or the backend is
      // unhealthy, those invocations would otherwise pile up and run concurrently
      // against the backend. The first map for a workspace holds the lock; any
      // concurrent one coalesces and exits 0 here. The lock auto-releases on
      // process exit (see single-flight.ts) and a stale lock from a crashed map
      // is stolen, so this never wedges.
      const mapLock = acquireMapLock(cwd, `ix map ${cwd}`);
      if (!mapLock) {
        if (!silent && opts.format !== "json" && opts.format !== "llm") {
          process.stderr.write(chalk.dim("  Another ix map is already running for this workspace — skipping.\n"));
        }
        applyRequestedMapCoalesceExitCode();
        return; // coalesce; the in-flight map will refresh the graph
      }

      // Background refresh is a local-only convenience. When invoked
      // automatically (IX_AUTO_MAP=1, set by the editor/agent hooks) against a
      // remote backend, skip: a remote graph should be fed deliberately, not by
      // a write on every change from every client. Manual `ix map` is never
      // skipped; opt the automatic path back in with IX_AUTO_MAP_CLOUD=1.
      const autoMap = process.env.IX_AUTO_MAP === "1";
      const cloudReady = await isCloudReady();
      if (shouldSkipAutoMap({ auto: autoMap, cloudReady })) {
        if (!silent && opts.format !== "json" && opts.format !== "llm") {
          process.stderr.write(chalk.dim("  Skipping automatic map: active backend is remote (run `ix map` manually to refresh it).\n"));
        }
        return; // lock releases on process exit
      }

      // Shared wall-clock deadline applied to every backend request this command
      // makes (ingest + map), so the whole operation is bounded even if the
      // backend stalls on individual long per-request timeouts.
      const deadlineSignal = mapDeadlineSignal();

      // Auto-detect a multi-repo system (>= 2 child repo roots). When present we
      // scope the map to its system_id; otherwise it's an ordinary single-repo map.
      const systemId = detectSystem(cwd)?.systemId;

      // json and llm are machine formats: suppress progress chatter and route
      // ingestion through the quiet path so stdout carries only the result.
      const machineFormat = opts.format === "json" || opts.format === "llm";
      // Report an error on the right channel: structured record for llm, prose for the rest.
      const emitError = (msg: string) => {
        if (opts.format === "llm") console.log(llmError("backend_error", msg));
        else console.error(chalk.red("Error:"), msg);
      };

      // Print warning when --full override is active
      if (opts.full && !machineFormat && !silent) {
        console.log(chalk.yellow("\nWarning"));
        console.log(chalk.yellow("  Full local map override enabled.\n"));
        console.log("  Ix will ignore automatic local safety limits and attempt full local mapping.");
        console.log("  This may take a long time or fail on very large systems.\n");
      }

      // Ingest the path before mapping so the graph is up to date.
      //
      // Routing: if Pro is loaded AND the user has an active cloud
      // instance configured (isCloudReady === true), route ingestion
      // through the cloud pipeline. To force local, switch the active
      // instance with `ix instance use local` (or `ix instance bind
      // local` to scope to one workspace).
      //
      // The local backend bootstrap below only runs on the local path —
      // cloud ingestion doesn't require a local Ix backend.
      const ingestStart = performance.now();
      let localIngest: IngestFilesSummary | undefined;
      if (cloudReady) {
        const runner = getRemoteRunner()!; // isCloudReady guarantees non-null
        try {
          await runner.runIngestion({
            cwd,
            silent,
            format: (machineFormat || silent) ? "json" : "text",
          });
        } catch (err: any) {
          emitError(formatFetchError(err));
          process.exitCode = 1;
          return;
        }
      } else {
        try {
          await bootstrap(cwd);
        } catch (err: any) {
          emitError(err.message);
          process.exitCode = 1;
          return;
        }
        try {
          localIngest = await ingestFiles(cwd, {
            recursive: true,
            format: (machineFormat || silent) ? "json" : "text",
            printSummary: false,
            suppressOutput: true,
            mapMode: mapModeForIngest(),
            deadlineSignal,
            // `ix map` has no --debug, so the per-file `[commit error] <uri>`
            // detail was unreachable from the command that produced the
            // failure — and the failure message told the user to pass a flag
            // that does not exist. --verbose is map's equivalent lever.
            debug: Boolean(opts.verbose),
          });
        } catch (err: any) {
          emitError(formatFetchError(err));
          process.exitCode = 1;
          return;
        }
      }
      const ingestMs = Math.round(performance.now() - ingestStart);

      const client = new IxClient(getEndpoint(), deadlineSignal);

      const mapBarWidth = 25;
      const mapStart    = performance.now();
      // Same gate as the ingest bar: --silent and the machine formats were the
      // only ways to avoid this, and neither is available to something merely
      // capturing normal output.
      const mapInterval = (!machineFormat && !silent && canRenderProgress()) ? setInterval(() => {
        const elapsed  = performance.now() - mapStart;
        const pct      = 1 - Math.exp(-elapsed / 4000);
        const filled   = Math.round(pct * mapBarWidth);
        const bar      = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(mapBarWidth - filled));
        const pctStr   = chalk.cyan(`${Math.min(Math.round(pct * 100), 99)}%`.padStart(4));
        process.stderr.write(`\r  Computing map...  ${bar}  ${pctStr}`);
      }, 80) : null;

      // Path-2 grouping (Ix#225 Half B): a co-ingest system is found by detectSystem
      // above; a SEPARATELY-ingested repo that the stitcher joined into a system has
      // no local marker, so look its system_id up from the backend and scope to it,
      // making `ix map <repo>` show the whole stitched system.
      let effectiveSystemId = systemId;
      if (!effectiveSystemId) {
        const ws = resolveWorkspaceId(cwd);
        if (ws) {
          const looked = await client.workspaceSystem(ws);
          if (looked.systemId) effectiveSystemId = looked.systemId;
        }
      }

      let result: MapResult;
      try {
        result = await client.map({ full: opts.full, workspaceId: effectiveSystemId ? undefined : resolveWorkspaceId(cwd), systemId: effectiveSystemId }) as MapResult;
      } catch (err: any) {
        if (mapInterval) { clearInterval(mapInterval); process.stderr.write('\r' + ' '.repeat(60) + '\r'); }
        emitError(formatFetchError(err));
        process.exitCode = 1;
        return;
      }
      if (mapInterval) { clearInterval(mapInterval); process.stderr.write('\r' + ' '.repeat(60) + '\r'); }
      const mapMs = Math.round(performance.now() - mapStart);

      const emptyMapError = invalidateBaselineForIncompleteCompletedMap(result, localIngest, cwd);
      if (emptyMapError) {
        emitError(emptyMapError);
        process.exitCode = 1;
        return;
      }
      persistCompletedMapBaseline(result, cwd);

      // stderr, so it reaches a human on the text path and never contaminates
      // the JSON/llm payload on stdout. The exit code deliberately stays 0:
      // plugins read this command's JSON through runners that discard stdout on
      // a non-zero exit, so failing here would hide the very diagnostics the
      // caller needs (the #539 lesson).
      emitDroppedFileWarning(localIngest);

      if (silent) {
        const systems    = result.regions.filter(r => r.label_kind === "system").length;
        const subsystems = result.regions.filter(r => r.label_kind === "subsystem").length;
        const modules    = result.regions.filter(r => r.label_kind === "module").length;
        // Ix#568: `--silent` returns before both format branches AND wins over
        // `--format llm`, so it is the one output the hooks this field exists
        // for actually see. A skipped stitch deliberately does not move the exit
        // code -- without a token here an automated consumer cannot tell a clean
        // map from one whose cross-repo edges are up to 15 minutes stale.
        // Ix#568. The RULE, not just the fact -- and not for `incomplete`.
        //
        // `--silent` is the hook surface: one terse line per run. `incomplete`
        // fires on nearly every incremental map, so emitting it here would put
        // a token on almost every line and make `stitch_skipped` useless as a
        // signal, while a consumer that actually needs to know an incremental
        // map registered nothing has `--format json` and `--format llm`, which
        // both carry it. What stays here is the guard refusing -- the case that
        // means a backend is being protected from stacked joins.
        const rule = localIngest?.stitchSkippedRule;
        const stitch =
          rule === undefined || rule === "incomplete" || rule === "run-errors"
            ? ""
            : ` · stitch_skipped=${rule}`;
        process.stderr.write(
          `map: ${result.file_count} files · ${systems}s/${subsystems}ss/${modules}m regions · ${mapMs}ms${stitch}\n`
        );
        return;
      }

      if (!machineFormat) {
        const mapSec = (mapMs / 1000).toFixed(1);
        process.stderr.write(chalk.dim(`  Mapped in ${mapSec}s\n`));
      }

      const minConf = parseFloat(opts.minConfidence ?? "0");
      const levelFilter = opts.level ? parseInt(opts.level, 10) : null;
      const parsedMaxItems = parseInt(opts.maxItems ?? "10", 10);
      const maxItems = Number.isFinite(parsedMaxItems) && parsedMaxItems > 0 ? parsedMaxItems : 10;
      const sortMode = normalizeSortMode(opts.sort);

      let regions = result.regions;
      if (levelFilter !== null) regions = regions.filter(r => r.level === levelFilter);
      if (minConf > 0) regions = regions.filter(r => r.confidence >= minConf);

      if (opts.format === "json") {
        console.log(JSON.stringify({
          file_count: result.file_count,
          region_count: regions.length,
          levels: result.levels,
          map_rev: result.map_rev,
          outcome: result.outcome,
          // Always present so a consumer can branch on them without a key check.
          // A dropped file is silent otherwise: the backend still answers with a
          // completed outcome, so `outcome` alone cannot distinguish a whole map
          // from one missing every file that failed to build a patch (#554).
          parse_errors: localIngest?.parseErrors ?? 0,
          commit_errors: localIngest?.commitErrors ?? 0,
          // Ix#568. The whole reason this is reported at all is hooks that run
          // `ix map` and read the machine output; leaving it only in
          // `ix ingest --format json` puts it where those hooks never look.
          // `?? null`, not left undefined: JSON.stringify drops an undefined
          // value, so a consumer could not tell the field apart from an older
          // CLI that never emitted it. Its siblings are always present too.
          stitch_skipped: localIngest?.stitchSkipped ?? null,
          stitch_skipped_rule: localIngest?.stitchSkippedRule ?? null,
          regions: regions.map((r: any) => ({
            label: r.label,
            level: r.level,
            files: r.file_count,
            cohesion: roundFloat(r.cohesion),
            coupling: roundFloat(r.external_coupling),
            confidence: roundFloat(r.confidence),
            signals: r.dominant_signals,
          })),
        }, null, 2));
        return;
      }
      if (opts.format === "llm") {
        renderMapLlm(result, regions, localIngest);
        return;
      }
      renderMapText(result, cwd, opts);
    });
}

/** Flat one-record-per-line region listing with explicit parent= for the llm format. */
export function renderMapLlm(
  result: MapResult,
  regions: MapRegion[],
  ingest?: Pick<IngestFilesSummary, "parseErrors" | "commitErrors" | "stitchSkipped" | "stitchSkippedRule">,
): void {
  console.log(llmLine("map", [
    ["files", result.file_count],
    ["regions", regions.length],
    ["levels", result.levels],
    ["rev", result.map_rev],
    ["outcome", result.outcome],
    // The same signal the json payload carries as parse_errors/commit_errors.
    // Agents are told to pass --format llm unconditionally, so leaving it out
    // of this record hid the dropped files from the one consumer #554 is about.
    // Emitted only when non-zero, per the format's rule that zeros carrying no
    // signal are dropped (docs/llm-format.md); a clean ingest says nothing.
    ["parse_errors", ingest?.parseErrors ? ingest.parseErrors : undefined],
    ["commit_errors", ingest?.commitErrors ? ingest.commitErrors : undefined],
    // Ix#568. `--format llm` and `--silent` are what the hooks this field was
    // added for actually read; shipping it only in `--format json` put it
    // where they never look.
    ["stitch_skipped", ingest?.stitchSkipped],
    ["stitch_skipped_rule", ingest?.stitchSkippedRule],
  ]));
  for (const r of regions) {
    console.log(llmLine("region", [
      ["id", r.id],
      ["kind", r.label_kind],
      ["label", r.label],
      ["level", r.level],
      ["files", r.file_count],
      ["parent", r.parent_id],
      ["children", r.child_region_count > 0 ? r.child_region_count : undefined],
      ["cohesion", roundFloat(r.cohesion)],
      ["coupling", roundFloat(r.external_coupling)],
      // crosscut_score is emitted only when meaningful (>0.01), matching the
      // compact JSON; consumers (e.g. the ix-architecture skill) gate on it.
      ["crosscut", r.crosscut_score > 0.01 ? roundFloat(r.crosscut_score) : undefined],
      ["confidence", roundFloat(r.confidence)],
      ["signals", r.dominant_signals.length > 0 ? r.dominant_signals.join(",") : undefined],
    ]));
  }
}

export function renderMapText(result: MapResult, cwd: string, opts: MapTextRenderOptions): void {
  const minConf = parseFloat(opts.minConfidence ?? "0");
  const levelFilter = opts.level ? parseInt(opts.level, 10) : null;
  const parsedMaxItems = parseInt(opts.maxItems ?? "10", 10);
  const maxItems = Number.isFinite(parsedMaxItems) && parsedMaxItems > 0 ? parsedMaxItems : 10;
  const sortMode = normalizeSortMode(opts.sort);
  const showGraph = !opts.list;

  let regions = result.regions;
  if (levelFilter !== null) regions = regions.filter(r => r.level === levelFilter);
  if (minConf > 0) regions = regions.filter(r => r.confidence >= minConf);

  console.log(
    `\n${chalk.bold("Architectural Map")} — ` +
    `${result.file_count} files · ${result.region_count} regions`
  );
  const topSystem = pickTopSystemName(result.regions, cwd);
  if (topSystem) {
    console.log(chalk.dim(`System: ${topSystem}`));
  }

  if (result.outcome === "fast_local_completed") {
    console.log(chalk.yellow("  Large system detected") + chalk.dim(" — using Fast Map"));
    console.log(chalk.dim("  Reduced coupling model with full region hierarchy output."));
  }

  if (regions.length === 0) {
    console.log(chalk.dim("\n  No regions found matching filters."));
    return;
  }

  const regionById = new Map(result.regions.map(r => [r.id, r]));
  const CROSSCUT_THRESHOLD = 0.10;
  const systemsCount = regions.filter(r => r.label_kind === "system").length;
  const subsystemsCount = regions.filter(r => r.label_kind === "subsystem").length;
  const modulesCount = regions.filter(r => r.label_kind === "module").length;
  const wellDefined = regions.filter(r => r.confidence >= 0.75).length;
  const moderate = regions.filter(r => r.confidence >= 0.50 && r.confidence < 0.75).length;
  const fuzzy = regions.filter(r => r.confidence < 0.50).length;
  const crossCutting = regions.filter(r => r.crosscut_score > CROSSCUT_THRESHOLD).length;

  console.log(chalk.dim(
    `Scope: ${systemsCount} systems · ${subsystemsCount} subsystems · ${modulesCount} modules`
  ));
  console.log(chalk.dim(
    `Clarity: ${wellDefined} well-defined · ${moderate} moderate · ${fuzzy} fuzzy · ${crossCutting} cross-cutting`
  ));

  if (levelFilter === null) {
    if (showGraph) {
      if (!opts.allItems) {
        console.log(chalk.dim(`Showing up to ${maxItems} branches per level. Use --all-items to show everything.`));
      }
      renderMapTree(regions, maxItems, Boolean(opts.allItems), Boolean(opts.verbose), sortMode);
    } else {
      if (!opts.allItems) {
        console.log(chalk.dim(`Showing the top ${maxItems} subsystems and the top ${maxItems} modules drawn from those subsystems. Use --all-items to show everything.`));
      }
      renderRankedList(regions, regionById, maxItems, Boolean(opts.allItems), Boolean(opts.verbose), sortMode);
    }
  } else {
    if (!opts.allItems) {
      console.log(chalk.dim(`Showing up to ${maxItems} items. Use --all-items to show everything.`));
    }
    renderLevelList(regions, regionById, levelFilter, maxItems, Boolean(opts.allItems), Boolean(opts.verbose), sortMode);
  }

  console.log(chalk.dim(`\nLegend: cross-cutting = spans multiple subsystems.`));
  if (!opts.verbose) {
    console.log(chalk.dim(`Run 'ix map --verbose' for confidence scores and raw metrics. Use --list for the ranked view.`));
  }
  console.log();
}

/** Render a confidence score as a compact bar: ████░░ (used in --verbose mode) */
function confidenceBar(conf: number): string {
  const filled = Math.round(conf * 6);
  const bar    = "█".repeat(filled) + "░".repeat(6 - filled);
  const color  = conf >= 0.7 ? chalk.green : conf >= 0.4 ? chalk.yellow : chalk.red;
  return color(bar);
}

/** Map a confidence score to a human-readable label. */
function confidenceLabel(conf: number): string {
  if (conf >= 0.75) return "Well-defined";
  if (conf >= 0.50) return "Moderate";
  return "Fuzzy";
}

function pickTopSystemName(regions: MapRegion[], cwd: string): string {
  const systems = regions
    .filter(r => r.label_kind === "system")
    .slice()
    .sort((a, b) => b.file_count - a.file_count || b.confidence - a.confidence);

  if (systems.length > 0 && systems[0].label.trim().length > 0) {
    return systems[0].label;
  }

  const inferred = cwd.split(/[\\/]/).filter(Boolean).pop() ?? "System";
  const compact = inferred.replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (compact.length === 0) return "System";
  const parts = compact.split(/\s+/);
  if (parts.some(p => p.toLowerCase() === "ix")) return "IX";
  if (compact.length <= 4) return compact.toUpperCase();
  return parts
    .map(part => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeSortMode(input: string | undefined): MapSortMode {
  switch ((input ?? "importance").toLowerCase()) {
    case "confidence":
      return "confidence";
    case "size":
      return "size";
    case "alpha":
      return "alpha";
    default:
      return "importance";
  }
}

function compareRegions(a: MapRegion, b: MapRegion, mode: MapSortMode): number {
  if (mode === "alpha") {
    return a.label.localeCompare(b.label) || b.file_count - a.file_count || b.confidence - a.confidence;
  }
  if (mode === "confidence") {
    return b.confidence - a.confidence || b.file_count - a.file_count || a.label.localeCompare(b.label);
  }
  return b.file_count - a.file_count || b.confidence - a.confidence || a.label.localeCompare(b.label);
}

function sortRegions(regions: MapRegion[], mode: MapSortMode): MapRegion[] {
  return [...regions].sort((a, b) => compareRegions(a, b, mode));
}

function renderMapTree(
  regions: MapRegion[],
  maxItems: number,
  allItems: boolean,
  verbose: boolean,
  sortMode: MapSortMode,
): void {
  const regionById = new Map(regions.map(region => [region.id, region]));
  const childrenByParent = new Map<string, MapRegion[]>();
  for (const region of regions) {
    if (!region.parent_id) continue;
    const existing = childrenByParent.get(region.parent_id) ?? [];
    existing.push(region);
    childrenByParent.set(region.parent_id, existing);
  }

  const roots = sortRegions(
    regions.filter(region => region.label_kind === "system" || region.parent_id === null || !regionById.has(region.parent_id)),
    sortMode,
  );
  const shownRoots = allItems ? roots : roots.slice(0, maxItems);

  console.log(`\n${chalk.bold("Architecture Graph")}`);
  console.log(chalk.dim("  System → subsystem → module"));

  for (const root of shownRoots) {
    console.log();
    renderTreeNode(root, "", true, 0, childrenByParent, maxItems, allItems, verbose, sortMode);
  }

  if (!allItems && roots.length > shownRoots.length) {
    const remaining = roots.length - shownRoots.length;
    console.log(chalk.dim(`\n  ... ${remaining} more top-level branches. Use --all-items to show all.`));
  }
}

function renderTreeNode(
  region: MapRegion,
  prefix: string,
  isLast: boolean,
  depth: number,
  childrenByParent: Map<string, MapRegion[]>,
  maxItems: number,
  allItems: boolean,
  verbose: boolean,
  sortMode: MapSortMode,
): void {
  const branch = depth === 0 ? "●" : isLast ? "└─" : "├─";
  console.log(`${prefix}${branch} ${formatRegionLine(region, verbose, depth)}`);

  const children = sortRegions(childrenByParent.get(region.id) ?? [], sortMode);
  const shownChildren = allItems ? children : children.slice(0, maxItems);
  const nextPrefix = depth === 0 ? "   " : `${prefix}${isLast ? "   " : "│  "}`;

  shownChildren.forEach((child, index) => {
    renderTreeNode(
      child,
      nextPrefix,
      index === shownChildren.length - 1,
      depth + 1,
      childrenByParent,
      maxItems,
      allItems,
      verbose,
      sortMode,
    );
  });

  if (!allItems && children.length > shownChildren.length) {
    const remaining = children.length - shownChildren.length;
    console.log(chalk.dim(`${nextPrefix}… ${remaining} more branches under ${region.label}`));
  }
}

function renderRankedList(
  regions: MapRegion[],
  regionById: Map<string, MapRegion>,
  maxItems: number,
  allItems: boolean,
  verbose: boolean,
  sortMode: MapSortMode,
): void {
  const subsystems = sortRegions(regions.filter(r => r.label_kind === "subsystem"), sortMode);
  const shownSubsystems = allItems ? subsystems : subsystems.slice(0, maxItems);
  const shownSubsystemIds = new Set(shownSubsystems.map(region => region.id));
  const candidateModules = sortRegions(
    regions.filter(r => r.label_kind === "module" && (
      shownSubsystemIds.size === 0 ||
      (r.parent_id !== null && shownSubsystemIds.has(r.parent_id))
    )),
    sortMode,
  );
  const shownModules = allItems ? candidateModules : candidateModules.slice(0, maxItems);

  if (shownSubsystems.length > 0) {
    console.log(`\n${chalk.bold("Subsystems")}`);
    printAlignedRows(shownSubsystems.map(region => ({ region, parentLabel: null })), verbose, false);
    if (!allItems && subsystems.length > shownSubsystems.length) {
      console.log(chalk.dim(`  ... ${subsystems.length - shownSubsystems.length} more subsystems. Use --all-items to show all.`));
    }
  }

  if (shownModules.length > 0) {
    console.log(`\n${chalk.bold("Modules")}`);
    printAlignedRows(
      shownModules.map(region => ({
        region,
        parentLabel: region.parent_id ? regionById.get(region.parent_id)?.label ?? "Unknown" : "Unknown",
      })),
      verbose,
      true,
    );
    if (!allItems && candidateModules.length > shownModules.length) {
      console.log(chalk.dim(`  ... ${candidateModules.length - shownModules.length} more modules from the shown subsystems. Use --all-items to show all.`));
    }
  }

  if (shownSubsystems.length === 0 && shownModules.length === 0) {
    console.log(chalk.dim("\n  No ranked subsystem or module regions found."));
  }
}

function renderLevelList(
  regions: MapRegion[],
  regionById: Map<string, MapRegion>,
  level: number,
  maxItems: number,
  allItems: boolean,
  verbose: boolean,
  sortMode: MapSortMode,
): void {
  const label = level === 3 ? "Systems" : level === 2 ? "Subsystems" : "Modules";
  const ranked = sortRegions(regions, sortMode);
  const shown = allItems ? ranked : ranked.slice(0, maxItems);

  console.log(`\n${chalk.bold(label)}`);
  printAlignedRows(
    shown.map(region => ({
      region,
      parentLabel: level === 1 && region.parent_id ? (regionById.get(region.parent_id)?.label ?? "Unknown") : null,
    })),
    verbose,
    level === 1,
  );

  if (!allItems && ranked.length > shown.length) {
    const remaining = ranked.length - shown.length;
    console.log(chalk.dim(`  ... ${remaining} more ${label.toLowerCase()}. Use --all-items to show all.`));
  }
}

function printAlignedRows(
  rows: Array<{ region: MapRegion; parentLabel: string | null }>,
  verbose: boolean,
  includeParent: boolean,
): void {
  const nameWidth = Math.max("Name".length, ...rows.map(({ region }) => region.label.length));
  const filesWidth = Math.max("Files".length, ...rows.map(({ region }) => String(region.file_count).length));
  const confidenceWidth = Math.max(
    "Confidence".length,
    ...rows.map(({ region }) => `${Math.round(region.confidence * 100)}% ${confidenceLabel(region.confidence)}`.length),
  );
  const parentWidth = includeParent
    ? Math.max("Parent".length, ...rows.map(({ parentLabel }) => (parentLabel ?? "-").length))
    : 0;
  const crossWidth = Math.max("Cross".length, ...rows.map(({ region }) => region.crosscut_score > 0.10 ? 3 : 2));

  let header = `  ${"Name".padEnd(nameWidth)}  ${"Files".padStart(filesWidth)}  ${"Confidence".padEnd(confidenceWidth)}`;
  if (includeParent) {
    header += `  ${"Parent".padEnd(parentWidth)}`;
  }
  header += `  ${"Cross".padEnd(crossWidth)}`;
  console.log(chalk.dim(header));
  console.log(chalk.dim(`  ${"─".repeat(Math.max(20, visibleWidth(header.trim())))}`));

  for (const { region, parentLabel } of rows) {
    const confidenceText = `${Math.round(region.confidence * 100)}% ${confidenceLabel(region.confidence)}`;
    const confidenceColor = region.confidence >= 0.75 ? chalk.green : region.confidence >= 0.50 ? chalk.yellow : chalk.red;
    const crossText = region.crosscut_score > 0.10 ? "yes" : "no";

    let line = `  ${chalk.bold(region.label.padEnd(nameWidth))}  ${chalk.dim(String(region.file_count).padStart(filesWidth))}  ${confidenceColor(confidenceText.padEnd(confidenceWidth))}`;
    if (includeParent) {
      line += `  ${chalk.dim((parentLabel ?? "-").padEnd(parentWidth))}`;
    }
    line += `  ${(crossText === "yes" ? chalk.yellow(crossText.padEnd(crossWidth)) : chalk.dim(crossText.padEnd(crossWidth)))}`;

    if (verbose) {
      line += chalk.dim(`  br=${Math.min(region.boundary_ratio, 999.9).toFixed(1)}  xcut=${region.crosscut_score.toFixed(2)}`);
    }

    console.log(line);
  }
}

function visibleWidth(text: string): number {
  return text.replace(/\x1B\[[0-9;]*m/g, "").length;
}

function formatRegionLine(region: MapRegion, verbose: boolean, depth = 0): string {
  const clarity = confidenceLabel(region.confidence);
  const clarityColor = region.confidence >= 0.75 ? chalk.green : region.confidence >= 0.50 ? chalk.yellow : chalk.red;
  const confPct = Math.round(region.confidence * 100);
  const crosscut = region.crosscut_score > 0.10 ? chalk.yellow(" shared") : "";
  const levelTag = region.label_kind || (region.level === 3 ? "system" : region.level === 2 ? "subsystem" : "module");
  const badge = chalk.bgBlackBright.white(` ${levelTag.toUpperCase()} `);
  const signals = region.dominant_signals.slice(0, 2).join(" · ");

  if (verbose) {
    const bar = confidenceBar(region.confidence);
    const metrics = chalk.dim(
      `conf=${confPct}%  br=${Math.min(region.boundary_ratio, 999.9).toFixed(1)}  xcut=${region.crosscut_score.toFixed(2)}`
    );
    const signalText = signals.length > 0 ? chalk.dim(`  ${signals}`) : "";
    return `${badge} ${bar}  ${chalk.bold(region.label)}  ${chalk.dim(`${region.file_count} files`)}  ${clarityColor(`${clarity} (${confPct}%)`)}  ${metrics}${signalText}${crosscut}`;
  }

  const fileText = depth === 0 ? chalk.dim(`${region.file_count} files`) : chalk.dim(`${region.file_count}`);
  const signalText = signals.length > 0 ? chalk.dim(`  ${signals}`) : "";
  return `${badge} ${chalk.bold(region.label)}  ${fileText}  ${clarityColor(`${clarity} ${confPct}%`)}${signalText}${crosscut}`;
}
