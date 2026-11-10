// Copyright 2026 Ix Infrastructure Inc.

import { llmLine, llmShortId } from "../llm.js";
import { relativePath } from "../format.js";
import type { EntityFacts, EntityLocation } from "./facts.js";
import type { RoleInference } from "./role-inference.js";
import type { ImportanceInference } from "./importance.js";
import type { ExplanationOutput } from "./render.js";
import { isUnhealthy, graphHealthLlmFields, type GraphHealth } from "../graph-health.js";

/**
 * `ix explain --format llm`.
 *
 * `explain` advertised `llm` and rendered `text` — the prose pipeline
 * (explanation / context / why-it-matters) with section headers and indents.
 * That is the single most expensive thing an agent reads, and it is the
 * command a plugin calls first on almost every question, so the fallback was
 * costing the most tokens on the hottest path.
 *
 * The prose is a *rendering* of `facts` + `role` + `importance`, so an agent
 * does not need it: emit the inputs as records and let the model do its own
 * summarising. `whyItMatters` and `explanation` are dropped entirely for that
 * reason — every claim in them is derivable from the `role`, `importance` and
 * `edges` lines below.
 *
 * Counts are emitted even at zero on the `edges` line: "this has no callers"
 * is a real answer to "who calls this", and dropping the field would make it
 * indistinguishable from a field the renderer forgot.
 */
/** `17-145`, or `17`, from a located entity — nothing when it has no lines. */
function lineSpanOf(ref: EntityLocation | undefined): string | undefined {
  if (!ref || ref.lineStart === undefined) return undefined;
  return ref.lineEnd !== undefined && ref.lineEnd !== ref.lineStart
    ? `${ref.lineStart}-${ref.lineEnd}`
    : `${ref.lineStart}`;
}

export function renderExplainLlm(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
  rendered: ExplanationOutput,
  health?: GraphHealth,
): string[] {
  const lines: string[] = [];
  // A hollowed graph answers every count below with 0, and the role and
  // importance are inferred from those counts. First, so it is read before
  // any of them; and the conclusions drawn from missing edges are withheld
  // rather than stated (see graph-health.ts).
  const degraded = isUnhealthy(health);
  if (degraded) lines.push(llmLine("graph", graphHealthLlmFields(health)));

  lines.push(llmLine("entity", [
    ["id", llmShortId(facts.id)],
    ["name", facts.name],
    ["kind", facts.kind],
    ["path", facts.path],
    ["rev", facts.introducedRev],
    ["stale", facts.stale ? "true" : null],
  ]));

  if (degraded) {
    lines.push(llmLine("role", [["role", "unknown"], ["confidence", "none"], ["reason", "graph_degraded"]]));
    lines.push(llmLine("importance", [["level", "unknown"], ["reason", "graph_degraded"]]));
  } else {
    lines.push(llmLine("role", [
      ["role", role.role],
      ["confidence", role.confidence],
    ]));

    lines.push(llmLine("importance", [
      ["level", importance.level],
      ["category", importance.category],
    ]));
  }

  // Zeroes are meaningful here, so they are stringified rather than passed as
  // numbers — llmField drops "" but keeps "0". On a degraded graph a zero is
  // an edge that may simply be missing, so it is `unknown` there; a non-zero
  // count is still an edge that exists, i.e. a floor.
  const count = (n: number) => (degraded && n === 0 ? "unknown" : String(n));
  lines.push(llmLine("edges", [
    ["callers", count(facts.callerCount)],
    ["callees", count(facts.calleeCount)],
    ["dependents", count(facts.dependentCount)],
    ["importers", count(facts.importerCount)],
    ["members", count(facts.memberCount)],
    ["downstream", count(facts.downstreamDependents)],
    ["depth", count(facts.downstreamDepth)],
    ["history", String(facts.historyLength)],
    ["complete", degraded ? "false" : null],
  ]));

  if (facts.container) {
    lines.push(llmLine("container", [
      ["kind", facts.container.kind],
      ["name", facts.container.name],
    ]));
  }

  if (facts.subsystemName || facts.moduleName) {
    lines.push(llmLine("location", [
      ["subsystem", facts.subsystemName],
      ["module", facts.moduleName],
    ]));
  }

  if (facts.signature) lines.push(llmLine("signature", [["text", facts.signature]]));

  // The same three names, three times over. A caller is nearly always also a
  // dependent — `relativePath` on this repo emitted three `caller` rows, the
  // same three as `dependent` rows, and then a `used_by` sentence naming them
  // again: ten lines where three carry the information.
  //
  // So: callers first, dependents only where they are not already a caller,
  // and each row says which relations it stands for.
  const relations = new Map<string, { rel: string[]; ref?: EntityLocation }>();
  const note = (name: string, rel: string, ref?: EntityLocation) => {
    const entry = relations.get(name) ?? { rel: [], ref: undefined };
    entry.rel.push(rel);
    entry.ref = entry.ref ?? ref;
    relations.set(name, entry);
  };
  facts.topCallers.forEach((name, i) => note(name, "caller", facts.topCallerRefs?.[i]));
  facts.topDependents.forEach((name, i) => note(name, "dependent", facts.topDependentRefs?.[i]));
  for (const [name, { rel, ref }] of relations) {
    lines.push(llmLine("uses", [
      ["name", name],
      ["rel", rel.join(",")],
      ["path", ref?.path],
      ["lines", lineSpanOf(ref)],
    ]));
  }

  facts.members.forEach((name, i) => {
    const ref = facts.memberRefs?.[i];
    lines.push(llmLine("member", [
      ["name", name],
      ["path", ref?.path],
      ["lines", lineSpanOf(ref)],
    ]));
  });

  // The generated `used_by` sentence is those names a third time; only a
  // hierarchy-derived narrative says something the rows above do not.
  if (rendered.usedBy && !rendered.usedByIsNameList) {
    lines.push(llmLine("used_by", [["text", rendered.usedBy]]));
  }

  // No `note` records: every note is prose rendered from one of the
  // diagnostics below (`renderNotes`), so printing both said each thing twice.
  for (const diagnostic of facts.diagnostics) {
    lines.push(llmLine("diagnostic", [
      ["code", diagnostic.code],
      ["message", diagnostic.message],
    ]));
  }

  return lines;
}

/**
 * `ix explain --raw --format llm`.
 *
 * The legacy metadata dump. Same treatment, driven off the assembled
 * `ExplainResult` rather than the fact pipeline.
 */
export function renderExplainRawLlm(result: {
  kind?: string;
  name?: string;
  id?: string;
  file?: string;
  chunkKind?: string;
  container?: { kind: string; name: string };
  introducedRev?: number;
  calledBy?: number;
  calls?: number;
  contains?: number;
  historyLength?: number;
  signature?: string;
  docstring?: string;
  callList?: Array<{ name: string; kind?: string; path?: string; resolved: boolean }>;
  diagnostics?: Array<{ code: string; message: string }>;
  stale?: boolean;
}): string[] {
  const lines: string[] = [];

  lines.push(llmLine("entity", [
    ["id", llmShortId(result.id)],
    ["name", result.name],
    ["kind", result.kind],
    ["path", result.file],
    ["chunk_kind", result.chunkKind],
    ["rev", result.introducedRev],
    ["stale", result.stale ? "true" : null],
  ]));

  lines.push(llmLine("edges", [
    ["called_by", String(result.calledBy ?? 0)],
    ["calls", String(result.calls ?? 0)],
    ["contains", String(result.contains ?? 0)],
    ["history", String(result.historyLength ?? 0)],
  ]));

  if (result.container) {
    lines.push(llmLine("container", [
      ["kind", result.container.kind],
      ["name", result.container.name],
    ]));
  }

  if (result.signature) lines.push(llmLine("signature", [["text", result.signature]]));
  if (result.docstring) lines.push(llmLine("docstring", [["text", result.docstring]]));

  for (const call of result.callList ?? []) {
    lines.push(llmLine("call", [
      ["name", call.name],
      ["kind", call.kind],
      ["path", relativePath(call.path)],
      ["resolved", call.resolved ? null : "false"],
    ]));
  }

  for (const diagnostic of result.diagnostics ?? []) {
    lines.push(llmLine("diagnostic", [
      ["code", diagnostic.code],
      ["message", diagnostic.message],
    ]));
  }

  return lines;
}
