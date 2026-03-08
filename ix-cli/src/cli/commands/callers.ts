import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { formatEdgeResults } from "../format.js";
import { resolveEntity, printResolved } from "../resolve.js";

const execFileAsync = promisify(execFile);

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix callers verify_token\n  ix callers processPayment --format json\n  ix callers parse --kind method --limit 20")
    .action(async (symbol: string, opts: { kind?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const target = await resolveEntity(client, symbol, ["method", "function"], opts);
      if (!target) return;
      printResolved(target);
      // Use expandByName for cross-file resolution
      const result = await client.expandByName(target.name, {
        direction: "in",
        predicates: ["CALLS"],
        kinds: ["function", "method"],
      });

      if (result.nodes.length === 0) {
        // Fallback to text search
        try {
          const root = resolveWorkspaceRoot();
          const { stdout } = await execFileAsync("rg", [
            "--json", "--max-count", "10", target.name, root,
          ], { maxBuffer: 5 * 1024 * 1024 });

          const textResults: any[] = [];
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "match") {
                const data = parsed.data;
                textResults.push({
                  id: "",
                  kind: "text-match",
                  name: `${data.path?.text ?? ""}:${data.line_number ?? 0}`,
                  attrs: { snippet: data.lines?.text?.trim() ?? "" },
                });
              }
            } catch { /* skip malformed lines */ }
          }

          if (textResults.length > 0) {
            if (opts.format === "json") {
              console.log(JSON.stringify({
                results: textResults,
                resultSource: "text",
                resolvedTarget: target,
                warning: "No graph-backed callers found; showing text-based candidate usages.",
              }, null, 2));
            } else {
              console.log(chalk.dim("No graph-backed callers found. Showing text-based candidate usages.\n"));
              for (const r of textResults.slice(0, 10)) {
                const snippet = r.attrs?.snippet ?? "";
                console.log(`  ${chalk.dim(r.name)}  ${snippet}`);
              }
            }
            return;
          }
        } catch { /* ripgrep not available or no matches */ }

        // Both graph and text empty
        formatEdgeResults([], "callers", target.name, opts.format, target, "graph");
      } else {
        formatEdgeResults(result.nodes.slice(0, limit), "callers", target.name, opts.format, target, "graph");
      }
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix callees processPayment\n  ix callees parse --format json")
    .action(async (symbol: string, opts: { kind?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const calleeLimit = parseInt(opts.limit, 10);
      const target = await resolveEntity(client, symbol, ["method", "function"], opts);
      if (!target) return;
      printResolved(target);
      // Use expandByName for cross-file resolution
      const result = await client.expandByName(target.name, {
        direction: "out",
        predicates: ["CALLS"],
        kinds: ["function", "method"],
      });
      formatEdgeResults(result.nodes.slice(0, calleeLimit), "callees", target.name, opts.format, target, "graph");
    });
}
