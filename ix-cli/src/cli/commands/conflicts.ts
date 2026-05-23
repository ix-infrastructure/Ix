import type { Command } from "commander";
import { createClient } from "../config.js";
import { formatConflicts } from "../format.js";

export function registerConflictsCommand(program: Command): void {
  program
    .command("conflicts")
    .description("List detected conflicts")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = await createClient();
      const conflicts = await client.conflicts();
      formatConflicts(conflicts as any[], opts.format);
    });
}
