import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity, printResolved } from "../resolve.js";

export function registerDependsCommand(program: Command): void {
  program
    .command("depends <symbol>")
    .description("Show what depends on the given entity (reverse CALLS + IMPORTS)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--depth <n>", "Traversal depth (default 1)", "1")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix depends verify_token\n  ix depends AuthProvider --depth 2 --format json\n  ix depends parser.py --kind file --limit 20")
    .action(async (symbol: string, opts: { kind?: string; depth: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const target = await resolveEntity(
        client, symbol,
        ["method", "function", "class", "object", "trait", "interface", "module", "file"],
        opts
      );
      if (!target) return;

      const hops = parseInt(opts.depth, 10) || 1;

      const [callResult, importResult] = await Promise.all([
        client.expand(target.id, { direction: "in", predicates: ["CALLS"], hops }),
        client.expand(target.id, { direction: "in", predicates: ["IMPORTS"], hops }),
      ]);

      const seen = new Set<string>();
      const callers: any[] = [];
      const importers: any[] = [];

      for (const n of callResult.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          callers.push({ ...n, via: "CALLS" });
        }
      }
      for (const n of importResult.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          importers.push({ ...n, via: "IMPORTS" });
        }
      }

      const allDependents = [...callers, ...importers].slice(0, limit);

      if (opts.format === "json") {
        console.log(JSON.stringify({
          resultSource: "graph" as const,
          resolvedTarget: target,
          directDependents: allDependents.map((d: any) => ({
            id: d.id,
            kind: d.kind,
            name: d.name || d.attrs?.name || d.id,
            via: d.via,
          })),
          summary: {
            direct: allDependents.length,
            viaCalls: callers.length,
            viaImports: importers.length,
          },
        }, null, 2));
        return;
      }

      printResolved(target);
      if (allDependents.length === 0) {
        console.log(`No dependents found for "${target.name}".`);
        return;
      }

      if (callers.length > 0) {
        console.log(chalk.bold(`  via CALLS (${callers.length}):`));
        for (const d of callers) {
          const shortId = d.id?.slice(0, 8) ?? "";
          const name = d.name || d.attrs?.name || d.id;
          console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
        }
      }

      if (importers.length > 0) {
        console.log(chalk.bold(`  via IMPORTS (${importers.length}):`));
        for (const d of importers) {
          const shortId = d.id?.slice(0, 8) ?? "";
          const name = d.name || d.attrs?.name || d.id;
          console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
        }
      }

      console.log(chalk.dim(`\n  Total: ${allDependents.length} direct dependents`));
    });
}
