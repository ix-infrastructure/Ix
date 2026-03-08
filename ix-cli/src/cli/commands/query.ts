import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatContext } from "../format.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query <question>")
    .description("[DEPRECATED] Broad NLP-style graph query — prefer bounded commands instead")
    .option("--as-of <rev>", "Time-travel to a specific revision")
    .option("--depth <depth>", "Query depth (shallow|standard|deep)", "standard")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--unsafe", "Enable query (can produce large outputs)")
    .action(async (question: string, opts: { asOf?: string; depth?: string; format: string; unsafe?: boolean }) => {
      console.log("\n⚠  ix query is DEPRECATED — broad NLP-style graph queries produce oversized, low-signal responses.");
      console.log("   Decompose your question into targeted commands instead:\n");
      console.log("  ix search <term>          Find entities by name/kind");
      console.log("  ix explain <symbol>       Structure, container, history, calls");
      console.log("  ix callers <symbol>       What calls a function (cross-file)");
      console.log("  ix callees <symbol>       What a function calls");
      console.log("  ix contains <symbol>      Members of a class/module");
      console.log("  ix imports <symbol>       What an entity imports");
      console.log("  ix imported-by <symbol>   What imports an entity");
      console.log("  ix depends <symbol>       Dependency impact analysis");
      console.log("  ix text <term>            Fast lexical search (ripgrep)");
      console.log("  ix read <target>          Read source code directly");
      console.log("  ix decisions              List design decisions");
      console.log("  ix history <entityId>     Provenance chain");
      console.log("  ix diff <from> <to>       Changes between revisions\n");
      if (!opts.unsafe) {
        console.log("Pass --unsafe to run anyway (not recommended).\n");
        return;
      }
      console.log("Running with --unsafe...\n");
      const client = new IxClient(getEndpoint());
      const result = await client.query(question, {
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
        depth: opts.depth,
      });
      formatContext(result, opts.format);
    });
}
