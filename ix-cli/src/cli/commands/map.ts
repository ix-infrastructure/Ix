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

Examples:
  ix map .
  ix map --format json
  ix map --level 2
  ix map --min-confidence 0.5`
    )
    .action(async (pathArg: string | undefined, opts: { format: string; level?: string; minConfidence: string }) => {
      const cwd = pathArg ? resolve(pathArg) : process.cwd();

      try {
        await bootstrap(cwd);
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      // Ingest the path before mapping so the graph is up to date
      if (opts.format !== "json") {
        process.stderr.write(chalk.dim("Ingesting...\n"));
      }
      await ingestFiles(cwd, { recursive: true, format: "text" });

      const client = new IxClient(getEndpoint());

      if (opts.format !== "json") {
        process.stderr.write(chalk.dim("Computing architectural map...\n"));
      }

      let result: MapResult;
      try {
        result = await client.map() as MapResult;
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
        `\n${chalk.bold("Architectural Map")}  ` +
        chalk.dim(`rev ${result.map_rev} · ${result.file_count} files · `) +
        chalk.dim(`${result.region_count} regions · ${result.levels} levels`)
      );

      if (result.outcome === "fast_local_completed") {
        console.log(
          chalk.yellow("  Large system detected") +
          chalk.dim(" — using Fast Map")
        );
        console.log(chalk.dim("  Reduced coupling model with full region hierarchy output."));
      }

      if (regions.length === 0) {
        console.log(chalk.dim("\n  No regions found matching filters."));
        return;
      }

      // Group by level, finest last for display (coarsest first = system overview at top)
      const byLevel = new Map<number, MapRegion[]>();
      for (const r of regions) {
        if (!byLevel.has(r.level)) byLevel.set(r.level, []);
        byLevel.get(r.level)!.push(r);
      }

      const sortedLevels = [...byLevel.keys()].sort((a, b) => b - a);  // coarsest first

      for (const lvl of sortedLevels) {
        const lvlRegions = byLevel.get(lvl)!.sort((a, b) => b.confidence - a.confidence);
        const kindLabel = lvlRegions[0]?.label_kind ?? "region";
        console.log(`\n${chalk.bold(kindLabel.toUpperCase())} (level ${lvl})`);

        for (const r of lvlRegions) {
          const confBar = confidenceBar(r.confidence);
          const signals = r.dominant_signals.slice(0, 2).join("+");
          const name    = chalk.bold(r.label.padEnd(20));
          const files   = chalk.dim(`${r.file_count}f`).padEnd(6);
          const brVal   = Math.min(r.boundary_ratio, 9999);
          const br      = brVal > 0
            ? chalk.dim(`br=${brVal.toFixed(1)}`)
            : chalk.dim("br=0.0");

          console.log(
            `  ${name} ${files} ${confBar} ${br}  ${chalk.dim(signals)}`
          );
        }
      }

      console.log(
        chalk.dim(`\nRegion nodes persisted to graph. Use 'ix entity <id>' to inspect a region.`)
      );
    });
}

/** Render a confidence score as a compact bar: ████░░ */
function confidenceBar(conf: number): string {
  const filled = Math.round(conf * 6);
  const bar    = "█".repeat(filled) + "░".repeat(6 - filled);
  const color  = conf >= 0.7 ? chalk.green : conf >= 0.4 ? chalk.yellow : chalk.red;
  return color(bar);
}
