// Copyright 2026 Ix Infrastructure Inc.

import * as path from "node:path";
import { llmLine } from "./llm.js";
import { graphHealthJson, graphHealthLlmFields } from "./graph-health.js";
import type { AroundRef, AroundResult, AroundSection, AroundSymbol } from "./around.js";

/**
 * Renderers for `ix around`. All three show the same facts; text is also what
 * the post-edit hook hands an agent, so every line of it is paid for in
 * context on every edit -- no section is printed empty, no row twice.
 */

function span(s: { lineStart: number; lineEnd: number }): string {
  return s.lineEnd > s.lineStart ? `${s.lineStart}-${s.lineEnd}` : `${s.lineStart}`;
}

function refText(r: AroundRef): string {
  const where = r.line !== undefined ? `${r.path}:${r.line}` : r.path;
  const via = r.via ? ` (via ${r.via})` : "";
  return r.snippet ? `${where}${via} ${r.snippet}` : `${where}${via}`;
}

function sectionLines(label: string, section: AroundSection, indent: string): string[] {
  if (section.total === 0 || section.rows.length === 0) return [];
  const count = section.rows.length < section.total ? `${section.rows.length} of ${section.total}` : `${section.total}`;
  return [`${label} (${count}):`, ...section.rows.map((r) => `${indent}${refText(r)}`)];
}

export interface AroundTextOptions {
  /** What the first line says before the symbols: "Ix: you changed". */
  lead?: string;
  /** One short closing line, printed only when there is something above it. */
  footer?: string;
  /** Print the file-level importer rows, not just their count. */
  importerRows?: boolean;
}

/** The symbols as the first line names them: `` `name` (path:lines) ``. */
function symbolList(result: AroundResult): string {
  return result.symbols.map((s) => s.declarations
    ? `declarations in \`${s.name}\` outside its methods (${s.path}:${span(s.declarations)})`
    : `\`${s.name}\` (${s.path}:${span(s)})`).join(", ");
}

export function renderAroundText(result: AroundResult, opts: AroundTextOptions = {}): string {
  const lines: string[] = [];
  const lead = opts.lead ?? "Around";
  if (result.symbols.length > 0) {
    lines.push(`${lead} ${symbolList(result)}.`);
  } else {
    lines.push(`${lead} ${result.path}: no definition in the graph covers ${result.lines ? `lines ${span({ lineStart: result.lines.start, lineEnd: result.lines.end })}` : "it"}.`);
  }
  if (result.graph) {
    lines.push(`Graph is ${result.graph.status}: dependents below may be incomplete, not absent.`);
  }
  const many = result.symbols.length > 1;
  for (const s of result.symbols) {
    const p = many ? `\`${s.name}\` ` : "";
    if (s.declarations) {
      // A class's "callers" are mostly references to the type: counted, not listed.
      if (s.callers.total > 0) lines.push(`${p}the ${s.kind} is referenced from ${s.callers.total} place${s.callers.total === 1 ? "" : "s"}.`);
    } else {
      lines.push(...sectionLines(`${p}callers`, s.callers, "  "));
    }
    lines.push(...sectionLines(`${p}used by importers`, s.users, "  "));
    lines.push(...sectionLines(`${p}tests`, s.tests, "  "));
    if (s.sameName.length > 0) {
      lines.push(`${p}same name in file: ${s.sameName.map((o) => `${span(o)} (${o.kind})`).join(", ")}`);
    }
  }
  const imp = result.importers;
  if (imp.total > 0) {
    const tests = imp.tests > 0 ? ` (${imp.tests} test${imp.tests === 1 ? "" : "s"})` : "";
    lines.push(`${path.posix.basename(result.path)} is imported by ${imp.total} file${imp.total === 1 ? "" : "s"}${tests}${opts.importerRows && imp.rows.length > 0 ? ":" : "."}`);
    if (opts.importerRows) {
      for (const r of imp.rows) lines.push(`  ${refText(r)}`);
      const rest = imp.total - imp.tests - imp.rows.length;
      if (rest > 0 && imp.rows.length > 0) lines.push(`  +${rest} more`);
    }
  }
  if (opts.footer && lines.length > 1) lines.push(opts.footer);
  return lines.join("\n");
}

function refFields(r: AroundRef): Array<[string, string | number | undefined]> {
  return [
    ["site", r.line !== undefined ? `${r.path}:${r.line}` : r.path],
    ["name", r.name],
    ["via", r.via],
    ["snippet", r.snippet],
  ];
}

function symbolLlm(s: AroundSymbol, many: boolean): string[] {
  const of: Array<[string, string | undefined]> = [["of", many ? s.name : undefined]];
  return [
    llmLine("symbol", [
      ["name", s.name], ["kind", s.kind], ["path", s.path], ["lines", span(s)],
      ["moved_from", s.movedFrom],
      ["declarations", s.declarations ? span(s.declarations) : undefined],
      ["callers", s.callers.total], ["users", s.users.total], ["tests", s.tests.total],
    ]),
    // Edited declarations of a container: its "callers" are type references, counted above.
    ...(s.declarations ? [] : s.callers.rows.map((r) => llmLine("caller", [...of, ...refFields(r)]))),
    ...s.users.rows.map((r) => llmLine("user", [...of, ...refFields(r)])),
    ...s.tests.rows.map((r) => llmLine("test", [...of, ...refFields(r)])),
    ...s.sameName.map((o) => llmLine("same_name", [...of, ["kind", o.kind], ["lines", span(o)]])),
  ];
}

/**
 * `around path=... symbols=<n>`, then per symbol a `symbol` record carrying
 * the totals and the `caller` / `user` / `test` rows shown, then the file's
 * `importers` header and rows. Fewer rows than a total means the list was cut.
 */
export function renderAroundLlm(result: AroundResult): string[] {
  const many = result.symbols.length > 1;
  const out = [
    llmLine("around", [
      ["path", result.path],
      ["lines", result.lines ? span({ lineStart: result.lines.start, lineEnd: result.lines.end }) : undefined],
      ["symbols", result.symbols.length],
    ]),
  ];
  if (result.graph) out.push(llmLine("graph", graphHealthLlmFields(result.graph)));
  for (const s of result.symbols) out.push(...symbolLlm(s, many));
  if (result.importers.total > 0) {
    out.push(llmLine("importers", [
      ["shown", result.importers.rows.length], ["total", result.importers.total], ["tests", result.importers.tests],
    ]));
    for (const r of result.importers.rows) out.push(llmLine("importer", refFields(r)));
  }
  return out;
}

export function aroundJson(result: AroundResult): Record<string, unknown> {
  const { graph, ...rest } = result;
  return graph ? { ...rest, graph: graphHealthJson(graph) } : rest;
}
