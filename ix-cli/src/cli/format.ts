import chalk from "chalk";
import { resolve } from "path";
import { llmLine } from "./llm.js";

export type ResultSource = "graph" | "text" | "graph+text" | "heuristic";

// ── JSON optimization helpers ──────────────────────────────────────────────

/**
 * Strip the cwd prefix from absolute paths to save tokens in JSON output.
 *
 * Under the client-agnostic backend design, source_uri values are already
 * workspace-relative. For those we return the input unchanged. Legacy absolute
 * paths (e.g. from older graphs) are still handled the old way.
 */
export function relativePath(absPath: string | undefined | null): string | undefined {
  if (!absPath) return undefined;
  // Already relative (workspace-relative path from post-migration graphs).
  if (!absPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(absPath)) return absPath;
  const cwd = process.cwd();
  if (absPath.startsWith(cwd + "/")) return absPath.slice(cwd.length + 1);
  // Also handle /Users/.../project/ style without trailing slash match
  const home = process.env.HOME;
  if (home && absPath.startsWith(home)) {
    return "~" + absPath.slice(home.length);
  }
  return absPath;
}

/** Round a number to N decimal places (default 2). */
export function roundFloat(n: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/** Remove keys with null/undefined values from an object (shallow). */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) result[k] = v;
  }
  return result as Partial<T>;
}

/** Compact a tree node for JSON output — drops UUIDs, resolved:true, sourceEdge, uses relative paths. */
export function compactTreeNode(node: any): any {
  const out: any = { name: node.name, kind: node.kind };
  if (node.relation) out.rel = node.relation;
  if (node.path) out.path = relativePath(node.path);
  if (node.cycle) out.cycle = true;
  if (node.resolved === false) out.resolved = false;
  if (node.children?.length > 0) {
    out.children = node.children.map(compactTreeNode);
  }
  return out;
}

export function confidenceColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.5) return chalk.yellow;
  return chalk.red;
}

export function formatContext(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text format
  const { claims, conflicts, decisions, intents, metadata } = result;

  console.log(
    "\n" + chalk.bold.cyan(`--- Ix Context: "${metadata.query}" ---`)
  );
  console.log(
    chalk.dim(
      `Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`
    )
  );

  const useCompact = result.compactClaims?.length > 0;
  const displayClaims = useCompact ? result.compactClaims : (claims || []);
  const maxShow = 10;

  if (displayClaims.length > 0) {
    console.log(chalk.bold("\nClaims:"));
    displayClaims.slice(0, maxShow).forEach((c: any) => {
      if (useCompact) {
        const pct = Math.round((c.score ?? 0) * 100);
        const color = confidenceColor(c.score ?? 0);
        const loc = c.lineRange ? `:${c.lineRange[0]}-${c.lineRange[1]}` : '';
        const pathStr = c.path ? chalk.dim(` (${c.path}${loc})`) : '';
        console.log(`  ${color(`[${pct}%]`)} ${c.field}${pathStr}`);
      } else {
        const pct = Math.round((c.finalScore ?? 0) * 100);
        const color = confidenceColor(c.finalScore ?? 0);
        console.log(`  ${color(`[${pct}%]`)} ${c.claim?.statement || 'unknown'}`);
      }
    });
    if (displayClaims.length > maxShow) {
      console.log(chalk.dim(`  ... and ${displayClaims.length - maxShow} more`));
    }
  }

  if (conflicts && conflicts.length > 0) {
    console.log(`\nConflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(
        `  ${chalk.red.bold("!")} ${c.reason}: ${c.recommendation}`
      );
    }
  }

  if (decisions && decisions.length > 0) {
    console.log(`\nDecisions (${decisions.length}):`);
    for (const d of decisions) {
      console.log(`  ${chalk.blue("*")} ${d.title}: ${d.rationale}`);
    }
  }

  if (intents && intents.length > 0) {
    console.log(`\nIntents (${intents.length}):`);
    for (const i of intents) {
      console.log(
        `  ${chalk.magenta(">")} ${i.statement} [${i.status}]`
      );
    }
  }
  console.log();
}

/** Render a flat node list as llm `node` records. */
export function renderNodesLlm(nodes: any[]): string[] {
  return nodes.map((n) => llmLine("node", [
    ["kind", n.kind],
    ["id", typeof n.id === "string" ? n.id.slice(0, 8) : undefined],
    ["name", n.name || n.attrs?.name || n.attrs?.title || "(unnamed)"],
  ]));
}

export function formatNodes(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (format === "llm") {
    for (const line of renderNodesLlm(nodes)) console.log(line);
    return;
  }
  if (nodes.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const name = n.name || n.attrs?.name || n.attrs?.title || "(unnamed)";
    if (n.kind === "decision") {
      console.log(
        `  ${chalk.blue("decision")}  ${chalk.dim(shortId)}  ${name}`
      );
    } else {
      console.log(
        `  ${chalk.cyan(n.kind.padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`
      );
    }
  }
}

export function formatDecisions(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No decisions found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const rationale = n.attrs?.rationale ?? "";
    console.log(
      `  ${chalk.blue("*")} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
    if (rationale) {
      console.log(`    ${chalk.gray(rationale)}`);
    }
  }
}

const BUG_STATUS_ICONS: Record<string, string> = {
  open: "○",
  investigating: "◐",
  resolved: "●",
  closed: "✓",
};

export function formatBugs(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No bugs found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const status = n.attrs?.status ?? "open";
    const severity = n.attrs?.severity ?? "medium";
    const icon = BUG_STATUS_ICONS[status] ?? "?";
    console.log(
      `  ${icon} ${chalk.dim(`[${status}]`.padEnd(16))} ${chalk.red(severity.padEnd(8))} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
  }
}

/** Render patch records as llm `patch` lines. */
export function renderPatchesLlm(patches: any[]): string[] {
  return patches.map((p) => llmLine("patch", [
    ["rev", p.rev],
    ["id", p.patch_id?.slice(0, 12)],
    ["intent", p.intent || undefined],
    ["ts", p.timestamp],
    ["source", relativePath(p.source?.uri) || undefined],
  ]));
}

export function formatPatches(patches: any[], format: string): void {
  if (format === "json") {
    const compact = patches.map(p => ({
      rev: p.rev,
      patch_id: p.patch_id?.slice(0, 12),
      intent: p.intent || undefined,
      timestamp: p.timestamp,
      source: relativePath(p.source?.uri) || undefined,
    }));
    console.log(JSON.stringify(compact, null, 2));
    return;
  }
  if (format === "llm") {
    for (const line of renderPatchesLlm(patches)) console.log(line);
    return;
  }
  if (patches.length === 0) {
    console.log("No patches found.");
    return;
  }
  for (const p of patches) {
    const shortPatchId =
      p.patch_id.length > 8 ? p.patch_id.slice(0, 8) : p.patch_id;
    const intentPart = p.intent
      ? chalk.white(p.intent)
      : chalk.dim("(no intent)");
    console.log(
      `  rev ${chalk.cyan.bold(String(p.rev))}  ${chalk.dim(shortPatchId)}  ${intentPart}`
    );
  }
}

export function formatIntents(intents: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(intents, null, 2));
    return;
  }
  if (intents.length === 0) {
    console.log("No intents found.");
    return;
  }

  // Build parent-child map
  const childrenMap = new Map<string, any[]>();
  const roots: any[] = [];

  for (const intent of intents) {
    const parentId = intent.attrs?.parent_intent ?? intent.parentIntent;
    if (parentId) {
      const siblings = childrenMap.get(parentId) || [];
      siblings.push(intent);
      childrenMap.set(parentId, siblings);
    } else {
      roots.push(intent);
    }
  }

  function printIntent(intent: any, indent: string, isChild: boolean): void {
    const prefix = isChild
      ? `${indent}${chalk.dim("\u2514\u2500")} `
      : `${indent}${chalk.magenta(">")} `;
    const statement = intent.attrs?.statement ?? intent.statement ?? "(unknown)";
    const status = intent.attrs?.status ?? intent.status ?? "unknown";
    const conf = intent.attrs?.confidence ?? intent.confidence ?? 0;
    const pctStr = `(${(conf * 100).toFixed(0)}%)`;
    const color = confidenceColor(conf);
    console.log(
      `${prefix}${statement} [${status}] ${color(pctStr)}`
    );

    const children = childrenMap.get(intent.id) || [];
    for (const child of children) {
      printIntent(child, indent + "  ", true);
    }
  }

  for (const root of roots) {
    printIntent(root, "  ", false);
  }
}

/** Render a revision diff as llm records: a header then one `change` row per entity change. */
export function renderDiffLlm(result: any): string[] {
  const changes = result.changes ?? [];
  const lines = [llmLine("diff", [["from", result.fromRev], ["to", result.toRev], ["changes", changes.length]])];
  for (const c of changes) {
    const node = c.changeType === "removed" ? c.atFromRev : c.atToRev;
    const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
    lines.push(llmLine("change", [
      ["type", c.changeType],
      ["kind", node?.kind],
      ["name", name],
      ["summary", c.summary || undefined],
    ]));
  }
  return lines;
}

export function formatDiff(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "llm") {
    for (const line of renderDiffLlm(result)) console.log(line);
    return;
  }
  console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
  if (!result.changes?.length) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }

  const added = result.changes.filter((c: any) => c.changeType === "added");
  const modified = result.changes.filter((c: any) => c.changeType === "modified");
  const removed = result.changes.filter((c: any) => c.changeType === "removed");
  const legacy = result.changes.filter((c: any) => c.changeType === "added_or_modified");

  if (added.length > 0) {
    console.log(chalk.green.bold(`\n  Added (${added.length}):`));
    for (const c of added) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.green("+")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (modified.length > 0) {
    console.log(chalk.yellow.bold(`\n  Modified (${modified.length}):`));
    for (const c of modified) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (removed.length > 0) {
    console.log(chalk.red.bold(`\n  Removed (${removed.length}):`));
    for (const c of removed) {
      const node = c.atFromRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.red("-")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }

  if (legacy.length > 0) {
    console.log(chalk.yellow.bold(`\n  Changed (${legacy.length}):`));
    for (const c of legacy) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }
  console.log();
}

export interface TextResult {
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  engine: string;
  score: number;
  language?: string;
  symbol_hint?: string;
}

/** Render lexical search hits as llm `match` records (one per line). */
export function renderTextResultsLlm(results: TextResult[]): string[] {
  return results.map((r) => llmLine("match", [
    ["path", relativePath(r.path) ?? r.path],
    ["line", r.line_start],
    ["lang", r.language],
    ["symbol", r.symbol_hint],
    ["snippet", r.snippet.trim()],
  ]));
}

export function formatTextResults(results: TextResult[], format: string): void {
  if (format === "json") {
    const compact = results.map(r => ({
      ...r,
      path: relativePath(r.path) ?? r.path,
    }));
    console.log(JSON.stringify(compact, null, 2));
    return;
  }
  if (format === "llm") {
    for (const line of renderTextResultsLlm(results)) console.log(line);
    return;
  }
  if (results.length === 0) {
    console.log("No text matches found.");
    return;
  }
  for (const r of results) {
    const lang = r.language ? chalk.magenta(`[${r.language}]`) + " " : "";
    const sym = r.symbol_hint ? chalk.yellow(`(${r.symbol_hint})`) + " " : "";
    console.log(
      `  ${lang}${chalk.dim(r.path)}${chalk.cyan(":" + r.line_start)}  ${sym}${r.snippet.trim()}`
    );
  }
}

export interface LocateResult {
  kind: string;
  id?: string;
  name: string;
  file?: string;
  line?: number;
  source: "graph" | "ripgrep";
}

export function formatLocateResults(results: LocateResult[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const r of results) {
    const shortId = r.id ? chalk.dim(r.id.slice(0, 8)) + "  " : "";
    const filePart = r.file ? chalk.dim(r.file) + (r.line ? chalk.cyan(`:${r.line}`) : "") : "";
    console.log(`  ${chalk.cyan(r.kind)}  ${shortId}${chalk.bold(r.name)}`);
    if (filePart) {
      console.log(`    ${filePart}`);
    }
  }
}

/**
 * Render edge-query results (callers/callees/contains/imports/imported-by) as
 * llm records: a header line keyed by the relation, optional diagnostic lines,
 * then one `ref` row per related entity. Unresolved targets carry resolved=false.
 */
export function renderEdgeResultsLlm(
  nodes: any[], relation: string, symbol: string,
  source?: ResultSource, diagnostics?: Diagnostic[]
): string[] {
  const isRawId = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{32,}$/i.test(s);
  const refs = nodes.map((n: any) => {
    const name = n.name || n.attrs?.name || "";
    return {
      resolved: !!name && !isRawId(name),
      name,
      kind: n.kind ?? undefined,
      id: n.id ?? undefined,
      path: relativePath(n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path ?? undefined),
    };
  });
  const unresolved = refs.filter((r) => !r.resolved).length;
  const lines = [llmLine(relation, [
    ["target", symbol],
    ["total", refs.length],
    ["resolved", refs.length - unresolved],
    ["unresolved", unresolved > 0 ? unresolved : undefined],
    ["source", source && source !== "graph" ? source : undefined],
  ])];
  if (refs.length === 0 && (!diagnostics || diagnostics.length === 0)) {
    lines.push(llmLine("diagnostic", [["code", "no_edges"], ["message", `No ${relation} edges found.`]]));
  }
  for (const d of diagnostics ?? []) {
    lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
  }
  for (const ref of refs) {
    lines.push(ref.resolved
      ? llmLine("ref", [["name", ref.name], ["kind", ref.kind], ["id", ref.id?.slice(0, 8)], ["path", ref.path]])
      : llmLine("ref", [["kind", ref.kind], ["id", ref.id?.slice(0, 8)], ["resolved", false]]));
  }
  return lines;
}

export function formatEdgeResults(
  nodes: any[], relation: string, symbol: string, format: string,
  resolvedTarget?: { id: string; kind: string; name: string; resolutionMode?: string },
  source?: ResultSource,
  diagnostics?: Diagnostic[]
): void {
  // Check for UUID-like names that indicate unresolved references
  const isRawId = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^[0-9a-f]{32,}$/i.test(s);

  if (format === "llm") {
    for (const line of renderEdgeResultsLlm(nodes, relation, symbol, source, diagnostics)) {
      console.log(line);
    }
    return;
  }

  if (format === "json") {
    const results = nodes.map((n: any) => {
      const name = n.name || n.attrs?.name || "";
      const resolved = !!name && !isRawId(name);
      const ref: any = {
        name: resolved ? name : undefined,
        kind: n.kind ?? undefined,
        id: resolved ? n.id : undefined,
        path: relativePath(n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path ?? undefined),
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
    if (nodes.length === 0) {
      output.diagnostics = diagnostics ?? [{ code: "no_edges", message: `No ${relation} edges found for resolved entity.` }];
    } else if (diagnostics && diagnostics.length > 0) {
      output.diagnostics = diagnostics;
    }
    const unresolvedCount = results.filter((r: any) => r.resolved === false).length;
    if (unresolvedCount > 0) {
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        { code: "dangling_reference_filtered", message: `${unresolvedCount} result(s) could not be resolved to named entities.` },
      ];
    }
    output.summary = { total: results.length, resolved: results.length - unresolvedCount, unresolved: unresolvedCount };
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (nodes.length === 0) {
    const reason = diagnostics?.[0]?.message ?? `No ${relation} found for "${symbol}".`;
    console.log(reason);
    return;
  }
  console.log(`${chalk.bold(relation)} of ${chalk.cyan(symbol)}:`);
  if (source && source !== "graph") {
    console.log(chalk.dim(`Source: ${source}`));
  }
  for (const n of nodes) {
    const name = n.name || n.attrs?.name || "";
    const shortId = n.id?.slice(0, 8) ?? "";
    if (!name || isRawId(name)) {
      console.log(`  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.dim("(unresolved)")}`);
    } else {
      console.log(`  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`);
    }
  }
}

/** Render detected conflicts as llm `conflict` records. */
export function renderConflictsLlm(conflicts: any[]): string[] {
  const lines = [llmLine("conflicts", [["count", conflicts.length]])];
  for (const c of conflicts) {
    lines.push(llmLine("conflict", [
      ["reason", c.reason],
      ["recommendation", c.recommendation],
      ["claim_a", c.claimA],
      ["claim_b", c.claimB],
    ]));
  }
  return lines;
}

export function formatConflicts(conflicts: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
  if (format === "llm") {
    for (const line of renderConflictsLlm(conflicts)) console.log(line);
    return;
  }
  if (conflicts.length === 0) {
    console.log("No conflicts detected.");
    return;
  }
  for (const c of conflicts) {
    console.log(`  ${chalk.red.bold("!")} ${c.reason}`);
    console.log(`    ${chalk.yellow(c.recommendation)}`);
    console.log(`    Claims: ${c.claimA} vs ${c.claimB}`);
  }
}

/** A resolved or unresolved reference to a related entity. */
export interface EntityRef {
  name: string;
  kind?: string;
  id?: string;
  resolved: boolean;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  suggestedCommand?: string;
}

export type DiagnosticCode =
  | "unresolved_call_target"
  | "parser_gap_suspected"
  | "dangling_reference_filtered"
  | "ambiguous_resolution"
  | "no_edges"
  | "text_fallback_used"
  | "stale_source"
  | "unfiltered_search";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
}

export interface ExplainResult {
  kind: string;
  name: string;
  id: string;
  file?: string;
  chunkKind?: string;
  container?: { kind: string; name: string };
  introducedRev: number;
  calledBy: number;
  calls: number;
  contains: number;
  historyLength: number;
  signature?: string;
  docstring?: string;
  callList?: EntityRef[];
  diagnostics?: Diagnostic[];
}

export function formatExplain(result: ExplainResult, format: string): void {
  if (format === "json") {
    const output: any = {
      resolvedTarget: { id: result.id, kind: result.kind, name: result.name },
      result: stripNulls({
        kind: result.kind,
        name: result.name,
        id: result.id,
        file: relativePath(result.file),
        chunkKind: result.chunkKind ?? null,
        container: result.container,
        introducedRev: result.introducedRev,
        calledBy: result.calledBy,
        calls: result.calls,
        contains: result.contains,
        historyLength: result.historyLength,
        signature: result.signature ?? null,
        docstring: result.docstring ?? null,
        callList: result.callList,
      }),
    };
    if (result.diagnostics && result.diagnostics.length > 0) {
      output.diagnostics = result.diagnostics;
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const shortId = result.id.slice(0, 8);
  if (result.signature) {
    console.log(`  ${chalk.green(result.signature)}`);
  } else {
    console.log(`  ${chalk.cyan(result.kind)} ${chalk.bold(result.name)} ${chalk.dim(shortId)}`);
  }
  if (result.docstring) {
    console.log(`  ${chalk.dim('"' + result.docstring + '"')}`);
  }
  if (result.container) {
    console.log(`  ${chalk.dim("in")} ${chalk.cyan(result.container.kind)} ${result.container.name}`);
  }
  if (result.file) {
    console.log(`  ${chalk.dim("file")} ${result.file}`);
  }
  if (result.chunkKind) {
    console.log(`  ${chalk.dim("chunk kind")} ${result.chunkKind}`);
  }
  console.log(`  ${chalk.dim("introduced rev")} ${result.introducedRev}`);
  if (result.calledBy > 0) console.log(`  ${chalk.dim("called by")} ${result.calledBy} methods`);
  if (result.callList && result.callList.length > 0) {
    console.log(`  ${chalk.dim("calls:")}`);
    for (const c of result.callList) {
      const label = c.resolved
        ? c.name
        : chalk.dim(`${c.name} (unresolved)`);
      console.log(`    ${label}`);
    }
  } else if (result.calls > 0) {
    console.log(`  ${chalk.dim("calls")} ${result.calls} methods`);
  }
  if (result.contains > 0) console.log(`  ${chalk.dim("contains")} ${result.contains} members`);
  if (result.historyLength > 0) console.log(`  ${chalk.dim("history")} ${result.historyLength} patches`);
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      console.log(`  ${chalk.dim(`[${d.code}]`)} ${d.message}`);
    }
  }
}
