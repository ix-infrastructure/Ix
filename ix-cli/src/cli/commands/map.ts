import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { bootstrap } from "../bootstrap.js";
import { ingestFiles } from "./ingest.js";
import { parseBackendError, renderStructuredError } from "../errors.js";

interface MapRegion {
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

interface MapResult {
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

export function registerMapCommand(program: Command): void {
  program
    .command("map [path]")
    .description("Map the architectural hierarchy of a codebase")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--level <n>", "Show only regions at this level (1=finest, higher=coarser)")
    .option("--min-confidence <n>", "Only show regions above this confidence threshold (0-1)", "0")
    .option("--full", "Force full local map, bypassing automatic safety limits (advanced/testing)")
    .option("--verbose", "Show raw confidence scores, crosscut scores, boundary ratios, and signals")
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

Examples:
  ix map .
  ix map --format json
  ix map --level 2
  ix map --min-confidence 0.5
  ix map . --full
  ix --debug map . --full`
    )
    .action(async (pathArg: string | undefined, opts: { format: string; level?: string; minConfidence: string; full?: boolean; verbose?: boolean }) => {
      const cwd = pathArg ? resolve(pathArg) : process.cwd();

      try {
        await bootstrap(cwd);
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      // Print warning when --full override is active
      if (opts.full && opts.format !== "json") {
        console.log(chalk.yellow("\nWarning"));
        console.log(chalk.yellow("  Full local map override enabled.\n"));
        console.log("  Ix will ignore automatic local safety limits and attempt full local mapping.");
        console.log("  This may take a long time or fail on very large systems.\n");
      }

      // Ingest the path before mapping so the graph is up to date
      await ingestFiles(cwd, { recursive: true, format: opts.format === "json" ? "json" : "text", printSummary: false });

      const client = new IxClient(getEndpoint());

      if (opts.format !== "json") {
        process.stderr.write(chalk.dim("  Computing map...\n"));
      }

      let result: MapResult;
      try {
        result = await client.map({ full: opts.full }) as MapResult;
      } catch (err: any) {
        const msg: string = err.message ?? "";
        const structured = parseBackendError(msg);
        if (structured) {
          renderStructuredError(structured);
        } else {
          console.error(chalk.red("Error:"), msg);
        }
        process.exitCode = 1;
        return;
      }

      const minConf = parseFloat(opts.minConfidence ?? "0");
      const levelFilter = opts.level ? parseInt(opts.level, 10) : null;

      let regions = result.regions;
      if (levelFilter !== null) regions = regions.filter(r => r.level === levelFilter);
      if (minConf > 0) regions = regions.filter(r => r.confidence >= minConf);

      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, regions }, null, 2));
        return;
      }

      // Text output
      console.log(
        `\n${chalk.bold("Architectural Map")} — ` +
        `${result.file_count} files · ${result.region_count} regions`
      );

      if (result.outcome === "fast_local_completed") {
        console.log(chalk.yellow("  Large system detected") + chalk.dim(" — using Fast Map"));
        console.log(chalk.dim("  Reduced coupling model with full region hierarchy output."));
      }

      if (regions.length === 0) {
        console.log(chalk.dim("\n  No regions found matching filters."));
        return;
      }

      // Build id→region lookup for parent label resolution
      const regionById = new Map(result.regions.map(r => [r.id, r]));

      const KIND_ORDER   = ["system", "subsystem", "module"];
      const KIND_HEADERS: Record<string, string> = {
        system:    "Systems",
        subsystem: "Subsystems",
        module:    "Modules",
      };
      const CROSSCUT_THRESHOLD = 0.10;
      const RULE = chalk.dim("─".repeat(58));

      // Group by label_kind
      const byKind = new Map<string, MapRegion[]>();
      for (const r of regions) {
        if (!byKind.has(r.label_kind)) byKind.set(r.label_kind, []);
        byKind.get(r.label_kind)!.push(r);
      }

      for (const kind of KIND_ORDER) {
        const kindRegions = byKind.get(kind);
        if (!kindRegions) continue;

        // Sort: systems/subsystems by file_count desc; modules: problematic first, then parent+size
        if (kind !== "module") {
          kindRegions.sort((a, b) => b.file_count - a.file_count);
        } else {
          const isProblematic = (r: MapRegion) =>
            r.crosscut_score > CROSSCUT_THRESHOLD || r.confidence < 0.50;
          kindRegions.sort((a, b) => {
            const ap = isProblematic(a) ? 1 : 0;
            const bp = isProblematic(b) ? 1 : 0;
            if (bp !== ap) return bp - ap;
            const aParent = a.parent_id ? (regionById.get(a.parent_id)?.label ?? "") : "";
            const bParent = b.parent_id ? (regionById.get(b.parent_id)?.label ?? "") : "";
            if (aParent !== bParent) return aParent.localeCompare(bParent);
            return b.file_count - a.file_count;
          });
        }

        const colHeader = kind === "module"
          ? chalk.dim(`  ${"Name".padEnd(22)}  ${"Files".padStart(8)}   ${"Clarity".padEnd(13)}  System`)
          : chalk.dim(`  ${"Name".padEnd(22)}  ${"Files".padStart(8)}   Clarity`);

        console.log(`\n${chalk.bold(KIND_HEADERS[kind] ?? kind)}`);
        console.log(colHeader);
        console.log(RULE);

        if (opts.verbose) {
          for (const r of kindRegions) {
            const bar         = confidenceBar(r.confidence);
            const name        = chalk.bold(r.label.padEnd(22));
            const files       = chalk.dim(`${r.file_count} files`.padStart(8));
            const confPct     = chalk.cyan(`${Math.round(r.confidence * 100)}%`.padStart(4));
            const xcut        = chalk.dim(`xcut=${r.crosscut_score.toFixed(2)}`);
            const br          = chalk.dim(`br=${Math.min(r.boundary_ratio, 999.9).toFixed(1)}`);
            const signals     = chalk.dim(r.dominant_signals.slice(0, 3).join("+") || "—");
            const parentLabel = r.parent_id ? regionById.get(r.parent_id)?.label : null;
            const parentStr   = (kind === "module" && parentLabel) ? chalk.dim(` (${parentLabel})`) : "";
            const crossStr    = r.crosscut_score > CROSSCUT_THRESHOLD ? chalk.yellow("  ⚠ cross-cutting") : "";
            console.log(`  ${bar}  ${name}  ${files}   ${confPct}   ${xcut}   ${br}   ${signals}${parentStr}${crossStr}`);
          }
        } else {
          for (const r of kindRegions) {
            const label       = confidenceLabel(r.confidence);
            const labelColor  = r.confidence >= 0.75 ? chalk.green : r.confidence >= 0.50 ? chalk.yellow : chalk.red;
            const name        = chalk.bold(r.label.padEnd(22));
            const files       = chalk.dim(`${r.file_count} files`.padStart(8));
            const parentLabel = r.parent_id ? regionById.get(r.parent_id)?.label : null;
            const parentStr   = (kind === "module" && parentLabel) ? chalk.dim(`  (${parentLabel})`) : "";
            const crossStr    = r.crosscut_score > CROSSCUT_THRESHOLD ? chalk.yellow("  ⚠ cross-cutting") : "";
            console.log(`  ${name}  ${files}   ${labelColor(label.padEnd(13))}${parentStr}${crossStr}`);
          }
        }
      }

      console.log(chalk.dim(`\nLegend: cross-cutting = spans multiple subsystems.`));
      if (!opts.verbose) {
        console.log(chalk.dim(`Run 'ix map --verbose' for confidence scores and raw metrics.`));
      }
      console.log();
    });
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
