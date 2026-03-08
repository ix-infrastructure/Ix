import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";
import { resolveEntity, printResolved } from "../resolve.js";

export function registerContainsCommand(program: Command): void {
  program
    .command("contains <symbol>")
    .description("Show members contained by the given entity (class, module, file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const target = await resolveEntity(client, symbol, ["class", "object", "trait", "interface", "module", "file"], opts);
      if (!target) return;
      printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] });
      formatEdgeResults(result.nodes, "contains", target.name, opts.format, target);
    });
}
