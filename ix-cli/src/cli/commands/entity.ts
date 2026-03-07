import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerEntityCommand(program: Command): void {
  program
    .command("entity <id>")
    .description("Get entity details with claims and edges")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (id: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolvedId = await client.resolvePrefix(id);
      const result = await client.entity(resolvedId);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Entity: ${result.node.id} (${result.node.kind})`);
        console.log(`Claims: ${(result.claims as unknown[]).length}`);
        console.log(`Edges:  ${(result.edges as unknown[]).length}`);
      }
    });
}
