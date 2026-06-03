import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { llmLine, type LlmValue } from "../llm.js";

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show graph statistics — node/edge counts by type")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.stats({ workspaceId: resolveWorkspaceId() });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (opts.format === "llm") {
        const nodeFields: Array<[string, LlmValue]> = [["total", result.nodes.total]];
        for (const entry of result.nodes.byKind) {
          if ((entry.count ?? 0) > 0) nodeFields.push([entry.kind ?? "unknown", entry.count]);
        }
        const edgeFields: Array<[string, LlmValue]> = [["total", result.edges.total]];
        for (const entry of result.edges.byPredicate) {
          if ((entry.count ?? 0) > 0) edgeFields.push([entry.predicate ?? "unknown", entry.count]);
        }
        console.log(llmLine("nodes", nodeFields));
        console.log(llmLine("edges", edgeFields));
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
