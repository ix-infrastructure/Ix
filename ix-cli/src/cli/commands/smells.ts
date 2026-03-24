import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

interface SmellCandidate {
  file_id: string;
  file: string;
  smell: string;
  confidence: number;
  signals: Record<string, unknown>;
  inference_version: string;
}

interface SmellReport {
  rev: number;
  run_at: string;
  count: number;
  candidates: SmellCandidate[];
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
    .option("--format <fmt>",              "Output format (text|json)",        "text")
    .option("--orphan-max-connections <n>","Max connections for orphan files",  "0")
    .option("--god-module-chunks <n>",     "Min chunks for god module",         "20")
    .option("--god-module-fan <n>",        "Min fan-in/out for god module",     "15")
    .option("--weak-max-neighbors <n>",    "Max neighbors for weak component",  "1")
    .option("--list",                      "List existing smell claims without rerunning")
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
  ix smells --list`)
    .action(async (opts: {
      format: string;
      orphanMaxConnections: string;
      godModuleChunks: string;
      godModuleFan: string;
      weakMaxNeighbors: string;
      list?: boolean;
    }) => {
      const client = new IxClient(getEndpoint());

      if (opts.list) {
        let result: any;
        try {
          result = await client.listSmells();
        } catch (err: any) {
          console.error(chalk.red("Error:"), err.message);
          process.exitCode = 1;
          return;
        }
        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const smells = result.smells ?? [];
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
        }) as SmellReport;
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(
        `\n${chalk.bold("Architecture Smells")}  ` +
        chalk.dim(`rev ${report.rev} · ${report.count} candidates`)
      );

      if (report.count === 0) {
        console.log(chalk.green("\n  No smell candidates found."));
        return;
      }

      // Group by smell kind
      const byKind = new Map<string, SmellCandidate[]>();
      for (const c of report.candidates) {
        if (!byKind.has(c.smell)) byKind.set(c.smell, []);
        byKind.get(c.smell)!.push(c);
      }

      for (const [kind, candidates] of byKind) {
        const label = SMELL_LABELS[kind] ?? kind;
        console.log(`\n${chalk.bold(label)}  ${chalk.dim(`(${candidates.length})`)}`);

        const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
        for (const c of sorted) {
          const conf = confidenceBar(c.confidence);
          const fileName = c.file.length > 45
            ? "…" + c.file.slice(-44)
            : c.file.padEnd(45);
          const signalStr = formatSignals(c.smell, c.signals);
          console.log(`  ${conf} ${chalk.dim(fileName)}  ${chalk.dim(signalStr)}`);
        }
      }

      console.log(chalk.dim(`\nSmell claims stored with inference_version=smell_v1. Use 'ix smells --list' to retrieve.`));
    });
}

function confidenceBar(conf: number): string {
  const filled = Math.round(conf * 5);
  const bar    = "█".repeat(filled) + "░".repeat(5 - filled);
  const color  = conf >= 0.75 ? chalk.red : conf >= 0.5 ? chalk.yellow : chalk.dim;
  return color(bar);
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
