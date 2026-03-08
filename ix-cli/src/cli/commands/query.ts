import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatContext } from "../format.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query <question>")
    .description("Query the knowledge graph for structured context (use --unsafe to enable)")
    .option("--as-of <rev>", "Time-travel to a specific revision")
    .option("--depth <depth>", "Query depth (shallow|standard|deep)", "standard")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--unsafe", "Enable query (can produce large outputs)")
    .action(async (question: string, opts: { asOf?: string; depth?: string; format: string; unsafe?: boolean }) => {
      if (!opts.unsafe) {
        console.log("ix query is disabled by default to prevent large token outputs.");
        console.log("Use --unsafe to enable, or try these targeted alternatives:\n");
        console.log("  ix search <term>        Find entities by name");
        console.log("  ix explain <symbol>     Understand an entity");
        console.log("  ix callers <symbol>     Find what calls a function");
        console.log("  ix contains <symbol>    See members of a class/module");
        console.log("  ix text <term>          Lexical search across code");
        console.log("  ix read <target>        Read source code directly");
        return;
      }
      const client = new IxClient(getEndpoint());
      const result = await client.query(question, {
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
        depth: opts.depth,
      });
      formatContext(result, opts.format);
    });
}
