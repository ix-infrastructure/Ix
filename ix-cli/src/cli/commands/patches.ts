import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatPatches } from "../format.js";

export function registerPatchesCommand(program: Command): void {
  program
    .command("patches")
    .description("List recent patches")
    .option("--limit <n>", "Maximum patches to return", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .action(async (opts: { limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const patches = await client.listPatches({ limit: parseInt(opts.limit, 10) });
      formatPatches(patches, opts.format);
    });
}
