import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatConflicts } from "../format.js";

export function registerConflictsCommand(program: Command): void {
  program
    .command("conflicts")
    .description("List detected conflicts")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const conflicts = await client.conflicts();
      formatConflicts(conflicts as any[], opts.format);
    });
}
