import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history <entityId>")
    .description("Show provenance chain for an entity")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (entityId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolvedId = await client.resolvePrefix(entityId);
      const result = await client.provenance(resolvedId);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    });
}
