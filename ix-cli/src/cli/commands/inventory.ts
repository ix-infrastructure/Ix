// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { resolveReadSystemId } from "../resolve.js";
import { relativePath } from "../format.js";
import { llmLine } from "../llm.js";
import { normalizePathSeparators } from "../path-match.js";

/**
 * Render `ix inventory` as llm records: a header line then one `file` row per
 * source file with its entity names comma-joined (entities without a path
 * become standalone `item` rows). Grouping mirrors the json renderer to avoid
 * repeating the path on every entity.
 *
 * The header says `shown`, not `total`. The backend applies `--limit` itself,
 * so this side never sees how many entities of that kind exist — it only knows
 * whether the window it asked for came back full. Printing the length of a
 * capped list as a total is the claim that made `ix callers` report 50 callers
 * for a symbol with 212.
 */
export function renderInventoryLlm(
  kind: string, scope: string | null, nodes: any[], truncated = false,
): string[] {
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
  const lines = [llmLine("inventory", [
    ["kind", kind],
    ["scope", scope ?? undefined],
    ["shown", nodes.length],
    ["truncated", truncated || undefined],
  ])];
  if (truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["message", `More than ${nodes.length} ${kind} entities exist. Raise --limit, or narrow with --path.`],
    ]));
  }
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
      const systemId = await resolveReadSystemId(client);
      // Separators only, on both the scope sent to the backend and the
      // client-side fallback below. source_uris are always POSIX, so a Windows
      // `--path src\cli` matched nothing in either place (Ix#636). Case is
      // untouched — see path-match.ts.
      const pathNeedle = opts.path ? normalizePathSeparators(opts.path) : undefined;
      // One past the limit, so a full window is distinguishable from an exact
      // fit. The backend has no count endpoint, so this is the only honest
      // answer available: "there is at least one more".
      let nodes = await client.listByKind(opts.kind, { limit: limit + 1, workspaceId: systemId ? undefined : resolveWorkspaceId(), scope: pathNeedle, systemId });
      const truncated = nodes.length > limit;

      if (pathNeedle) {
        nodes = nodes.filter((n) => {
          const uri = normalizePathSeparators(String(
            (n as any).provenance?.source_uri ??
            n.provenance?.sourceUri ??
            n.attrs?.path ??
            ""
          ));
          return uri.includes(pathNeedle);
        });
      }

      nodes = nodes.slice(0, limit);
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
          shown: nodes.length,
          truncated,
          byFile: grouped,
        };
        if (ungrouped.length > 0) output.ungrouped = ungrouped;
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderInventoryLlm(opts.kind, scope, nodes, truncated)) console.log(line);
        return;
      }

      if (nodes.length === 0) {
        console.log(`No ${opts.kind} entities found${scope ? ` in ${scope}` : ""}.`);
        return;
      }

      const more = truncated ? " (more exist — raise --limit)" : "";
      console.log(`Inventory: ${nodes.length} ${opts.kind} entities${scope ? ` in ${scope}` : ""}${more}`);
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
