import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerInventoryCommand(program: Command): void {
  program
    .command("inventory")
    .description("List entities by kind with optional path scoping")
    .requiredOption("--kind <kind>", "Entity kind to list (class, method, function, file, module, etc.)")
    .option("--path <path>", "Filter by source file path substring")
    .option("--limit <n>", "Max results", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", `
Examples:
  ix inventory --kind class
  ix inventory --kind class --path memory-layer
  ix inventory --kind file --path ix-cli/src
  ix inventory --kind method --limit 100
  ix inventory --format json --kind class`)
    .action(async (opts: {
      kind: string; path?: string; limit: string; format: string;
    }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);

      let nodes = await client.listByKind(opts.kind, { limit });

      if (opts.path) {
        nodes = nodes.filter((n) => {
          const uri = String(
            (n as any).provenance?.source_uri ??
            n.provenance?.sourceUri ??
            n.attrs?.path ??
            ""
          );
          return uri.includes(opts.path!);
        });
      }

      const scope = opts.path ?? null;

      if (opts.format === "json") {
        const results = nodes.map((n) => ({
          id: n.id,
          name: n.name || n.attrs?.name || "(unnamed)",
          kind: n.kind,
          path:
            (n as any).provenance?.source_uri ??
            n.provenance?.sourceUri ??
            n.attrs?.path ??
            undefined,
        }));
        const output = {
          kind: opts.kind,
          scope: scope,
          results,
          summary: { total: results.length },
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (nodes.length === 0) {
        console.log(`No ${opts.kind} entities found${scope ? ` in ${scope}` : ""}.`);
        return;
      }

      console.log(`Inventory: ${nodes.length} ${opts.kind} entities${scope ? ` in ${scope}` : ""}`);
      for (const n of nodes) {
        const name = n.name || n.attrs?.name || "(unnamed)";
        const path = String(
          (n as any).provenance?.source_uri ??
          n.provenance?.sourceUri ??
          n.attrs?.path ??
          ""
        );
        console.log(
          `  ${chalk.cyan(n.kind.padEnd(10))}  ${chalk.bold(String(name).padEnd(30))}  ${chalk.dim(path)}`
        );
      }
    });
}
