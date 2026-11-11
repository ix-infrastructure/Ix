// Copyright 2026 Ix Infrastructure Inc.

// Rendering a bundle as text, llm records or JSON.

import { llmLine, printLlmLines } from "../llm.js";
import { renderNote, renderSection, renderWarning } from "../ui.js";
import { printJson } from "../format.js";
import { forMcp } from "../next-step.js";

import { formatLocation } from "./location.js";
import { onDiskSymbolCheck, renderedNextReads, nextToolCalls } from "./next.js";
import { evidenceRecord } from "./records.js";
import { truncationAdvice } from "./truncation.js";
import type { EvidenceItem, ContextBundle } from "./types.js";
import { asString } from "./util.js";

/**
 * The `next` lines `--format llm` closes with, for the bundle's evidence as it
 * stands. Draws only on the first few rows with a readable range; see
 * {@link llmNextByCut}.
 */
export function llmNextLines(bundle: ContextBundle): string[] {
  return forMcp()
    ? nextToolCalls(bundle, onDiskSymbolCheck())
      .map((step) => llmLine("next", { cmd: step.cmd, why: step.why, stale: step.stale, reanchor: step.reanchor }))
    : renderedNextReads(bundle).map((row) => llmLine("next", { cmd: row.cmd, stale: row.stale || undefined }));
}

/**
 * Indexes of the first `limit` evidence rows with a distinct readable range
 * (path, start and end line), in evidence order. These are the only rows
 * {@link nextReads} and {@link nextToolCalls} read, so the `next` lines can
 * only change at a cut that drops one of them.
 */
function readableRowIndexes(evidence: EvidenceItem[], limit: number): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < evidence.length && out.length < limit; i++) {
    const loc = evidence[i]!.location;
    if (!loc?.path || loc.lineStart === undefined || loc.lineEnd === undefined) continue;
    const range = `${loc.path}:${loc.lineStart}-${loc.lineEnd}`;
    if (seen.has(range)) continue;
    seen.add(range);
    out.push(i);
  }
  return out;
}

/**
 * The `next` lines for every cut of `evidence`, computed once per bundle.
 *
 * The budget-fitting loop in `buildBundle` measures the llm output at many cut
 * counts. Recomputing the `next` rows at each would repeat whatever they cost
 * (a stale-row check that reads files, say) once per iteration. They only
 * change at the cuts that drop one of the first three readable rows, so they
 * are computed for those few prefixes, up front, and looked up by count after.
 */
export function llmNextByCut(bundle: ContextBundle, evidence: EvidenceItem[]): (count: number) => string[] {
  // Each breakpoint is a prefix length at which the next lines can change.
  const breaks = [0, ...readableRowIndexes(evidence, 3).map((i) => i + 1)];
  const table = breaks.map((at) => llmNextLines({ ...bundle, evidence: evidence.slice(0, at) }));
  return (count) => {
    let k = 0;
    while (k + 1 < breaks.length && breaks[k + 1]! <= count) k += 1;
    return table[k]!;
  };
}

/**
 * The lines `--format llm` prints, in order. Pure, so `buildBundle` can measure
 * exactly what a budget will be charged for. `next` is the closing lines when
 * the caller already has them (`buildBundle` takes them from
 * {@link llmNextByCut}); otherwise they are computed from the bundle.
 */
export function bundleLlmLines(bundle: ContextBundle, next: string[] = llmNextLines(bundle)): string[] {
  // Every line through `llmLine`, none through a template literal: see the
  // history of this block. Absent sections are null and filtered out.
  const lines: Array<string | null> = [
      llmLine("context", {
        target: bundle.target.name,
        target_kind: bundle.target.kind,
        target_path: bundle.target.path,
        // Not on a degraded graph: `stale=false` there reads as a clean bill
        // of health for a bundle the graph has hollowed out.
        graph: bundle.graph ? String(bundle.graph.status) : undefined,
        stale: bundle.graph ? undefined : bundle.freshness.stale,
        classification: bundle.freshness.classification,
        entities: bundle.entities.length,
        relationships: bundle.relationships.length,
        claims: bundle.claims.length,
        decisions: bundle.decisions.length,
        conflicts: bundle.conflicts.length + bundle.truncation.conflictsTruncated,
        intents: bundle.intents.length,
        evidence: bundle.evidence.length,
        truncated_entities: bundle.truncation.entitiesTruncated,
        truncated_relationships: bundle.truncation.relationshipsTruncated,
        truncated_evidence: bundle.truncation.evidenceTruncated,
        truncated_chars: bundle.truncation.charactersTruncated,
      }),
      // First after the header: everything below is drawn from this graph.
      bundle.graph ? llmLine("graph", {
        status: asString(bundle.graph.status),
        reason: asString(bundle.graph.reason),
        message: asString(bundle.graph.message),
        fix: asString(bundle.graph.fix),
      }) : null,
      // What the budget dropped, and the cheapest command that gets it back.
      // The header's `truncated_*` counters say how much went; without this the
      // caller's only move is a bigger budget for the same query, which is the
      // most expensive one available.
      truncationAdvice(bundle)
        ? llmLine("diagnostic", { code: "bundle_truncated", message: truncationAdvice(bundle) })
        : null,
      bundle.issue?.fallback
        ? llmLine("diagnostic", { code: "issue_fallback", message: ISSUE_FALLBACK_NOTE })
        : null,
      // Evidence only, as before. The entity, relationship and claim lists are
      // deliberately still counts here: `--format llm` is the token-minimal
      // surface, the ranked evidence is what it exists to deliver, and
      // `--format json` carries the rest for a caller that wants it.
      ...bundle.evidence.map(evidenceRecord(undefined)),
      // Last, so it reads as the closing instruction it is.
      ...next,
  ];
  return lines.filter((line): line is string => line !== null);
}

/** The two prose lines `--format text` prints for one evidence item. */
export function textEvidenceLines(item: EvidenceItem): string[] {
  const where = item.location ? `${formatLocation(item.location)} — ` : "";
  return [`  [${item.score}] ${item.kind} — ${item.title}`, `         ${where}${item.reason}`];
}

/** Rough size of the prose header, charged before the evidence in `--format text`. */
export const TEXT_HEADER_ESTIMATE = 600;

export function renderBundle(bundle: ContextBundle, format: string): void {
  if (format === "json") {
    printJson(bundle);
    return;
  }
  if (format === "llm") {
    // Every line through `llmLine`, none through a template literal. This block
    // built `target=${name}` and `evidence 30 relationship <title>` by
    // interpolation: the first breaks on any name containing a space or an `=`,
    // and the second is positional, unquoted, and breaks on every title, which
    // is a sentence. `ix context --diff --format llm` emits the keyed form for
    // the same record kinds, so a consumer routing on `evidence` from the same
    // command was handed two grammars.
    printLlmLines(bundleLlmLines(bundle));
    return;
  }

  renderSection(`Context: ${bundle.target.name}`);
  console.log(`  kind:          ${bundle.target.kind}`);
  if (bundle.target.path) console.log(`  path:          ${bundle.target.path}`);
  console.log(`  classification:${bundle.freshness.classification}`);
  console.log(`  entities:      ${bundle.entities.length}`);
  console.log(`  relationships: ${bundle.relationships.length}`);
  console.log(`  claims:        ${bundle.claims.length}`);
  console.log(`  decisions:     ${bundle.decisions.length}`);
  // Named, not listed: see rankEvidence. The hint is what makes the count
  // actionable, since the reports are no longer in the evidence list.
  const conflictCount = bundle.conflicts.length + bundle.truncation.conflictsTruncated;
  console.log(
    `  conflicts:     ${conflictCount}${conflictCount > 0 ? " (run ix conflicts to inspect)" : ""}`,
  );
  console.log(`  intents:       ${bundle.intents.length}`);
  if (bundle.issue) {
    console.log(
      `  from issue:    ${bundle.issue.startingPoints.length} starting point(s), ${bundle.rankedFiles?.length ?? 0} ranked files`,
    );
    if (bundle.issue.fallback) renderNote(ISSUE_FALLBACK_NOTE);
  }
  if (bundle.graph) {
    const g = bundle.graph;
    renderWarning(
      `Graph is ${String(g.status)}. ${g.message ? String(g.message) : ""}${g.fix ? ` Fix: ${String(g.fix)}` : ""}`.trim(),
    );
  }
  if (bundle.freshness.stale) {
    renderWarning("Source has changed since last ingest. Run ix map to update.");
  }

  if (bundle.evidence.length > 0) {
    renderSection("Evidence (highest relevance first)");
    for (const item of bundle.evidence) {
      for (const line of textEvidenceLines(item)) console.log(line);
    }
  }

  const reads = renderedNextReads(bundle);
  if (reads.length > 0) {
    renderSection("Next");
    for (const row of reads) {
      console.log(`  ${row.cmd}${row.stale ? "  (stale: changed since last ingest; ix map to update)" : ""}`);
    }
  }

  const trunc = bundle.truncation;
  if (trunc.entitiesTruncated + trunc.relationshipsTruncated + trunc.evidenceTruncated > 0) {
    const advice = truncationAdvice(bundle);
    renderNote(
      `Truncated: ${trunc.entitiesTruncated} entities, ${trunc.relationshipsTruncated} relationships, ${trunc.evidenceTruncated} evidence items.`
      + (advice ? ` ${advice}` : " Raise --max-tokens for more."),
    );
  }
  console.log();
}

/**
 * Evidence sources, as the word a hint can put a number in front of.
 *
 * Keyed on `source` rather than `kind`: `kind` is `structural` for members,
 * imports, calls, callers and dependents alike, and "cut: 48 structural" is the
 * uninformative sentence this exists to replace.
 */
/** Said wherever a bundle's start came from BM25 rather than from the issue's names. */
const ISSUE_FALLBACK_NOTE =
  "Nothing the issue names resolved to a definition; the bundle starts from the file whose text matches the issue best (BM25).";
