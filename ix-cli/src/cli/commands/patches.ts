import type { Command } from "commander";
import { createClient } from "../config.js";
import { formatPatches } from "../format.js";

export function registerPatchesCommand(program: Command): void {
  program
    .command("patches")
    .description("List recent patches")
    .option("--limit <n>", "Maximum patches to return", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { limit: string; format: string }) => {
      const client = await createClient();
      const patches = await client.listPatches({ limit: parseInt(opts.limit, 10) });
      formatPatches(patches, opts.format);
    });
}
