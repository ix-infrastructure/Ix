import type { Command } from "commander";
import { createClient } from "../config.js";
import { formatContext } from "../format.js";
import { stderr } from "../stderr.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query <question>")
    .description("[DEPRECATED] Broad NLP-style graph query — prefer bounded commands instead")
    .option("--as-of <rev>", "Time-travel to a specific revision")
    .option("--depth <depth>", "Query depth (shallow|standard|deep)", "standard")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--unsafe", "Enable query (can produce large outputs)")
    .action(async (question: string, opts: { asOf?: string; depth?: string; format: string; unsafe?: boolean }) => {
      stderr("\n⚠  ix query is DEPRECATED — broad NLP-style graph queries produce oversized, low-signal responses.");
      stderr("   Decompose your question into targeted commands instead:\n");
      stderr("  ix search <term>          Find entities by name/kind");
      stderr("  ix explain <symbol>       Structure, container, history, calls");
      stderr("  ix callers <symbol>       What calls a function (cross-file)");
      stderr("  ix callees <symbol>       What a function calls");
      stderr("  ix contains <symbol>      Members of a class/module");
      stderr("  ix imports <symbol>       What an entity imports");
      stderr("  ix imported-by <symbol>   What imports an entity");
      stderr("  ix depends <symbol>       Dependency impact analysis");
      stderr("  ix text <term>            Fast lexical search (ripgrep)");
      stderr("  ix read <target>          Read source code directly");
      stderr("  ix decisions              List design decisions");
      stderr("  ix history <entityId>     Provenance chain");
      stderr("  ix diff <from> <to>       Changes between revisions\n");
      if (!opts.unsafe) {
        stderr("Pass --unsafe to run anyway (not recommended).\n");
        return;
      }
      stderr("Running with --unsafe...\n");
      const client = await createClient();
      const result = await client.query(question, {
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
        depth: opts.depth,
      });
      formatContext(result, opts.format);
    });
}
