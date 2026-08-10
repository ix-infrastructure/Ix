import { llmLine } from "../llm.js";
import { relativePath } from "../format.js";
import type { EntityFacts } from "./facts.js";
import type { RoleInference } from "./role-inference.js";
import type { ImportanceInference } from "./importance.js";
import type { ExplanationOutput } from "./render.js";

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
export function renderExplainLlm(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
  rendered: ExplanationOutput,
): string[] {
  const lines: string[] = [];

  lines.push(llmLine("entity", [
    ["id", facts.id],
    ["name", facts.name],
    ["kind", facts.kind],
    ["path", facts.path],
    ["rev", facts.introducedRev],
    ["stale", facts.stale ? "true" : null],
  ]));

  lines.push(llmLine("role", [
    ["role", role.role],
    ["confidence", role.confidence],
  ]));

  lines.push(llmLine("importance", [
    ["level", importance.level],
    ["category", importance.category],
  ]));

  // Zeroes are meaningful here, so they are stringified rather than passed as
  // numbers — llmField drops "" but keeps "0".
  lines.push(llmLine("edges", [
    ["callers", String(facts.callerCount)],
    ["callees", String(facts.calleeCount)],
    ["dependents", String(facts.dependentCount)],
    ["importers", String(facts.importerCount)],
    ["members", String(facts.memberCount)],
    ["downstream", String(facts.downstreamDependents)],
    ["depth", String(facts.downstreamDepth)],
    ["history", String(facts.historyLength)],
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

  for (const caller of facts.topCallers) {
    lines.push(llmLine("caller", [["name", caller]]));
  }
  for (const dependent of facts.topDependents) {
    lines.push(llmLine("dependent", [["name", dependent]]));
  }
  for (const member of facts.members) {
    lines.push(llmLine("member", [["name", member]]));
  }

  // Kept from the prose because it is the one part that is not derivable from
  // the records above: `usedBy` names call sites the counts only total up.
  if (rendered.usedBy) lines.push(llmLine("used_by", [["text", rendered.usedBy]]));

  for (const note of rendered.notes) {
    lines.push(llmLine("note", [["text", note]]));
  }

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
    ["id", result.id],
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
