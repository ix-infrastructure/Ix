// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine, llmShortId, type LlmValue } from "../llm.js";
import { projectRow } from "../output-shape.js";
import type { EdgeSite } from "../edge-sites.js";
import { emit, type Renderer } from "../output/emit.js";
import { disambiguatingIds, lineSpan, locationLabel, relativePath, rowLocation, siteLabel } from "../output/rows.js";
import { dispatchVia, isPastEnd, isRawIdName, pastEndMessage, truncationHint, type Slice } from "../output/slice.js";
import type { Diagnostic, ResultSource } from "../output/types.js";

/**
 * The candidates an `--all` edge query ran over. Rows carry `candidate: <n>`,
 * numbering into this list.
 */
export interface EdgeCandidate {
  n: number;
  id: string;
  name: string;
  kind: string;
  path?: string;
}

/**
 * Render edge-query results (callers/callees/contains/imports/imported-by) as
 * llm records: a header line keyed by the relation, optional diagnostic lines,
 * then one `ref` row per related entity. Unresolved targets carry resolved=false.
 */
export function renderEdgeResultsLlm(
  slice: Slice<any>, relation: string, symbol: string,
  source?: ResultSource, diagnostics?: Diagnostic[], candidates?: EdgeCandidate[],
): string[] {
  const refs = slice.rows.map((n: any) => {
    const name = n.name || n.attrs?.name || "";
    return {
      resolved: !!name && !isRawIdName(name),
      name,
      kind: n.kind ?? undefined,
      id: n.id ?? undefined,
      site: n.site as EdgeSite | undefined,
      candidate: typeof n.candidate === "number" ? n.candidate as number : undefined,
      via: dispatchVia(n),
      ...rowLocation(n),
    };
  });
  const ids = disambiguatingIds(
    refs,
    (r) => `${r.name}\u0000${r.kind ?? ""}\u0000${r.path ?? ""}`,
    (r) => r.id,
  );
  const unresolved = refs.filter((r) => !r.resolved).length;
  const lines = [llmLine(relation, [
    ["target", symbol],
    ["offset", slice.offset ? slice.offset : undefined],
    ["shown", slice.shown],
    ["total", slice.total],
    ["resolved", refs.length - unresolved],
    ["unresolved", unresolved > 0 ? unresolved : undefined],
    ["source", source && source !== "graph" ? source : undefined],
    ["candidates", candidates ? candidates.length : undefined],
  ])];
  for (const c of candidates ?? []) {
    lines.push(llmLine("candidate", [
      ["n", c.n], ["name", c.name], ["kind", c.kind],
      ["path", c.path ? relativePath(c.path) ?? c.path : undefined], ["id", llmShortId(c.id)],
    ]));
  }
  if (slice.truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["next_offset", slice.nextOffset],
      ["message", truncationHint(slice, relation)],
    ]));
  }
  if (refs.length === 0 && isPastEnd(slice)) {
    lines.push(llmLine("diagnostic", [["code", "offset_past_end"], ["message", pastEndMessage(slice, relation)]]));
  } else if (refs.length === 0 && !slice.truncated && (!diagnostics || diagnostics.length === 0)) {
    lines.push(llmLine("diagnostic", [["code", "no_edges"], ["message", `No ${relation} edges found.`]]));
  }
  for (const d of diagnostics ?? []) {
    lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
  }
  refs.forEach((ref, i) => {
    // Which `--all` candidate the row belongs to. Outside projectRow: a row
    // that lost it under `--fields` could not be attributed at all.
    const tag: Array<[string, LlmValue]> = ref.candidate !== undefined ? [["candidate", ref.candidate]] : [];
    // A dispatch row: the call targets this supertype member.
    if (ref.via !== undefined) tag.push(["via", ref.via]);
    // An unresolved row has no name to go by, so its id is all there is.
    lines.push(ref.resolved
      ? llmLine("ref", [...projectRow([
          ["name", ref.name], ["kind", ref.kind], ["id", ids[i]],
          ["path", ref.path], ["lines", lineSpan(ref)],
          ["site", ref.site ? siteLabel(ref.site) : undefined],
          ["also", ref.site?.also?.join(",")],
          ["snippet", ref.site?.snippet],
        ]), ...tag])
      : llmLine("ref", [...projectRow([["kind", ref.kind], ["id", llmShortId(ref.id)], ["resolved", false]]), ...tag]));
  });
  return lines;
}

/** What `formatEdgeResults` prints: one page of an edge query and how it was resolved. */
export interface EdgeResults {
  slice: Slice<any>;
  relation: string;
  symbol: string;
  resolvedTarget?: { id: string; kind: string; name: string; resolutionMode?: string };
  source?: ResultSource;
  diagnostics?: Diagnostic[];
  candidates?: EdgeCandidate[];
}

/** callers, callees, contains, imports, imported-by, depends and the like. */
export const edgeResultsRenderer: Renderer<EdgeResults> = {
  json: edgeResultsJson,
  llm: ({ slice, relation, symbol, source, diagnostics, candidates }) =>
    renderEdgeResultsLlm(slice, relation, symbol, source, diagnostics, candidates),
  text: printEdgeResultsText,
};

export function formatEdgeResults(
  slice: Slice<any>, relation: string, symbol: string, format: string,
  resolvedTarget?: { id: string; kind: string; name: string; resolutionMode?: string },
  source?: ResultSource,
  diagnostics?: Diagnostic[],
  candidates?: EdgeCandidate[],
): void {
  emit(edgeResultsRenderer, { slice, relation, symbol, resolvedTarget, source, diagnostics, candidates }, format);
}

function edgeResultsJson({ slice, relation, resolvedTarget, source, diagnostics, candidates }: EdgeResults): unknown {
  const nodes = slice.rows;

  const results = nodes.map((n: any) => {
    const name = n.name || n.attrs?.name || "";
    const resolved = !!name && !isRawIdName(name);
    const ref: any = {
      name: resolved ? name : undefined,
      kind: n.kind ?? undefined,
      id: resolved ? n.id : undefined,
      ...rowLocation(n),
      ...(n.site ? { site: n.site } : {}),
      ...(typeof n.candidate === "number" ? { candidate: n.candidate } : {}),
      ...(dispatchVia(n) ? { via: dispatchVia(n) } : {}),
    };
    if (!resolved) {
      ref.resolved = false;
      if (n.id) {
        ref.rawId = n.id;
        ref.diagnostic = "unresolved_call_target";
      }
    }
    return ref;
  });

  const output: any = {
    results,
    resultSource: source ?? "graph",
  };
  if (resolvedTarget) {
    output.resolvedTarget = {
      ...resolvedTarget,
      path: relativePath((resolvedTarget as any).path),
    };
    if (resolvedTarget.resolutionMode && resolvedTarget.resolutionMode !== "exact") {
      output.resolutionMode = resolvedTarget.resolutionMode;
    }
  }
  if (candidates) {
    output.resolutionMode = "all";
    output.candidates = candidates.map((c) => ({ ...c, path: relativePath(c.path) ?? c.path }));
  }
  if (nodes.length === 0) {
    output.diagnostics = isPastEnd(slice)
      ? [{ code: "offset_past_end", message: pastEndMessage(slice, relation) }]
      : diagnostics ?? (slice.truncated ? undefined : [{ code: "no_edges", message: `No ${relation} edges found for resolved entity.` }]);
  } else if (diagnostics && diagnostics.length > 0) {
    output.diagnostics = diagnostics;
  }
  if (slice.truncated) {
    output.diagnostics = [
      ...(output.diagnostics ?? []),
      { code: "results_truncated", message: truncationHint(slice, relation) },
    ];
  }
  const unresolvedCount = results.filter((r: any) => r.resolved === false).length;
  if (unresolvedCount > 0) {
    output.diagnostics = [
      ...(output.diagnostics ?? []),
      { code: "dangling_reference_filtered", message: `${unresolvedCount} result(s) could not be resolved to named entities.` },
    ];
  }
  output.summary = {
    shown: slice.shown,
    total: slice.total,
    resolved: results.length - unresolvedCount,
    unresolved: unresolvedCount,
    truncated: slice.truncated,
    offset: slice.offset ?? 0,
    ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
    // `total` is then a lower bound: the server stopped at its edge cap.
    ...(slice.capped ? { capped: true } : {}),
  };
  return output;
}

function printEdgeResultsText({ slice, relation, symbol, source, diagnostics, candidates }: EdgeResults): void {
  const nodes = slice.rows;
  if (nodes.length === 0) {
    const reason = isPastEnd(slice)
      ? pastEndMessage(slice, relation)
      : slice.truncated
        ? truncationHint(slice, relation)
        : diagnostics?.[0]?.message ?? `No ${relation} found for "${symbol}".`;
    console.log(reason);
    return;
  }
  console.log(`${chalk.bold(relation)} of ${chalk.cyan(symbol)}:`);
  if (source && source !== "graph") {
    console.log(chalk.dim(`Source: ${source}`));
  }
  for (const c of candidates ?? []) {
    const where = c.path ? ` in ${relativePath(c.path) ?? c.path}` : "";
    console.log(chalk.dim(`  [${c.n}] ${c.kind} ${c.name}${where}`));
  }
  for (const n of nodes) {
    const name = n.name || n.attrs?.name || "";
    const shortId = n.id?.slice(0, 8) ?? "";
    if (!name || isRawIdName(name)) {
      console.log(`  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.dim("(unresolved)")}`);
    } else {
      const where = locationLabel(rowLocation(n));
      console.log(
        `  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`
        + (where ? `  ${chalk.dim(where)}` : "")
        + (typeof n.candidate === "number" ? `  ${chalk.dim(`[${n.candidate}]`)}` : "")
        + (dispatchVia(n) ? `  ${chalk.dim(`(via ${dispatchVia(n)})`)}` : ""),
      );
      const site = n.site as EdgeSite | undefined;
      if (site) console.log(`      ${chalk.dim(`at ${siteLabel(site)}`)}  ${site.snippet}`);
    }
  }
  if (slice.truncated) console.log(chalk.dim(`  ${truncationHint(slice, relation)}`));
}
