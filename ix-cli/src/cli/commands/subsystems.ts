import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { roundFloat } from "../format.js";
import { renderMapText, type MapResult } from "./map.js";
import {
  renderSubsystemExplanationJson,
  renderSubsystemExplanationText,
  type ScopedSubsystemRegion,
  type ScopedSubsystemResult,
  type SubsystemScore,
} from "../explain/subsystem.js";

interface AmbiguousSubsystemResult {
  error: "ambiguous_target";
  target_query: string;
  candidates: Array<{
    pick: number;
    id: string;
    label: string;
    level: number;
    label_kind: string;
    file_count: number;
    parent?: string | null;
  }>;
}

interface UnknownSubsystemTargetResult {
  error: "unknown_target";
  target_query: string;
  message: string;
  suggestions?: string[];
}

export function registerSubsystemsCommand(program: Command): void {
  program
    .command("subsystems [target]")
    .description("Show the persisted architectural map saved by 'ix map'")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--list",         "List stored subsystem health scores instead of the persisted architecture map")
    .option("--target <target>", "Scope subsystem output to a persisted architecture region")
    .option("--pick <n>", "Resolve an ambiguous region target by numbered candidate")
    .option("--level <n>",    "Filter to level (1=module, 2=subsystem, 3=system)")
    .option("--min-confidence <n>", "Only show regions above this confidence threshold (0-1)", "0")
    .option("--max-items <n>", "Max items to show per section in text output (default: 10)", "10")
    .option("--all-items", "Show all items in each section (overrides --max-items)")
    .option("--sort <mode>", "Sort mode for text output (importance|confidence|size|alpha)", "importance")
    .option("--graph", "Render the hierarchy as a graph/tree view instead of the default ranked list")
    .option("--verbose", "Show raw confidence scores, crosscut scores, boundary ratios, and signals")
    .option("--explain", "Explain a scoped subsystem region in plain English")
    .addHelpText("after", `
Reads the persisted architectural map saved by 'ix map' from the graph and
renders it with the same output formatter as 'ix map', without rerunning map
ingestion or clustering.

Examples:
  ix subsystems
  ix subsystems --list
  ix subsystems api
  ix subsystems --target "Cli / Client"
  ix subsystems api --pick 2
  ix subsystems api --explain
  ix subsystems --level 2
  ix subsystems --graph
  ix subsystems --format json`)
    .action(async (positionalTarget: string | undefined, opts: { format: string; list?: boolean; target?: string; pick?: string; level?: string; minConfidence: string; maxItems: string; allItems?: boolean; sort: string; graph?: boolean; verbose?: boolean; explain?: boolean }) => {
      const client = new IxClient(getEndpoint());
      const target = resolveSubsystemTarget(positionalTarget, opts.target);
      const pick = parsePickOption(opts.pick);

      if (!target.error && pick.error) {
        console.error(chalk.red("Error:"), pick.error);
        process.exitCode = 1;
        return;
      }
      if (target.error) {
        console.error(chalk.red("Error:"), target.error);
        process.exitCode = 1;
        return;
      }
      if (opts.list && target.value) {
        console.error(chalk.red("Error:"), "Scoped targets are not supported with --list.");
        process.exitCode = 1;
        return;
      }
      if (opts.list && opts.explain) {
        console.error(chalk.red("Error:"), "--explain cannot be used with --list.");
        process.exitCode = 1;
        return;
      }
      if (!target.value && pick.value !== undefined) {
        console.error(chalk.red("Error:"), "--pick requires a target.");
        process.exitCode = 1;
        return;
      }
      if (opts.explain && !target.value) {
        console.error(chalk.red("Error:"), "--explain requires a target.");
        process.exitCode = 1;
        return;
      }

      if (opts.list) {
        let result: any;
        try {
          result = await client.listSubsystems();
        } catch (err: any) {
          console.error(chalk.red("Error:"), err.message);
          process.exitCode = 1;
          return;
        }
        const scores: SubsystemScore[] = result.scores ?? [];
        const filtered = opts.level
          ? scores.filter(s => s.level === parseInt(opts.level!, 10))
          : scores;

        if (opts.format === "json") {
          const compact = filtered.map(s => ({
            name: s.name,
            level: s.level,
            health: roundFloat(s.health_score),
            files: s.file_count,
            chunks_per_file: roundFloat(s.chunk_density),
            smell_files: s.smell_files,
          }));
          console.log(JSON.stringify({ scores: compact }, null, 2));
          return;
        }
        printScores(filtered);
        return;
      }

      let result: MapResult | ScopedSubsystemResult;
      try {
        result = await client.getSubsystemMap({
          target: target.value,
          pick: pick.value,
        }) as MapResult;
      } catch (err: any) {
        const body = parseErrorBody(err);
        if (body) {
          if (opts.format === "json") {
            console.log(JSON.stringify(body, null, 2));
            process.exitCode = 1;
            return;
          }
          renderSubsystemError(body, Boolean(opts.explain));
          process.exitCode = 1;
          return;
        }
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      if (opts.explain) {
        if (!isScopedSubsystemResult(result)) {
          console.error(chalk.red("Error:"), "--explain requires a scoped subsystem target.");
          process.exitCode = 1;
          return;
        }

        let scoreResult: { scores?: SubsystemScore[] };
        try {
          scoreResult = await client.listSubsystems();
        } catch (err: any) {
          console.error(chalk.red("Error:"), err.message);
          process.exitCode = 1;
          return;
        }

        const score = (scoreResult.scores ?? []).find((candidate) => candidate.region_id === result.target.id) ?? null;
        if (opts.format === "json") {
          console.log(JSON.stringify(renderSubsystemExplanationJson(result, score), null, 2));
          return;
        }

        console.log(renderSubsystemExplanationText(result, score));
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(compactMapResult(result), null, 2));
        return;
      }

      if (isScopedSubsystemResult(result)) {
        renderScopedSubsystemText(result, Boolean(opts.verbose));
        return;
      }

      renderMapText(result, process.cwd(), {
        level: opts.level,
        minConfidence: opts.minConfidence,
        maxItems: opts.maxItems,
        allItems: opts.allItems,
        sort: opts.sort,
        graph: opts.graph,
        verbose: opts.verbose,
      });
    });
}

function printScores(scores: SubsystemScore[]): void {
  if (scores.length === 0) {
    console.log(chalk.dim("No subsystem scores found. Run 'ix map' then 'ix subsystems'."));
    return;
  }

  // Group by level
  const byLevel = new Map<number, SubsystemScore[]>();
  for (const s of scores) {
    if (!byLevel.has(s.level)) byLevel.set(s.level, []);
    byLevel.get(s.level)!.push(s);
  }

  const levelLabels: Record<number, string> = { 1: "Modules", 2: "Subsystems", 3: "Systems" };
  const sorted = [...byLevel.entries()].sort((a, b) => b[0] - a[0]);

  for (const [level, group] of sorted) {
    const label = levelLabels[level] ?? `Level ${level}`;
    console.log(`\n${chalk.bold(label)}`);

    const ranked = [...group].sort((a, b) => b.health_score - a.health_score);
    for (const s of ranked) {
      const bar     = healthBar(s.health_score);
      const name    = s.name.length > 32 ? s.name.slice(0, 31) + "…" : s.name.padEnd(32);
      const files   = chalk.dim(`${s.file_count}f`);
      const chunks  = chalk.dim(`${s.chunk_density.toFixed(1)}c/f`);
      const smells  = s.smell_files > 0
        ? chalk.yellow(`${s.smell_files}⚠`)
        : chalk.green("✓");
      console.log(`  ${bar} ${chalk.bold(name)}  ${files}  ${chunks}  ${smells}`);
    }
  }
}

function healthBar(score: number): string {
  const filled = Math.round(score * 5);
  const bar    = "█".repeat(filled) + "░".repeat(5 - filled);
  const color  = score >= 0.7 ? chalk.green : score >= 0.4 ? chalk.yellow : chalk.red;
  return color(bar);
}

function parseErrorBody(err: { message?: string }): unknown | null {
  const match = /^\d+: (.+)$/.exec(err.message ?? "");
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function isScopedSubsystemResult(value: unknown): value is ScopedSubsystemResult {
  return typeof value === "object" && value !== null && "target" in value && "summary" in value && "children" in value;
}

function isAmbiguousSubsystemResult(value: unknown): value is AmbiguousSubsystemResult {
  return typeof value === "object" && value !== null && (value as { error?: string }).error === "ambiguous_target";
}

function isUnknownSubsystemTargetResult(value: unknown): value is UnknownSubsystemTargetResult {
  return typeof value === "object" && value !== null && (value as { error?: string }).error === "unknown_target";
}

function resolveSubsystemTarget(
  positionalTarget: string | undefined,
  explicitTarget: string | undefined,
): { value?: string; error?: string } {
  const positional = positionalTarget?.trim();
  const explicit = explicitTarget?.trim();
  if (positional && explicit && positional !== explicit) {
    return { error: "Pass either a positional target or --target, not both." };
  }
  const value = positional || explicit;
  return value ? { value } : {};
}

function parsePickOption(rawPick: string | undefined): { value?: number; error?: string } {
  if (rawPick === undefined) return {};
  const value = Number.parseInt(rawPick, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: "Invalid --pick value." };
  }
  return { value };
}

function renderSubsystemError(body: unknown, explain: boolean = false): void {
  if (isAmbiguousSubsystemResult(body)) {
    console.error(`Ambiguous target "${body.target_query}". Multiple architecture regions matched:\n`);
    for (const candidate of body.candidates) {
      const parent = candidate.parent ? `   parent: ${candidate.parent}` : "";
      console.error(
        `${candidate.pick}. ${candidate.label.padEnd(18)} ${candidate.label_kind.padEnd(11)} ${String(candidate.file_count).padStart(3)} files${parent}`
      );
    }
    const explainFlag = explain ? " --explain" : "";
    console.error(`\nRun:\n  ix subsystems ${JSON.stringify(body.target_query)} --pick <n>${explainFlag}`);
    return;
  }

  if (isUnknownSubsystemTargetResult(body)) {
    console.error(body.message);
    if (body.suggestions && body.suggestions.length > 0) {
      console.error("\nTry:");
      for (const suggestion of body.suggestions) {
        console.error(`- ${suggestion}`);
      }
    }
    return;
  }

  if (typeof body === "object" && body !== null && "error" in body) {
    console.error(chalk.red("Error:"), String((body as { error: unknown }).error));
    return;
  }

  console.error(chalk.red("Error:"), "Request failed.");
}

function renderScopedSubsystemText(result: ScopedSubsystemResult, verbose: boolean): void {
  const target = result.target;
  const lines = [
    `${chalk.bold("Subsystem Scope")}: ${target.label}`,
    `Level: ${target.label_kind}`,
    result.parent ? `Parent: ${result.parent.label}` : null,
    `Files: ${target.file_count}`,
    `Confidence: ${target.confidence.toFixed(2)}`,
    target.level === 1 ? `Cross-cutting: ${target.is_cross_cutting ? "yes" : "no"}` : null,
    target.dominant_signals.length > 0 ? `Signals: ${target.dominant_signals.join(", ")}` : null,
  ].filter((line): line is string => line !== null);

  console.log(lines.join("\n"));
  console.log(`\n${chalk.bold("Health")}:`);
  console.log(
    `${result.summary.well_defined} well-defined · ` +
    `${result.summary.moderate} moderate · ` +
    `${result.summary.fuzzy} fuzzy · ` +
    `${result.summary.cross_cutting} cross-cutting`
  );

  console.log(`\n${chalk.bold("Focused Graph")}`);
  console.log(chalk.dim("  Scoped architecture tree"));
  console.log();
  renderScopedTreeNode(result.hierarchy, "", true, 0, verbose);
  console.log();
}

function renderScopedTreeNode(
  region: ScopedSubsystemRegion,
  prefix: string,
  isLast: boolean,
  depth: number,
  verbose: boolean,
): void {
  const branch = depth === 0 ? "●" : isLast ? "└─" : "├─";
  console.log(`${prefix}${branch} ${formatScopedRegionLine(region, verbose, depth)}`);

  const children = [...(region.children ?? [])].sort(compareScopedRegions);
  const nextPrefix = depth === 0 ? "   " : `${prefix}${isLast ? "   " : "│  "}`;
  children.forEach((child, index) => {
    renderScopedTreeNode(child, nextPrefix, index === children.length - 1, depth + 1, verbose);
  });
}

function compareScopedRegions(a: ScopedSubsystemRegion, b: ScopedSubsystemRegion): number {
  return b.file_count - a.file_count || b.confidence - a.confidence || a.label.localeCompare(b.label);
}

function formatScopedRegionLine(region: ScopedSubsystemRegion, verbose: boolean, depth: number): string {
  const clarity = confidenceLabel(region.confidence);
  const clarityColor = region.confidence >= 0.75 ? chalk.green : region.confidence >= 0.50 ? chalk.yellow : chalk.red;
  const confPct = Math.round(region.confidence * 100);
  const crosscut = region.is_cross_cutting ? chalk.yellow(" shared") : "";
  const badge = chalk.bgBlackBright.white(` ${region.label_kind.toUpperCase()} `);
  const signals = region.dominant_signals.slice(0, 2).join(" · ");

  if (verbose) {
    const signalText = signals.length > 0 ? chalk.dim(`  ${signals}`) : "";
    return `${badge} ${chalk.bold(region.label)}  ${chalk.dim(`${region.file_count} files`)}  ${clarityColor(`${clarity} (${confPct}%)`)}${signalText}${crosscut}`;
  }

  const fileText = depth === 0 ? chalk.dim(`${region.file_count} files`) : chalk.dim(`${region.file_count}`);
  const signalText = signals.length > 0 ? chalk.dim(`  ${signals}`) : "";
  return `${badge} ${chalk.bold(region.label)}  ${fileText}  ${clarityColor(`${clarity} ${confPct}%`)}${signalText}${crosscut}`;
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.75) return "Well-defined";
  if (confidence >= 0.50) return "Moderate";
  return "Fuzzy";
}

/** Compact a MapResult or ScopedSubsystemResult for JSON output — drops UUIDs,
 *  rounds floats, removes internal-only fields to save tokens. */
function compactMapResult(result: any): any {
  // ScopedSubsystemResult
  if (isScopedSubsystemResult(result)) {
    return compactScopedResult(result);
  }
  // Full MapResult — drop raw edges (505KB+ of UUID pairs) and
  // hierarchy (redundant with regions); keep only compacted regions.
  const regions = result.regions ?? [];
  const out: any = {
    file_count: result.file_count,
    region_count: result.region_count,
    levels: result.levels,
    map_rev: result.map_rev,
    outcome: result.outcome,
    regions: regions.map(compactRegion),
  };
  // Include hierarchy only as a compact tree if present
  if (result.hierarchy) {
    out.hierarchy = compactHierarchyNode(result.hierarchy);
  }
  return out;
}

function compactRegion(r: any): any {
  const out: any = {
    label: r.label,
    level: r.level,
    files: r.file_count,
    children: r.child_region_count,
    cohesion: roundFloat(r.cohesion),
    coupling: roundFloat(r.external_coupling),
    boundary: roundFloat(r.boundary_ratio),
    confidence: roundFloat(r.confidence),
    signals: r.dominant_signals,
    interfaces: r.interface_node_count,
  };
  if (r.crosscut_score > 0.01) out.crosscut = roundFloat(r.crosscut_score);
  return out;
}

function compactScopedResult(result: any): any {
  const target = result.target;
  return {
    target: {
      label: target.label,
      kind: target.label_kind,
      level: target.level,
      files: target.file_count,
      confidence: roundFloat(target.confidence),
      signals: target.dominant_signals,
      cross_cutting: target.is_cross_cutting || undefined,
    },
    parent: result.parent ? { label: result.parent.label, kind: result.parent.label_kind } : undefined,
    summary: result.summary,
    hierarchy: compactHierarchyNode(result.hierarchy),
    children: (result.children ?? []).map(compactRegion),
  };
}

function compactHierarchyNode(node: any): any {
  if (!node) return undefined;
  const out: any = {
    label: node.label,
    kind: node.label_kind,
    files: node.file_count,
    confidence: roundFloat(node.confidence),
  };
  if (node.children?.length > 0) {
    out.children = node.children.map(compactHierarchyNode);
  }
  return out;
}
