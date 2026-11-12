// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from "node:crypto";
import type { buildBundle } from "./commands/context.js";
import { isGenericIdentifier, type LeanIssueView, type StartingPoint } from "./explain/issue.js";
import { isTestPath } from "./explain/related-files.js";
import { llmLine } from "./llm.js";

export const PRECISE_CONTEXT_SCHEMA = "ix-context/1";
export const DEFAULT_CONTEXT_ITEMS = 8;
export const CONTEXT_CONFIDENCE_FLOOR = 0.55;
export const CONTEXT_SPAN_LINES = 120;

/** Confidence is a selection heuristic, not a calibrated probability. */
export interface ContextCandidate {
  name: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  reason: string;
  confidence: number;
  stale?: boolean;
}

export interface ContextItem extends ContextCandidate {
  path: string;
  lineStart: number;
  lineEnd: number;
  span: string;
}

export interface ContextPage {
  schema: typeof PRECISE_CONTEXT_SCHEMA;
  items: ContextItem[];
  selection: {
    returned: number;
    eligible: number;
    belowConfidence: number;
    missingSpan: number;
    remaining: number;
    confidenceFloor: number;
    cursor?: string;
    more?: string;
  };
}

export interface ContextSelectionOptions {
  limit?: number;
  cursor?: string;
  maxChars?: number;
  issueQuery?: string;
  /** Only used to locate bounded excerpts when the graph has no lines. */
  read?: (path: string) => string | undefined;
}

/** Validate without silently coercing an invalid cursor or page size. */
export function contextItemLimit(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) {
    throw new Error("--limit must be an integer from 1 to 50");
  }
  return Number(value);
}

/**
 * One selector for target, issue, lean, and offline ranking evaluation.
 * Missing locations are dropped, never replaced with guessed line numbers.
 * A cursor is tied to the ordered candidates, so a changed graph cannot silently
 * move a reader to an unrelated offset. Re-run the original query to page.
 */
export function selectContextItems(candidates: ContextCandidate[], options: ContextSelectionOptions = {}): ContextPage {
  const limit = contextItemLimit(String(options.limit ?? DEFAULT_CONTEXT_ITEMS));
  const located = new Map<string, ContextItem>();
  let belowConfidence = 0, missingSpan = 0;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < CONTEXT_CONFIDENCE_FLOOR) {
      belowConfidence++;
      continue;
    }
    const { path, lineStart, lineEnd = lineStart } = candidate;
    if (!path || !Number.isInteger(lineStart) || lineStart! < 1
      || !Number.isInteger(lineEnd) || lineEnd! < lineStart! || !candidate.reason) {
      missingSpan++;
      continue;
    }
    const end = Math.min(lineEnd!, lineStart! + CONTEXT_SPAN_LINES - 1);
    const span = `${path}:${lineStart}-${end}`;
    const prior = located.get(span);
    if (!prior || candidate.confidence > prior.confidence) {
      located.set(span, { ...candidate, reason: candidate.reason.slice(0, 240), confidence: Math.min(1, candidate.confidence), path,
        lineStart: lineStart!, lineEnd: end, span });
    }
  }
  // Stable input order breaks ties, preserving the established issue ranking.
  const ranked = [...located.values()].sort((a, b) => b.confidence - a.confidence);
  const digest = createHash("sha256").update(JSON.stringify(ranked)).digest("hex").slice(0, 16);
  let offset = 0;
  if (options.cursor !== undefined) {
    const match = /^(\d+)\.([a-f0-9]{16})$/.exec(options.cursor);
    if (!match || match[2] !== digest || !Number.isSafeInteger(Number(match[1]))
      || Number(match[1]) < 1 || Number(match[1]) >= ranked.length) {
      throw new Error("Invalid or expired context cursor; rerun the original query without --cursor");
    }
    offset = Number(match[1]);
  }
  const items = ranked.slice(offset, offset + limit);
  const remaining = ranked.length - offset - items.length;
  const cursor = remaining ? `${offset + items.length}.${digest}` : undefined;
  const page: ContextPage = {
    schema: PRECISE_CONTEXT_SCHEMA, items,
    selection: {
      returned: items.length, eligible: ranked.length, belowConfidence, missingSpan, remaining,
      confidenceFloor: CONTEXT_CONFIDENCE_FLOOR,
      ...(cursor ? { cursor, more: `Repeat this query with --cursor ${cursor} (or MCP cursor); --limit 1..50 changes page size` } : {}),
    },
  };
  // Use the larger JSON representation for both formats. The CLI reserves
  // space for target/freshness metadata before passing this budget.
  if (options.maxChars !== undefined
    && Math.max(JSON.stringify(page, null, 2).length, preciseContextLlmLines(page).join("\n").length) > options.maxChars) {
    if (items.length > 1) return selectContextItems(candidates, { ...options, limit: limit - 1 });
    throw new Error("Context metadata/item exceeds the output budget; increase --max-chars or --max-tokens");
  }
  return page;
}

type Bundle = ReturnType<typeof buildBundle>;

/** A weak positive BM25 match alone is not enough to spend an item slot. */
function lexicalConfidence(score: number, best: number): number {
  return score > 0 && best > 0 ? Math.round(1000 * (0.4 + 0.2 * Math.min(1, score / best))) / 1000 : 0.4;
}

function startCandidate(s: StartingPoint): ContextCandidate {
  return { name: s.name, path: s.path, lineStart: s.lineStart, lineEnd: s.lineEnd,
    reason: `${s.via}: ${s.token}`,
    confidence: s.snippet ? 0.45 : s.traceback ? 0.92 : s.via === "path in issue" ? 0.99
      : s.via === "bm25 fallback" || isGenericIdentifier(s.token) ? 0.6 : 0.98 };
}

/** Read only source excerpts through the caller's tracked-file reader. */
function excerpt(candidate: ContextCandidate, read?: ContextSelectionOptions["read"], query?: string): ContextCandidate {
  if (candidate.confidence < CONTEXT_CONFIDENCE_FLOOR || candidate.lineStart !== undefined || !candidate.path || !read) return candidate;
  if (/(^|\/)\.env(?:\.|$)/.test(candidate.path)) return candidate;
  if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|scala|rb|php|cs|c|h|cpp|hpp|swift|svelte|vue)$/.test(candidate.path)) return candidate;
  const text = read(candidate.path);
  if (text === undefined) return candidate;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) return candidate;
  const nameLine = lines.findIndex((line) => line.includes(candidate.name));
  const terms = [...new Set((query?.toLowerCase().match(/[a-z_]\w{3,}/g) ?? [])
    .filter((term) => !/^(?:this|that|with|from|when|then|should|would|could|does|have|after|before|issue|error)$/.test(term)))].slice(0, 25);
  let bestLine = -1, matched: string[] = [];
  for (const [i, line] of lines.entries()) {
    const hits = terms.filter((t) => line.toLowerCase().includes(t));
    if (hits.length > matched.length) { bestLine = i; matched = hits; }
  }
  const lineStart = (nameLine >= 0 ? nameLine : bestLine >= 0 ? bestLine : 0) + 1;
  return { ...candidate, lineStart, lineEnd: Math.min(lines.length, lineStart + 39),
    reason: `${matched.length ? `issue terms: ${matched.slice(0, 3).join(", ")}; ` : ""}${candidate.reason}; ${nameLine >= 0 ? `excerpt at ${candidate.name}` : bestLine >= 0 ? "matching excerpt" : "file header excerpt"}` };
}

/** Build code candidates without changing the legacy evidence row grammar. */
export function bundleContextCandidates(bundle: Bundle, options: ContextSelectionOptions = {}): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  const starts = bundle.issue?.startingPoints ?? [];
  const namedPaths = new Set(starts.map((s) => s.path));
  const seedIds = new Set([bundle.target.id, ...starts.flatMap((s) => s.id ? [s.id] : [])]);
  const fileDefinition = !bundle.issue && bundle.target.kind === "file"
    ? bundle.entities.find((e) => e.path === bundle.target.path && e.lineStart) : undefined;
  if (fileDefinition) candidates.push({ name: fileDefinition.name, path: fileDefinition.path,
    lineStart: fileDefinition.lineStart, lineEnd: fileDefinition.lineEnd, stale: fileDefinition.stale,
    confidence: 0.98, reason: `resolved file ${bundle.target.path}; definition ${fileDefinition.name}` });
  for (const start of starts) {
    // A file's located definition is more useful than a file-wide range.
    const definition = bundle.entities.filter((e) => e.path === start.path && e.lineStart)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    candidates.push(excerpt({ ...startCandidate(start),
      ...(start.lineStart === undefined && definition ? {
        name: definition.name, lineStart: definition.lineStart, lineEnd: definition.lineEnd,
        reason: `${start.via}: ${start.token}; definition ${definition.name} in named file`,
      } : {}) }, options.read, options.issueQuery));
  }
  for (const entity of bundle.entities) {
    if (entity.id === bundle.target.id && fileDefinition && !entity.lineStart) continue;
    const row = bundle.evidence.find((e) => e.refs.includes(entity.id));
    const relations = bundle.relationships.filter((r) =>
      (seedIds.has(r.src) && r.dst === entity.id) || (seedIds.has(r.dst) && r.src === entity.id));
    const direct = relations.find((r) => /^(CALLS|IMPORTS|REFERENCES)$/.test(r.predicate)) ?? relations[0];
    let confidence = 0.35;
    let reason = "graph context without a direct selection relation";
    if (entity.id === bundle.target.id && !bundle.issue) {
      confidence = 0.98; reason = `resolved target: ${bundle.target.name}`;
    } else if (direct && /^(CALLS|IMPORTS|REFERENCES)$/.test(direct.predicate)) {
      confidence = isTestPath(entity.path ?? "") ? 0.75 : 0.85;
      reason = `${direct.predicate}: ${bundle.entities.find((e) => e.id === (direct.src === entity.id ? direct.dst : direct.src))?.name ?? bundle.target.name}`;
    } else if (direct) {
      confidence = 0.7;
      reason = `${direct.predicate}: ${bundle.target.name}`;
    } else if (row?.source.startsWith("facts.")) {
      confidence = /callers|callees|imports|dependents/.test(row.source) ? 0.85 : 0.7;
      if (isTestPath(entity.path ?? "")) confidence = 0.65;
      reason = `${row.reason}: ${bundle.target.name}`;
    } else if (namedPaths.has(entity.path ?? "") && (entity.score ?? 0) > 0) {
      confidence = 0.68; reason = `issue identifier match: ${entity.name}`;
    }
    candidates.push(excerpt({ name: entity.name, path: entity.path, lineStart: entity.lineStart,
      lineEnd: entity.lineEnd, reason, confidence, stale: entity.stale }, options.read, options.issueQuery));
  }
  // Lexical/companion files follow named starts, direct edges and tests. Do not
  // promote all definitions in a lexical hit: one bounded excerpt per file.
  const bestFileScore = Math.max(0, ...(bundle.rankedFiles ?? []).map((f) => f.score));
  for (const file of bundle.rankedFiles ?? []) {
    if (namedPaths.has(file.path)) continue;
    const entity = bundle.entities.filter((e) => e.path === file.path && e.lineStart)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    candidates.push(excerpt({ name: entity?.name ?? file.path, path: file.path,
      lineStart: entity?.lineStart, lineEnd: entity?.lineEnd,
      confidence: lexicalConfidence(file.score, bestFileScore),
      reason: `issue text: ${file.reason}` }, options.read, options.issueQuery));
  }
  return candidates;
}

export function leanContextCandidates(view: LeanIssueView, options: ContextSelectionOptions = {}): ContextCandidate[] {
  const best = Math.max(0, ...view.alsoRanked.map((f) => f.score));
  const named = new Set(view.startingPoints.map((s) => s.path));
  return [
    ...view.startingPoints.map(startCandidate),
    ...view.alsoRanked.filter((f) => !named.has(f.path)).map((f) => ({ name: f.path, path: f.path,
      reason: `issue text: ${f.reason}`, confidence: lexicalConfidence(f.score, best) })),
  ].map((c) => excerpt(c, options.read, options.issueQuery));
}

export function preciseContextLlmLines(page: ContextPage): string[] {
  return [
    llmLine("context", { schema: page.schema, returned: page.selection.returned,
      eligible: page.selection.eligible, below_confidence: page.selection.belowConfidence,
      missing_span: page.selection.missingSpan, confidence_floor: page.selection.confidenceFloor,
      remaining: page.selection.remaining, cursor: page.selection.cursor }),
    ...page.items.map((item) => llmLine("item", { name: item.name, span: item.span,
      reason: item.reason, confidence: item.confidence, stale: item.stale })),
    ...(page.selection.more ? [llmLine("next", { message: page.selection.more })] : []),
  ];
}
