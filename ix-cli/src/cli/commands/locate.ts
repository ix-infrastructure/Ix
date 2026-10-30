// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import {
  resolveFileOrEntityFull, rankEntity, withContainers, printResolved, printAmbiguous,
  looksFileLike, isRawId, qualifiedSeparator, isFuzzyResult, withMissReason, withTargetCandidates,
  type ResolvedEntity, type ResolveResult, type Suggestion,
} from "../resolve.js";
import { EXIT_CODES_HELP, setOutcome } from "../outcome.js";
import type { TargetCandidate } from "../target-suggestions.js";
import { runPerTarget } from "../multi-target.js";
import { isFileStale } from "../stale.js";
import { stderr } from "../stderr.js";
import { relativePath, printJson } from "../format.js";
import { llmLine, llmError, llmShortId } from "../llm.js";
import { parsePickOption } from "../options.js";
import { getEffectiveSystemPath, hasMapData } from "../hierarchy.js";
import { humanizeLabel } from "../impact/risk-semantics.js";
import { renderSection, renderKeyValue, renderNote, renderWarning, renderBreadcrumb, reportAmbiguousTarget, reportResolutionNotices } from "../ui.js";
import { forMcp } from "../next-step.js";
import { ensureFreshMapState, mapStaleJson, mapStaleLlm, type MapStaleState } from "../map-freshness.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);
const FILE_KINDS = new Set(["file"]);

// Region kinds whose names should be humanized in system path
const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);

interface LocateOutput {
  resolvedTarget: { id: string; kind: string; name: string; path?: string } | null;
  resolutionMode: string;
  lineRange?: { start: number; end: number };
  container?: { kind: string; name: string; id?: string };
  systemPath: Array<{ name: string; kind: string }> | null;
  hasMapData?: boolean;
  stale?: boolean;
  /** The map is deferred (CL-13): the system path is the last map's. */
  map_stale?: true;
  regions_as_of?: { map_rev: number; file_count: number };
  diagnostics: string[];
  /** A miss: the `unresolved_target` record fields every graph command's miss carries. */
  error?: "unresolved_target";
  message?: string;
  reason?: string;
  files?: string[];
  suggestions?: Suggestion[];
  didYouMean?: TargetCandidate[];
}

export function registerLocateCommand(program: Command): void {
  program
    .command("locate <symbols...>")
    .description("Resolve symbols to their position in the codebase and system hierarchy")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to results from files matching this path substring")
    .option("--no-suggest", "Disable did-you-mean candidates on unresolved targets")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `\nExamples:
  ix locate IngestionService
  ix locate verify_token --kind function
  ix locate ArangoClient --format json
  ix locate scoreCandidate --pick 2
  ix locate parseConfig loadConfig writeConfig --format llm

Several symbols answer in one call, grouped per symbol (json: {targets: [...]}).
${EXIT_CODES_HELP}`)
    .action(async (symbols: string[], opts: { kind?: string; path?: string; pick?: number; suggest?: boolean; format: string }) => {
      const client = createClient();
      // An `ix map` after an edit may have left the map for the system paths
      // read below (CL-13). Checked once per call, on the first target that
      // resolves, so several targets print at most one stale-map notice --
      // and, in llm, one `diagnostic code=map_stale` record. In json each
      // answered target carries `map_stale`.
      let mapChecked: Promise<MapStaleState> | undefined;
      const freshMap = (): Promise<MapStaleState> => (mapChecked ??= ensureFreshMapState());
      let staleSaid = false;
      const staleLlmOnce = (state: MapStaleState): string[] => {
        if (staleSaid) return [];
        const lines = mapStaleLlm(state);
        staleSaid = lines.length > 0;
        return lines;
      };
      await runPerTarget(symbols, opts.format, (symbol) => locateOne(client, symbol, opts, freshMap, staleLlmOnce));
    });
}

async function locateOne(
  client: IxClient,
  symbol: string,
  opts: { kind?: string; path?: string; pick?: number; suggest?: boolean; format: string },
  freshMap: () => Promise<MapStaleState>,
  staleLlmOnce: (state: MapStaleState) => string[],
): Promise<void> {
  const diagnostics: string[] = [];

  const resolveOpts = { suggest: opts.suggest, suggestCommand: "locate", missStarted: performance.now(), kind: opts.kind, path: opts.path, pick: opts.pick };

  // Resolution with ambiguity detection
  const { target, ambiguous, miss } = await resolveWithAmbiguity(client, symbol, resolveOpts, opts.format);

  if (!target) {
    if (ambiguous) {
      // Printed above, in whichever format was asked for. Exits 2, like
      // every other ambiguous graph target (outcome.ts): the candidates
      // are the answer, and `--pick <n>` is the retry.
      //
      // #547 settled that locate and the other graph commands report this
      // condition with one status; `ix overview Duplicate` and
      // `ix locate Duplicate` must agree. A `--pick <n>` that is out of
      // range lands here too, with its candidates.
      setOutcome("ambiguous");
      return;
    }
    // The body keeps its shape (shipped plugins read `diagnostics` from
    // it) and gains the `error` slug, reason and suggestions every other
    // command's miss carries, so one parser reads them all.
    const reason = miss ? await withMissReason(client, symbol, miss, resolveOpts, opts.format) : undefined;
    const guidance = reason ? await withTargetCandidates(client, symbol, reason, resolveOpts) : undefined;
    const output: LocateOutput = {
      resolvedTarget: null,
      resolutionMode: "none",
      systemPath: null,
      diagnostics: ["No graph entity found."],
      error: "unresolved_target",
      message: reason?.message ?? `No graph entity found for "${symbol}".`,
      ...(reason?.reason ? { reason: reason.reason } : {}),
      ...(reason?.files?.length ? { files: reason.files } : {}),
      ...(guidance?.suggestions?.length ? { suggestions: guidance.suggestions } : {}),
      didYouMean: guidance?.didYouMean ?? [],
    };
    outputLocate(output, symbol, opts.format, guidance?.retryCommand);
    // #539: a machine caller could not tell this from a successful command
    // that intentionally returned nothing. Exits 3, the not-found code
    // `context`, `explain`, `read` and `trace` share.
    setOutcome("not_found");
    return;
  }

  if (opts.format === "text") printResolved(target);

  const isContainer = CONTAINER_KINDS.has(target.kind);
  const isFile = FILE_KINDS.has(target.kind);

  // Never throws and never moves the exit code.
  const mapState = await freshMap();

  // Parallel fetch: effective system path, parent container (for non-containers), entity details
  const [systemPath, containsResult, details] = await Promise.all([
    getEffectiveSystemPath(client, target.id),
    isContainer
      ? Promise.resolve({ nodes: [] })
      : client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
    client.entity(target.id),
  ]);

  const node = details.node as any;
  const nodePath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? undefined;

  // Extract line range from attrs
  const lineStart = node.attrs?.line_start ?? node.attrs?.lineStart;
  const lineEnd = node.attrs?.line_end ?? node.attrs?.lineEnd;
  const lineRange = lineStart != null && lineEnd != null
    ? { start: Number(lineStart), end: Number(lineEnd) }
    : undefined;

  // Check staleness
  let stale = false;
  if (nodePath) {
    try { stale = isFileStale(nodePath); } catch {}
  }

  // Container context (parent for callables)
  let container: LocateOutput["container"];
  if (!isContainer && containsResult.nodes.length > 0) {
    const c = containsResult.nodes[0] as any;
    container = {
      kind: c.kind || "unknown",
      name: c.name || c.attrs?.name || "(unknown)",
      id: c.id,
    };
  }

  // Sub-file entities (table, view, function, etc.) have no IN_REGION edges of their
  // own — those belong to the containing file. Walk up via CONTAINS to inherit the
  // parent file's system path so hasMapData returns true after `ix map`.
  // Diagnostic for missing map data
  const hasMap = hasMapData(systemPath);
  if (!hasMap) {
    diagnostics.push(`No system map. Run ${forMcp() ? "ix_map" : "`ix map`"} to see hierarchy.`);
  }

  // Build system path: append resolved symbol for non-file targets
  let systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));
  if (!isFile) {
    const lastInPath = systemPathMapped[systemPathMapped.length - 1];
    if (!lastInPath || lastInPath.name !== target.name) {
      systemPathMapped = [...systemPathMapped, { name: target.name, kind: target.kind }];
    }
  }

  // Make path repo-relative
  const displayPath = nodePath ? toRepoRelative(nodePath) : undefined;

  const output: LocateOutput = {
    resolvedTarget: {
      id: target.id,
      kind: target.kind,
      name: target.name,
      path: displayPath,
    },
    resolutionMode: target.resolutionMode === "exact" ? undefined as any : target.resolutionMode,
    lineRange,
    container,
    systemPath: systemPathMapped,
    hasMapData: hasMap,
    diagnostics: diagnostics.length > 0 ? diagnostics : [] as string[],
  };
  if (stale) {
    output.stale = true;
  }
  // Only json reads these. llm has its own record, once per call, with the
  // answer and not before it (mapStaleLlm).
  if (opts.format === "json") Object.assign(output, mapStaleJson(mapState));
  if (opts.format === "llm") for (const line of staleLlmOnce(mapState)) console.log(line);

  outputLocate(output, symbol, opts.format);
}

// ── Ambiguity-aware resolution ──────────────────────────────────────────────

type Miss = Extract<ResolveResult, { resolved: false; ambiguous: false }>;

async function resolveWithAmbiguity(
  client: IxClient,
  symbol: string,
  opts: { kind?: string; path?: string; pick?: number },
  format: string,
): Promise<{ target: ResolvedEntity | null; ambiguous: boolean; miss?: Miss }> {
  let result: ResolveResult;
  // For raw IDs and file-like targets, delegate to resolveFileOrEntityFull. A
  // file target can tie, but it resolves (with a notice) rather than turn
  // ambiguous.
  if (isRawId(symbol) || looksFileLike(symbol)) {
    result = await resolveFileOrEntityFull(client, symbol, { ...opts, format });
  } else {
    // Symbol resolution — use full result to detect ambiguity
    const allKinds = ["file", "class", "object", "trait", "interface", "module", "function", "method", "constant"];
    const sep = qualifiedSeparator(symbol);
    result = await rankEntity(client, symbol, allKinds, { ...opts, format, ...(sep ? { silentMiss: true } : {}) });
    // `Class::method`, `Class.method` and `Class#method` are read as a qualified
    // name only when the name as typed matches nothing, or (for `.`/`#`) matches
    // only fuzzily; resolveFileOrEntityFull then keeps the literal result unless
    // the qualified one keeps the exit code. Containers are asked for only on
    // the result kept, so a re-resolved name does not pay for them twice.
    const missed = !result.resolved && !result.ambiguous;
    if (sep && (missed || (sep !== "::" && isFuzzyResult(result)))) {
      result = await resolveFileOrEntityFull(client, symbol, { ...opts, format });
    } else {
      result = await withContainers(client, result);
    }
  }

  if (result.resolved) {
    if (result.notices?.length) reportResolutionNotices(result.notices, format, opts);
    return { target: result.entity, ambiguous: false };
  }

  if (result.ambiguous) {
    if (format === "json") {
      printJson({
        // Locate's ambiguity was never an `error` record, and integrations that
        // treat any string `error` as a failure would drop the candidates: the
        // shared slug rides in `code` instead (the exit code is 2, outcome.ts).
        code: "ambiguous_target",
        message: `Ambiguous symbol "${symbol}".`,
        resolvedTarget: null,
        resolutionMode: "ambiguous",
        candidates: result.result.candidates,
        ...(result.result.total != null ? { total: result.result.total } : {}),
        ...(result.result.truncated ? { truncated: true } : {}),
        systemPath: null,
        diagnostics: result.result.diagnostics ?? [],
      });
    } else if (format === "llm") {
      // The shared renderer: one record per candidate with kind, path and a
      // short id. This used to emit `candidates=1:config.ts,2:config.ts` --
      // nothing to choose between.
      reportAmbiguousTarget(symbol, result.result, "llm", opts);
    } else {
      printAmbiguous(symbol, result.result, opts);
    }
    return { target: null, ambiguous: true };
  }

  return { target: null, ambiguous: false, miss: result };
}

// ── Repo-relative path ──────────────────────────────────────────────────────

function toRepoRelative(filePath: string): string {
  return relativePath(filePath) ?? filePath;
}

// ── Humanized system path breadcrumb ────────────────────────────────────────

function humanizeBreadcrumb(nodes: Array<{ name: string; kind: string }>): string {
  const humanized = nodes.map((n) => {
    if (REGION_KINDS.has(n.kind)) return humanizeLabel(n.name).replace(/ layer$/, "");
    return n.name;
  });
  return renderBreadcrumb(humanized.map((name) => ({ name })));
}

// ── Output ──────────────────────────────────────────────────────────────────

/** Render `ix locate` output as llm records: a `locate` header (or structured error) plus `note` lines. */
export function renderLocateLlm(output: LocateOutput, symbol: string, retryCommand?: string): string[] {
  const t = output.resolvedTarget;
  if (!t) {
    const near = output.suggestions ?? [];
    return [
      llmError("unresolved_target", output.message ?? `No graph entity found for "${symbol}".`,
        [["reason", output.reason], ["files", output.files?.join(",")]]),
      ...near.map((c, i) => llmLine("suggestion", [
        ["n", i + 1], ["name", c.name], ["kind", c.kind],
        ["path", c.path ? relativePath(c.path) ?? c.path : undefined], ["id", llmShortId(c.id)],
      ])),
      ...(near.length ? [llmLine("hint", [["text", retryCommand ?? "Re-run with one of these names, or narrow with --path."]])] : []),
    ];
  }
  const lines = [llmLine("locate", [
    ["target", t.name],
    ["kind", t.kind],
    ["id", llmShortId(t.id)],
    ["path", t.path],
    ["line_start", output.lineRange?.start],
    ["line_end", output.lineRange?.end],
    ["contained_in", output.container ? `${output.container.kind} ${output.container.name}` : undefined],
    ["system_path", output.hasMapData && output.systemPath && output.systemPath.length > 0 ? output.systemPath.map((n) => n.name).join(",") : undefined],
    ["stale", output.stale ? true : undefined],
    ["mode", output.resolutionMode],
  ])];
  for (const d of output.diagnostics ?? []) lines.push(llmLine("note", [["text", d]]));
  return lines;
}

function outputLocate(output: LocateOutput, symbol: string, format: string, retryCommand?: string): void {
  if (format === "json") {
    printJson(output);
    return;
  }
  if (format === "llm") {
    for (const line of renderLocateLlm(output, symbol, retryCommand)) console.log(line);
    return;
  }

  if (output.stale) renderWarning("Some results may be stale. Run ix map to update.");

  if (!output.resolvedTarget) {
    stderr(`No graph entity found for "${symbol}".`);
    const near = output.didYouMean?.length ? output.didYouMean : output.suggestions;
    if (near?.length) {
      stderr(chalk.dim("Did you mean:"));
      for (const c of near) {
        stderr(`  ${chalk.cyan((c.kind || "").padEnd(10))} ${c.name}${c.path ? chalk.dim(` in ${c.path}`) : ""}`);
      }
      if (retryCommand) stderr(`Try: ${retryCommand}`);
    }
    console.log("No matches found.");
    return;
  }

  const t = output.resolvedTarget;

  // Location section
  const hasLocation = t.path || output.lineRange || output.container;
  if (hasLocation) {
    renderSection("Location");
    if (t.path) {
      renderKeyValue("File", t.path);
    }
    if (output.lineRange) {
      renderKeyValue("Lines", `${output.lineRange.start}-${output.lineRange.end}`);
    }
    if (output.container) {
      renderKeyValue("Contained in", output.container.name);
    }
  }

  // System path section
  if (output.systemPath && output.systemPath.length > 1 && output.hasMapData) {
    renderSection("System path");
    console.log(`  ${humanizeBreadcrumb(output.systemPath)}`);
  }

  // Diagnostics
  for (const d of output.diagnostics) {
    renderNote(d);
  }
}
