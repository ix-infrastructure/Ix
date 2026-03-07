import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest <path>")
    .description("Ingest source files into the knowledge graph")
    .option("--recursive", "Recursively ingest directory")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (path: string, opts: { recursive?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());
      const start = performance.now();
      const result = await client.ingest(path, opts.recursive);
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      if (opts.format === "json") {
        console.log(JSON.stringify({ ...result, elapsedSeconds: parseFloat(elapsed) }, null, 2));
      } else {
        console.log(chalk.bold("\nIngest summary"));
        console.log(`  processed:   ${result.patchesApplied} files (${elapsed}s)`);
        console.log(`  discovered:  ${result.filesProcessed} files`);
        if (result.skipReasons) {
          const sr = result.skipReasons;
          if (sr.unchanged > 0) console.log(`  ${chalk.dim("skipped unchanged:")} ${sr.unchanged}`);
          if (sr.emptyFile > 0) console.log(`  ${chalk.dim("skipped empty:")}     ${sr.emptyFile}`);
          if (sr.parseError > 0) console.log(`  ${chalk.red("parse errors:")}      ${sr.parseError}`);
          if (sr.tooLarge > 0) console.log(`  ${chalk.dim("skipped too large:")} ${sr.tooLarge}`);
        } else if (result.filesSkipped) {
          console.log(`  ${chalk.dim("skipped:")}  ${result.filesSkipped} unchanged files`);
        }
        console.log(`  rev:         ${result.latestRev}`);

        if (result.patchesApplied === 0 && result.filesProcessed === 0) {
          console.log(chalk.yellow("\n  ⚠ No files ingested. The path may be outside the project root,"));
          console.log(chalk.yellow("    contain no supported file types, or not exist."));
        } else if (result.patchesApplied === 0 && result.filesProcessed > 0) {
          console.log(chalk.dim("\n  All files unchanged since last ingest."));
        }
        console.log();
      }
    });
}
