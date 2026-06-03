import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { relativePath } from "../format.js";
import { llmLine } from "../llm.js";

/**
 * Render `ix inventory` as llm records: a header line then one `file` row per
 * source file with its entity names comma-joined (entities without a path
 * become standalone `item` rows). Grouping mirrors the json renderer to avoid
 * repeating the path on every entity.
 */
export function renderInventoryLlm(kind: string, scope: string | null, nodes: any[]): string[] {
  const byFile = new Map<string, string[]>();
  const ungrouped: Array<{ name: string; kind: string }> = [];
  for (const n of nodes) {
    const name = String(n.name || n.attrs?.name || "(unnamed)");
    const rawPath = (n as any).provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path;
    const path = relativePath(rawPath);
    if (path) {
      const names = byFile.get(path) ?? [];
      names.push(name);
      byFile.set(path, names);
    } else {
      ungrouped.push({ name, kind: String(n.kind) });
    }
  }
  const lines = [llmLine("inventory", [["kind", kind], ["scope", scope ?? undefined], ["total", nodes.length]])];
  for (const [path, names] of byFile) {
    lines.push(llmLine("file", [["path", path], ["items", names.join(",")]]));
  }
  for (const u of ungrouped) {
    lines.push(llmLine("item", [["name", u.name], ["kind", u.kind]]));
  }
  return lines;
}

export function registerInventoryCommand(program: Command): void {
  program
    .command("inventory")
    .description("List entities by kind with optional path scoping")
    .requiredOption("--kind <kind>", "Entity kind to list (class, method, function, file, module, etc.)")
    .option("--path <path>", "Filter by source file path substring")
    .option("--limit <n>", "Max results", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
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

      // Pass --path as a server-side scope so the LIMIT is applied AFTER path
      // filtering (otherwise a capped fetch can truncate away the target before
      // the client-side filter below ever sees it). The client-side filter is
      // kept as a fallback for older servers that ignore the scope field.
      let nodes = await client.listByKind(opts.kind, { limit, workspaceId: resolveWorkspaceId(), scope: opts.path });

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
        // Group by file to avoid repeating the same path on every entry
        const byFile = new Map<string, string[]>();
        const ungrouped: Array<{ name: string; kind: string; path?: string }> = [];
        for (const n of nodes) {
          const name = String(n.name || n.attrs?.name || "(unnamed)");
          const rawPath = (n as any).provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path;
          const path = relativePath(rawPath);
          if (path) {
            const existing = byFile.get(path) ?? [];
            existing.push(name);
            byFile.set(path, existing);
          } else {
            ungrouped.push({ name, kind: String(n.kind) });
          }
        }
        const grouped = Array.from(byFile.entries()).map(([path, names]) => ({
          path,
          items: names,
        }));
        const output: any = {
          kind: opts.kind,
          scope: scope ?? undefined,
          total: nodes.length,
          byFile: grouped,
        };
        if (ungrouped.length > 0) output.ungrouped = ungrouped;
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderInventoryLlm(opts.kind, scope, nodes)) console.log(line);
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
