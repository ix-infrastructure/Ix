import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "in", predicates: ["CALLS"] });
      formatEdgeResults(result.nodes, "callers", symbol, opts.format);
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const entityId = (nodes[0] as any).id;

      const result = await client.expand(entityId, { direction: "out", predicates: ["CALLS"] });
      formatEdgeResults(result.nodes, "callees", symbol, opts.format);
    });
}
