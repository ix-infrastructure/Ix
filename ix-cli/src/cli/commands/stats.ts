// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { resolveReadSystemId } from "../resolve.js";
import { llmLine, type LlmValue } from "../llm.js";
import { printJson } from "../format.js";
import { formatOption } from "../options.js";

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
    .addOption(formatOption())
    .action(async (opts: { format: string }) => {
      // /v1/stats takes seconds on a large graph: no read deadline.
      const client = createClient({ longRunning: true });
      const systemId = await resolveReadSystemId(client);
      // A backend failure goes to the top-level handler, which answers it in
      // this command's format with the endpoint's next step.
      const result = await client.stats({ workspaceId: systemId ? undefined : resolveWorkspaceId(), systemId });

      if (opts.format === "json") {
        printJson(result);
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
