// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { resolveReadSystemId } from "../resolve.js";
import { llmLine, llmError, type LlmValue } from "../llm.js";
import { printJson, sliceRanked, truncationHint, type Slice } from "../format.js";

export interface SmellCandidate {
  file_id: string;
  file: string;
  smell: string;
  confidence: number;
  signals: Record<string, unknown>;
  inference_version: string;
}

export interface SmellReport {
  rev: number;
  run_at: string;
  count: number;
  candidates: SmellCandidate[];
}

/** Default cap on text and llm output. JSON is uncapped unless --limit is given. */
const DEFAULT_LIMIT = 50;

/**
 * Extensions of files that hold no parsed code: docs, templates and
 * data/config. An orphan of one of these is not an architecture finding.
 * CSS, HTML, SQL and shell stay out of this set: an orphan stylesheet, page
 * or script can be a real finding.
 */
const NON_SOURCE_EXTENSIONS = new Set([
  // docs
  ".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc",
  // templates
  ".hbs", ".handlebars", ".ejs", ".mustache", ".njk", ".j2", ".jinja", ".jinja2",
  ".liquid", ".tmpl", ".tpl", ".template",
  // data / config
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".lock", ".csv", ".svg",
]);

/** Extensionless basenames that are build files, so still source. */
const EXTENSIONLESS_SOURCE = new Set([
  "dockerfile", "containerfile", "makefile", "gnumakefile", "rakefile", "gemfile",
  "justfile", "jenkinsfile", "vagrantfile", "procfile", "podfile", "brewfile",
  "fastfile", "guardfile", "berksfile", "capfile", "snakefile", "tiltfile",
  "build", "workspace",
  // shell dotfiles the ingester parses as Bash
  ".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv", ".profile",
]);

/**
 * True for an Orphan File row whose path is a doc, template or data/config
 * file, or an extensionless file such as README or LICENSE that is not a
 * known build file. Never true for any other smell kind.
 */
export function isNonSourceOrphan(c: SmellCandidate): boolean {
  if (c.smell !== "has_smell.orphan_file") return false;
  const path = c.file ?? "";
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (base === "") return false;
  const dot = base.lastIndexOf(".");
  // No extension (README, LICENSE, CODEOWNERS) or a bare dotfile (.gitignore):
  // non-source unless it is a known build file.
  if (dot <= 0) return !EXTENSIONLESS_SOURCE.has(base);
  return NON_SOURCE_EXTENSIONS.has(base.slice(dot));
}

export interface SmellSelection {
  slice: Slice<SmellCandidate>;
  /** Orphan File rows dropped as non-source before the cut. */
  filteredNonSource: number;
}

/**
 * Drop non-source orphan rows, rank by confidence (highest first, stable among
 * ties), then cut to `limit`. `total` on the slice counts what survived the
 * filter.
 */
export function selectSmells(report: SmellReport, limit: number, filterNonSource = true): SmellSelection {
  const kept = filterNonSource ? report.candidates.filter(c => !isNonSourceOrphan(c)) : report.candidates;
  const sorted = [...kept].sort((a, b) => b.confidence - a.confidence);
  return {
    slice: sliceRanked(sorted, limit),
    filteredNonSource: report.candidates.length - kept.length,
  };
}

/**
 * The cap to apply: an explicit --limit wins (0 = all). Without one, text and
 * llm stop at DEFAULT_LIMIT and JSON returns everything, because MCP ix_smells
 * and plugin fallbacks filter the JSON by path themselves.
 */
function resolveLimit(raw: string | undefined, format: string): number {
  if (raw === undefined) return format === "json" ? Infinity : DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  return !Number.isFinite(n) || n <= 0 ? Infinity : n;
}

const SMELL_LABELS: Record<string, string> = {
  "has_smell.orphan_file":          "Orphan File",
  "has_smell.god_module":           "God Module",
  "has_smell.weak_component_member":"Weak Component",
};

export function registerSmellsCommand(program: Command): void {
  program
    .command("smells")
    .description("Detect architecture smells in the codebase")
    .option("--format <fmt>",              "Output format (text|json|llm)",    "text")
    .option("--orphan-max-connections <n>","Max connections for orphan files",  "0")
    .option("--god-module-chunks <n>",     "Min chunks for god module",         "20")
    .option("--god-module-fan <n>",        "Min fan-in/out for god module",     "15")
    .option("--weak-max-neighbors <n>",    "Max neighbors for weak component",  "1")
    .option("--list",                      "List existing smell claims without rerunning")
    .option("--limit <n>",                 "Max candidates to show, highest confidence first (0 = all, non-source orphans included; detection run only)")
    .addHelpText("after", `
Runs graph-query-based architecture smell detection and stores results as
versioned claims (inference_version=smell_v1) on affected File nodes.

Smells detected:
  orphan_file          Files with no import or call connections
  god_module           Files with high chunk count or fan-in/fan-out
  weak_component_member Files connected to very few others

Examples:
  ix smells
  ix smells --god-module-chunks 15 --god-module-fan 10
  ix smells --format json
  ix smells --limit 200
  ix smells --limit 0
  ix smells --list`)
    .action(async (opts: {
      format: string;
      orphanMaxConnections: string;
      godModuleChunks: string;
      godModuleFan: string;
      weakMaxNeighbors: string;
      list?: boolean;
      limit?: string;
    }) => {
      const client = createClient();
      const systemId = await resolveReadSystemId(client);

      if (opts.list) {
        let result: any;
        try {
          result = await client.listSmells({ workspaceId: systemId ? undefined : resolveWorkspaceId(), systemId });
        } catch (err: any) {
          if (opts.format === "llm") console.log(llmError("backend_error", err.message ?? "smells request failed"));
          else console.error(chalk.red("Error:"), err.message);
          process.exitCode = 1;
          return;
        }
        if (opts.format === "json") {
          const smells = result.smells ?? [];
          printJson({
            count: smells.length,
            inference_version: "smell_v1",
            smells: smells.map((s: any) => ({
              smell: s.smell,
              entity_id: s.entity_id?.slice(0, 12),
              confidence: s.confidence,
            })),
          });
          return;
        }
        const smells = result.smells ?? [];
        if (opts.format === "llm") {
          for (const line of renderSmellsListLlm(smells)) console.log(line);
          return;
        }
        if (smells.length === 0) {
          console.log(chalk.dim("No smell claims found. Run `ix smells` to detect."));
          return;
        }
        console.log(`\n${chalk.bold("Smell Claims")}  ${chalk.dim(`(${smells.length} total)`)}\n`);
        for (const s of smells) {
          const label = SMELL_LABELS[s.smell] ?? s.smell;
          console.log(`  ${chalk.yellow(label.padEnd(20))} ${chalk.dim(s.entity_id?.slice(0, 8))}  ${chalk.dim(s.inference_version ?? "")}`);
        }
        return;
      }

      if (opts.format !== "json") {
        process.stderr.write(chalk.dim("Running smell detection...\n"));
      }

      let report: SmellReport;
      try {
        report = await client.runSmells({
          orphanMaxConnections: parseInt(opts.orphanMaxConnections, 10),
          godModuleChunks:      parseInt(opts.godModuleChunks, 10),
          godModuleFan:         parseInt(opts.godModuleFan, 10),
          weakMaxNeighbors:     parseInt(opts.weakMaxNeighbors, 10),
          workspaceId:          systemId ? undefined : resolveWorkspaceId(),
          systemId,
        }) as SmellReport;
      } catch (err: any) {
        if (opts.format === "llm") console.log(llmError("backend_error", err.message ?? "smells request failed"));
        else console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      // Plain `--format json` is the raw contract MCP ix_smells and plugin
      // fallbacks path-filter themselves, so it neither caps nor drops rows
      // unless --limit is passed. An explicit `--limit 0` means everything,
      // so it drops nothing either, in every format.
      const rawJson = opts.format === "json" && opts.limit === undefined;
      const limit = resolveLimit(opts.limit, opts.format);
      const everything = opts.limit !== undefined && limit === Infinity;
      const selection = selectSmells(report, limit, !(rawJson || everything));
      const { slice, filteredNonSource } = selection;

      if (opts.format === "json") {
        // Compact: hoist inference_version to top, drop file_id UUIDs
        const compact: Record<string, unknown> = {
          rev: report.rev,
          run_at: report.run_at,
          count: slice.total,
          shown: slice.shown,
          truncated: slice.truncated,
          ...(filteredNonSource > 0 ? { filtered_non_source: filteredNonSource } : {}),
          inference_version: "smell_v1",
          candidates: slice.rows.map(c => ({
            file: c.file,
            smell: c.smell,
            confidence: c.confidence,
            signals: c.signals,
          })),
        };
        printJson(compact);
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderSmellsRunLlm(report, selection)) console.log(line);
        return;
      }

      const countText = slice.truncated
        ? `${slice.total} candidates · showing ${slice.shown}`
        : `${slice.total} candidates`;
      const hiddenText = filteredNonSource > 0
        ? ` (${filteredNonSource} non-source orphan files hidden)`
        : "";
      console.log(
        `\n${chalk.bold("Architecture Smells")}  ` +
        chalk.dim(`rev ${report.rev} · ${countText}${hiddenText}`)
      );

      if (slice.total === 0) {
        console.log(chalk.green("\n  No smell candidates found."));
        return;
      }

      // Group the shown rows by smell kind; each group stays confidence-sorted.
      const byKind = new Map<string, SmellCandidate[]>();
      for (const c of slice.rows) {
        if (!byKind.has(c.smell)) byKind.set(c.smell, []);
        byKind.get(c.smell)!.push(c);
      }

      for (const [kind, candidates] of byKind) {
        const label = SMELL_LABELS[kind] ?? kind;
        console.log(`\n${chalk.bold(label)}  ${chalk.dim(`(${candidates.length})`)}`);

        for (const c of candidates) {
          const conf = confidenceBar(c.confidence);
          const fileName = c.file.length > 45
            ? "…" + c.file.slice(-44)
            : c.file.padEnd(45);
          const signalStr = formatSignals(c.smell, c.signals);
          console.log(`  ${conf} ${chalk.dim(fileName)}  ${chalk.dim(signalStr)}`);
        }
      }

      if (slice.truncated) console.log(chalk.dim(`\n${truncationHint(slice, "smell candidates")}`));

      console.log(chalk.dim(`\nSmell claims stored with inference_version=smell_v1. Use 'ix smells --list' to retrieve.`));
    });
}

function confidenceBar(conf: number): string {
  const filled = Math.round(conf * 5);
  const bar    = "█".repeat(filled) + "░".repeat(5 - filled);
  const color  = conf >= 0.75 ? chalk.red : conf >= 0.5 ? chalk.yellow : chalk.dim;
  return color(bar);
}

/** Render `ix smells --list` claims as llm records. */
export function renderSmellsListLlm(smells: any[]): string[] {
  const lines = [llmLine("smells", [["count", smells.length], ["version", "smell_v1"]])];
  for (const s of smells) {
    lines.push(llmLine("smell", [
      ["kind", s.smell],
      ["entity", s.entity_id?.slice(0, 12)],
      ["confidence", s.confidence],
      ["version", s.inference_version],
    ]));
  }
  return lines;
}

/**
 * Render a fresh `ix smells` detection run as llm records, highest-confidence
 * first. Without a selection, every candidate is shown (no filter, no cap).
 */
export function renderSmellsRunLlm(report: SmellReport, selection?: SmellSelection): string[] {
  const { slice, filteredNonSource } = selection ?? {
    slice: sliceRanked([...report.candidates].sort((a, b) => b.confidence - a.confidence), Infinity),
    filteredNonSource: 0,
  };
  const lines = [llmLine("smells", [
    ["rev", report.rev],
    ["count", slice.total],
    ["shown", slice.shown],
    ["filtered_non_source", filteredNonSource > 0 ? filteredNonSource : undefined],
    ["version", "smell_v1"],
  ])];
  if (slice.truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["message", truncationHint(slice, "smell candidates")],
    ]));
  }
  for (const c of slice.rows) {
    lines.push(llmLine("smell", [
      ["kind", c.smell],
      ["file", c.file],
      ["confidence", c.confidence],
      ...signalFields(c.smell, c.signals),
    ]));
  }
  return lines;
}

/**
 * Structured signal fields per smell kind for the llm format. Mirrors the
 * fields shown in text mode. A god_module's chunk count is dropped when 0
 * (uncomputed / no signal); fan-in/out are the defining signals and kept.
 */
function signalFields(smellKind: string, signals: Record<string, unknown>): Array<[string, LlmValue]> {
  const num = (v: unknown): LlmValue =>
    typeof v === "number" || typeof v === "string" ? v : undefined;
  switch (smellKind) {
    case "has_smell.orphan_file":
      return [["connections", num(signals["connectivity"]) ?? 0]];
    case "has_smell.god_module": {
      const chunks = num(signals["chunks"]);
      return [
        ["chunks", chunks === 0 ? undefined : chunks],
        ["fan_in", num(signals["fan_in"])],
        ["fan_out", num(signals["fan_out"])],
      ];
    }
    case "has_smell.weak_component_member":
      return [["neighbors", num(signals["neighbor_count"]) ?? 0]];
    default:
      return [];
  }
}

function formatSignals(smellKind: string, signals: Record<string, unknown>): string {
  switch (smellKind) {
    case "has_smell.orphan_file":
      return `connections=${signals["connectivity"] ?? 0}`;
    case "has_smell.god_module":
      return [
        signals["chunks"]  !== undefined ? `chunks=${signals["chunks"]}` : null,
        signals["fan_in"]  !== undefined ? `fan_in=${signals["fan_in"]}` : null,
        signals["fan_out"] !== undefined ? `fan_out=${signals["fan_out"]}` : null,
      ].filter(Boolean).join(" ");
    case "has_smell.weak_component_member":
      return `neighbors=${signals["neighbor_count"] ?? 0}`;
    default:
      return "";
  }
}
