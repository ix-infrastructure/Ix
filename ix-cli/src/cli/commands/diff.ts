import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatDiff } from "../format.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <fromRev> <toRev>")
    .description("Show diff between two revisions")
    .option("--entity <id>", "Filter by entity ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (fromRev: string, toRev: string, opts: { entity?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.diff(parseInt(fromRev, 10), parseInt(toRev, 10), opts.entity);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        formatDiff(result, "text");
      }
    });
}
