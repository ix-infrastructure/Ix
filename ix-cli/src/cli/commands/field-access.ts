// Copyright 2026 Ix Infrastructure Inc.
import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { expandCapped, printJson, relativePath } from "../format.js";
import { llmLine } from "../llm.js";
import { parseCountOption, parsePickOption, STRICT_TARGET_HELP } from "../options.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { resolveFileOrReport } from "../resolve.js";
import { EXIT_CODES_HELP } from "../outcome.js";
import { reportError } from "./around.js";

/** Uses stored sites, never a grep reconstruction or a name-only query. */
export function registerFieldAccessCommands(program: Command): void {
  for (const [name, predicate] of [["writers", "WRITES"], ["readers", "READS"]] as const) {
    program.command(`${name} <field>`)
      .description(`Show functions that ${name === "writers" ? "write" : "read"} Type.field, with access sites`)
      .option("--path <path>", "Restrict the field's defining path")
      .option("--pick <n>", "Pick Nth target candidate (1-based)", parsePickOption)
      .option("--strict", STRICT_TARGET_HELP)
      .option("--limit <n>", "Max access sites to show", "50")
      .option("--offset <n>", OFFSET_FLAG, "0")
      .option("--format <fmt>", "Output format (text|json|llm)", "text")
      .addHelpText("after", `\nExamples:\n  ix ${name} Order.status --format llm\n  ix ${name} Order.status --path src/order.ts\n\nLiteral values retain their source spelling. Symbolic members use value_kind=member.\n${EXIT_CODES_HELP}`)
      .action(async (field: string, opts, cmd: Command) => {
        let limit: number;
        try { limit = parseCountOption(opts.limit, "50"); }
        catch { reportError("invalid_limit", "--limit must be a non-negative integer.", opts.format); return; }
        const offset = parseOffset(opts.offset);
        const client = createClient();
        const target = await resolveFileOrReport(client, field, {
          kind: "field", path: opts.path, pick: opts.pick, strict: opts.strict,
          textAnswerJson: { rows: [], total: 0, truncated: false },
        }, opts.format);
        if (!target) return;
        const result = await client.expand(target.id, { direction: "in", predicates: [predicate], hops: 1 });
        const nodes = new Map(result.nodes.map(n => [n.id, n]));
        const rows: Array<{ function: string; path?: string; line: number; value?: string; value_kind?: string }> = [];
        for (const edge of result.edges) {
          if (edge.predicate !== predicate || edge.dst !== target.id) continue;
          const node = nodes.get(edge.src);
          if (!node || !["function", "method"].includes(node.kind)) continue;
          const path = relativePath(node.path ?? node.attrs?.path ?? node.provenance?.sourceUri);
          for (const site of Array.isArray(edge.attrs?.sites) ? edge.attrs.sites : []) {
            if (!Number.isInteger(site.line) || site.line < 1) continue;
            rows.push({ function: node.name, ...(path ? { path } : {}), line: site.line,
              ...(typeof site.value === "string" ? { value: site.value, value_kind: site.value_kind } : {}) });
          }
        }
        rows.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.line - b.line || a.function.localeCompare(b.function));
        const page = rows.slice(offset, offset + limit);
        const truncated = offset + page.length < rows.length || expandCapped(result);
        const next = limit > 0 && offset + page.length < rows.length ? nextPageCommand(cmd, [field], offset + page.length) : undefined;
        if (opts.format === "json") { printJson({ target: field, rows: page, total: rows.length, truncated, ...(next ? { next } : {}) }); return; }
        if (opts.format === "llm") {
          console.log(llmLine(name, [["target", field], ["shown", page.length], ["total", rows.length], ["truncated", truncated], ...(next ? [["next", next] as [string, string]] : [])]));
          for (const row of page) console.log(llmLine("ref", [["function", row.function], ["site", `${row.path ?? "?"}:${row.line}`], ...(row.value !== undefined ? [["value", row.value], ["value_kind", row.value_kind ?? "literal"]] as Array<[string, string]> : [])]));
          return;
        }
        for (const row of page) console.log(`${row.function}  ${row.path ?? "?"}:${row.line}${row.value !== undefined ? `  = ${row.value}` : ""}`);
        if (!rows.length) console.log(`No ${name} of ${field} in the graph.`);
        if (truncated) console.log(next ? `More sites: ${next}` : "Results capped by graph expansion.");
      });
  }
}
