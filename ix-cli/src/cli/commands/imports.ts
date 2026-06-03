import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { llmError } from "../llm.js";

function llmUnresolved(format: string, symbol: string): void {
  if (format === "llm") console.log(llmError("unresolved_target", `No entity resolved for "${symbol}".`));
}

export function registerImportsCommand(program: Command): void {
  program
    .command("imports <symbol>")
    .description("Show what the given entity imports")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix imports auth.py\n  ix imports IngestionService --format json")
    .action(async (symbol: string, opts: { kind?: string; pick?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) { llmUnresolved(opts.format, symbol); return; }
      if (opts.format === "text") printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes.slice(0, limit), "imports", target.name, opts.format, target, "graph");
    });

  program
    .command("imported-by <symbol>")
    .description("Show what imports the given entity")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix imported-by AuthProvider\n  ix imported-by io.circe.Json --format json")
    .action(async (symbol: string, opts: { kind?: string; pick?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) { llmUnresolved(opts.format, symbol); return; }
      if (opts.format === "text") printResolved(target);
      const result = await client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes.slice(0, limit), "imported-by", target.name, opts.format, target, "graph");
    });
}
