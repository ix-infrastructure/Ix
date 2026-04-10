import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show system-level metrics — entity and relationship counts by type")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.stats();

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold("\nnodes") + chalk.dim(` (${result.nodes.total} total)`));
      for (const entry of result.nodes.byKind) {
        const kind = entry.kind ?? "unknown";
        const count = entry.count ?? 0;
        console.log(`  ${chalk.cyan(kind)}: ${count}`);
      }

      console.log(chalk.bold("\nedges") + chalk.dim(` (${result.edges.total} total)`));
      for (const entry of result.edges.byPredicate) {
        const pred = entry.predicate ?? "unknown";
        const count = entry.count ?? 0;
        console.log(`  ${chalk.cyan(pred)}: ${count}`);
      }
      console.log();
    });
}
