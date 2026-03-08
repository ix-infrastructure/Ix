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
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix contains IngestionService\n  ix contains auth.py --kind file --format json\n  ix contains MyClass --limit 20")
    .action(async (symbol: string, opts: { kind?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const target = await resolveEntity(client, symbol, ["class", "object", "trait", "interface", "module", "file"], opts);
      if (!target) return;
      printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] });
      const limited = result.nodes.slice(0, limit);
      formatEdgeResults(limited, "contains", target.name, opts.format, target, "graph");
    });
}
