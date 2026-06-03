import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { detectSystem } from "../system.js";
import { llmLine, llmError, type LlmValue } from "../llm.js";

/** Render `ix stats` as llm records: one `nodes` line and one `edges` line. */
export function renderStatsLlm(result: any): string[] {
  const nodeFields: Array<[string, LlmValue]> = [["total", result.nodes.total]];
  for (const entry of result.nodes.byKind) {
    if ((entry.count ?? 0) > 0) nodeFields.push([entry.kind ?? "unknown", entry.count]);
  }
  const edgeFields: Array<[string, LlmValue]> = [["total", result.edges.total]];
  for (const entry of result.edges.byPredicate) {
    if ((entry.count ?? 0) > 0) edgeFields.push([entry.predicate ?? "unknown", entry.count]);
  }
  return [llmLine("nodes", nodeFields), llmLine("edges", edgeFields)];
}

export function registerStatsCommand(program: Command): void {
  program
    .command("stats")
    .description("Show graph statistics — node/edge counts by type")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const systemId = detectSystem(process.cwd())?.systemId;
      let result;
      try {
        result = await client.stats({ workspaceId: systemId ? undefined : resolveWorkspaceId(), systemId });
      } catch (err: any) {
        if (opts.format === "llm") console.log(llmError("backend_error", err.message ?? "stats request failed"));
        else console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderStatsLlm(result)) console.log(line);
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
