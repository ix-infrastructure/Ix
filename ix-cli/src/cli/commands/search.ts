import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes } from "../format.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <term>")
    .description("Search the knowledge graph by term")
    .option("--limit <n>", "Max results", "20")
    .option("--kind <kind>", "Filter by node kind (e.g. method, class, decision)")
    .option("--language <lang>", "Filter by language/file extension (e.g. scala, ts)")
    .option("--as-of <rev>", "Search as of a specific revision")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix search IngestionService --kind class\n  ix search auth --language python --limit 10\n  ix search \"\" --kind file --limit 50 --format json")
    .action(async (term: string, opts: {
      limit: string; kind?: string; language?: string; asOf?: string; format: string
    }) => {
      const client = new IxClient(getEndpoint());
      const nodes = await client.search(term, {
        limit: parseInt(opts.limit, 10),
        kind: opts.kind,
        language: opts.language,
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
      });
      formatNodes(nodes, opts.format);
    });
}
