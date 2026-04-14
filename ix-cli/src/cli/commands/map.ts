import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { roundFloat } from "../format.js";
import { bootstrap } from "../bootstrap.js";
import { formatFetchError } from "../errors.js";
import { ingestFiles } from "./ingest.js";
import { getRemoteRunner } from "../remote.js";

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
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--level <n>", "Show only regions at this level (1=finest, higher=coarser)")
    .option("--min-confidence <n>", "Only show regions above this confidence threshold (0-1)", "0")
    .option("--max-items <n>", "Max items to show per section in text output (default: 10)", "10")
    .option("--all-items", "Show all items in each section (overrides --max-items)")
    .option("--sort <mode>", "Sort mode for text output (importance|confidence|size|alpha)", "importance")
    .option("--graph", "Render the hierarchy as a graph/tree view (default)")
    .option("--list", "Render the ranked list view instead of the default graph/tree view")
    .option("--full", "Force full local map, bypassing automatic safety limits (advanced/testing)")
    .option("--remote", "Route ingestion through the cloud pipeline instead of parsing locally (requires Ix Pro)")
    .option("--verbose", "Show raw confidence scores, crosscut scores, boundary ratios, and signals")
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
  ix --debug map . --full`
    )
    .action(async (pathArg: string | undefined, opts: { format: string; level?: string; minConfidence: string; maxItems: string; allItems?: boolean; sort: string; graph?: boolean; list?: boolean; full?: boolean; remote?: boolean; verbose?: boolean; silent?: boolean }) => {
      const cwd = pathArg ? resolve(pathArg) : process.cwd();

      try {
        await bootstrap(cwd);
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      const silent = opts.silent === true || opts.format === "silent";

      // Print warning when --full override is active
      if (opts.full && opts.format !== "json" && !silent) {
        console.log(chalk.yellow("\nWarning"));
        console.log(chalk.yellow("  Full local map override enabled.\n"));
        console.log("  Ix will ignore automatic local safety limits and attempt full local mapping.");
        console.log("  This may take a long time or fail on very large systems.\n");
      }

      // Ingest the path before mapping so the graph is up to date.
      // --remote routes through the cloud pipeline via a Pro-supplied
      // RemoteRunner; absence means Pro isn't installed.
      const ingestStart = performance.now();
      if (opts.remote) {
        const runner = getRemoteRunner();
        if (!runner) {
          console.error(
            chalk.red("Error:"),
            "--remote requires Ix Pro. Install @ix/pro to enable remote ingestion."
          );
          process.exitCode = 1;
          return;
        }
        try {
          await runner.runIngestion({
            cwd,
            silent,
            format: (opts.format === "json" || silent) ? "json" : "text",
          });
        } catch (err: any) {
          console.error(chalk.red("Error:"), formatFetchError(err));
          process.exitCode = 1;
          return;
        }
      } else {
        try {
          await ingestFiles(cwd, {
            recursive: true,
            format: (opts.format === "json" || silent) ? "json" : "text",
            printSummary: false,
            suppressOutput: true,
            mapMode: true,
          });
        } catch (err: any) {
          console.error(chalk.red("Error:"), formatFetchError(err));
          process.exitCode = 1;
          return;
        }
      }
      const ingestMs = Math.round(performance.now() - ingestStart);

      const client = new IxClient(getEndpoint());

      const mapBarWidth = 25;
      const mapStart    = performance.now();
      const mapInterval = (opts.format !== "json" && !silent) ? setInterval(() => {
        const elapsed  = performance.now() - mapStart;
        const pct      = 1 - Math.exp(-elapsed / 4000);
        const filled   = Math.round(pct * mapBarWidth);
        const bar      = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(mapBarWidth - filled));
        const pctStr   = chalk.cyan(`${Math.min(Math.round(pct * 100), 99)}%`.padStart(4));
        process.stderr.write(`\r  Computing map...  ${bar}  ${pctStr}`);
      }, 80) : null;

      let result: MapResult;
      try {
        result = await client.map({ full: opts.full }) as MapResult;
      } catch (err: any) {
        if (mapInterval) { clearInterval(mapInterval); process.stderr.write('\r' + ' '.repeat(60) + '\r'); }
        console.error(chalk.red("Error:"), formatFetchError(err));
        process.exitCode = 1;
        return;
      }
      if (mapInterval) { clearInterval(mapInterval); process.stderr.write('\r' + ' '.repeat(60) + '\r'); }
      const mapMs = Math.round(performance.now() - mapStart);

      if (silent) {
        const systems    = result.regions.filter(r => r.label_kind === "system").length;
        const subsystems = result.regions.filter(r => r.label_kind === "subsystem").length;
        const modules    = result.regions.filter(r => r.label_kind === "module").length;
        process.stderr.write(
          `map: ${result.file_count} files · ${systems}s/${subsystems}ss/${modules}m regions · ${mapMs}ms\n`
        );
        return;
      }

      if (opts.format !== "json") {
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
      renderMapText(result, cwd, opts);
    });
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
