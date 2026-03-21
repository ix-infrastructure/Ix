import type { EntityFacts } from "./facts.js";
import type { RoleInference, RoleLabel } from "./role-inference.js";
import type { ImportanceInference } from "./importance.js";
import {
  type HierarchySemantics,
  inferHierarchySemantics,
  synthesizeSystemRole,
  hierarchyImpactPhrase,
} from "./hierarchy-semantics.js";
import { inferSystemMeaning } from "./system-meaning.js";
import { type FlowSemantics, inferFlowSemantics } from "./flow-semantics.js";

export interface ExplanationOutput {
  explanation: string;
  context: string;
  usedBy: string | null;
  whyItMatters: string;
  notes: string[];
}

// ── Role description templates (local-only fallback) ────────────────────────

/** Build a role description from local signals only (no hierarchy). */
function describeRoleLocal(role: RoleLabel, facts: EntityFacts): string {
  const containerName = facts.container?.name;
  const file = fileBaseName(facts.path);

  switch (role) {
    case "test":
      return "a test or specification";
    case "configuration":
      return "a configuration source";
    case "type-definition":
      return "a type definition";
    case "data-model":
      return "a data model";
    case "api-client":
      return "the main backend API client for the CLI";
    case "entry-point":
      return "an entry point";
    case "registration-function":
      return file
        ? `a command registration function in ${file}`
        : "a command registration function";
    case "service":
      return "a service coordinating multiple operations";
    case "service-method":
      return containerName
        ? `a method within ${containerName}`
        : "a service method";
    case "adapter":
      return "an adapter bridging external systems";
    case "orchestrator":
      return "an orchestrator coordinating multiple downstream operations";
    case "resolution-helper":
      return containerName
        ? `a resolution method inside ${containerName}`
        : file
          ? `a shared resolution method in the ${file} pipeline`
          : "a resolution or lookup helper";
    case "selection-helper":
      return containerName
        ? `a selection helper inside ${containerName}`
        : file
          ? `a selection helper in the ${file} pipeline`
          : "a selection helper that picks or ranks candidates";
    case "scoring-helper":
      return file
        ? `a scoring function used by the ${file} pipeline`
        : "a scoring or ranking helper";
    case "container":
      return `a container module with ${facts.memberCount} members`;
    case "shared-utility":
      return "a widely shared utility function";
    case "localized-helper":
      if (containerName) return `a helper within ${containerName}`;
      if (file) return `a localized helper defined in ${file}`;
      return "a localized internal helper";
    case "unknown":
      if (containerName) return `a member of ${containerName}`;
      if (file) return `a localized helper defined in ${file}`;
      return "a localized internal helper";
  }
}

function fileBaseName(path?: string): string {
  if (!path) return "";
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

// ── Callable detection ──────────────────────────────────────────────────────

const CALLABLE_KINDS = new Set(["function", "method", "def", "fun", "constructor"]);

function isCallable(kind: string, role: RoleLabel): boolean {
  if (CALLABLE_KINDS.has(kind.toLowerCase())) return true;
  return ([
    "selection-helper", "resolution-helper", "scoring-helper",
    "service-method", "entry-point", "registration-function",
    "orchestrator", "localized-helper", "shared-utility",
  ] as RoleLabel[]).includes(role);
}

// ── Flow rendering helpers ──────────────────────────────────────────────────

const FLOW_RESPONSIBILITIES: Record<string, string> = {
  "selection step": "chooses the best candidate from multiple possible matches",
  "resolution step": "resolves ambiguous references to concrete entities",
  "conflict resolver": "processes and resolves conflicts between competing changes",
  "conflict detection step": "detects conflicting changes across the graph",
  "conflict resolution step": "handles conflict resolution logic",
  "merge step": "merges competing changes into a consistent state",
  "parsing step": "transforms raw input into structured data",
  "input processing step": "reads and decodes input for further processing",
  "tokenization step": "breaks input into discrete tokens for analysis",
  "traversal step": "walks the dependency graph to discover affected nodes",
  "impact analysis step": "analyzes the impact of changes across the graph",
  "rendering step": "transforms structured data into human-readable output",
  "inference step": "infers semantic properties from structural signals",
  "explanation step": "generates explanations from inferred semantics",
  "ingestion step": "ingests source files into the knowledge graph",
  "persistence step": "persists data to the backing store",
  "scoring step": "assigns numeric scores to candidates for ranking",
  "ranking step": "orders candidates by computed scores",
  "weighting step": "applies weights to scoring signals",
};

const FLOW_BEHAVIOR_VERBS: Record<string, string> = {
  "selection step": "determines which candidate is selected",
  "resolution step": "determines how references are resolved",
  "conflict resolver": "determines how conflicts are handled",
  "conflict detection step": "determines which conflicts are detected",
  "conflict resolution step": "determines how conflicts are resolved",
  "merge step": "determines how changes are merged",
  "parsing step": "determines how input is parsed",
  "input processing step": "determines how input is processed",
  "tokenization step": "determines how input is tokenized",
  "traversal step": "determines how the graph is traversed",
  "impact analysis step": "determines how impact is analyzed",
  "rendering step": "determines how output is rendered",
  "inference step": "determines what semantics are inferred",
  "explanation step": "determines how explanations are generated",
  "ingestion step": "determines how files are ingested",
  "persistence step": "determines how data is persisted",
  "scoring step": "determines how candidates are scored",
  "ranking step": "determines how candidates are ranked",
  "weighting step": "determines how weights are applied",
};

function flowActionNoun(flowName: string): string {
  if (flowName.includes("conflict")) return "conflict resolution";
  if (flowName.includes("resolution")) return "entity resolution";
  if (flowName.includes("parsing")) return "input parsing";
  if (flowName.includes("impact")) return "impact analysis";
  if (flowName.includes("explanation")) return "explanation generation";
  if (flowName.includes("ingestion")) return "file ingestion";
  if (flowName.includes("scoring")) return "candidate scoring";
  return "processing";
}

function renderFlowExplanation(
  facts: EntityFacts,
  flow: FlowSemantics,
  phrasing: { roleVerb: string; impactVerb: string },
): string {
  const role = flow.roleInFlow ?? "step";
  const flowName = flow.flowName ?? "pipeline";
  const responsibility = FLOW_RESPONSIBILITIES[role] ?? `performs a step in the ${flowName}`;
  return `\`${facts.name}\` ${phrasing.roleVerb} a ${role} in the ${flowName}. It ${responsibility}.`;
}

function renderFlowWhyItMatters(
  facts: EntityFacts,
  flow: FlowSemantics,
  importance: ImportanceInference,
  phrasing: { roleVerb: string; impactVerb: string },
): string {
  const role = flow.roleInFlow ?? "step";
  const flowName = flow.flowName ?? "pipeline";
  const verb = phrasing.impactVerb;
  const behaviorVerb = FLOW_BEHAVIOR_VERBS[role] ?? `affects the ${flowName}`;
  const actionNoun = flowActionNoun(flowName);

  if (importance.category === "pipeline-choke-point") {
    const callerPhrase = facts.callerCount === 1
      ? "only 1 direct caller"
      : `only ${facts.callerCount} direct callers`;
    const downstream = flow.downstreamHint
      ? flow.downstreamHint.replace(/^feeds /, "")
      : `${facts.downstreamDependents} downstream dependents`;
    return (
      `Although it has ${callerPhrase}, this ${role} sits in the ${flowName} ` +
      `and feeds ${downstream}, ` +
      `making it a critical decision point in that flow. ` +
      `Consider running \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (importance.level === "high") {
    return (
      `Because this ${role} ${behaviorVerb}, changes here ${verb} affect how ` +
      `${actionNoun} behaves across the system. ` +
      `Run \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (importance.level === "low") {
    return `This ${role} in the ${flowName} has limited inbound connections.`;
  }

  // medium
  return (
    `Because this ${role} ${behaviorVerb}, changes here ${verb} affect how ` +
    `${actionNoun} behaves.`
  );
}

// ── Confidence-to-language mapping ───────────────────────────────────────────

function phrasingForConfidence(confidence: "low" | "medium" | "high"): {
  roleVerb: string;
  impactVerb: string;
} {
  if (confidence === "high") return { roleVerb: "serves as", impactVerb: "will" };
  if (confidence === "medium") return { roleVerb: "is likely", impactVerb: "may" };
  return { roleVerb: "appears to be", impactVerb: "may" };
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderExplanation(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
): ExplanationOutput {
  // Infer hierarchy semantics and system meaning
  const sem = inferHierarchySemantics(facts, role.role);
  const meaning = inferSystemMeaning(facts, role.role, sem, importance);
  const isFoundation = meaning?.archetype === "foundation";
  const phrasing = phrasingForConfidence(role.confidence);

  // Infer flow semantics for callable entities
  const callable = isCallable(facts.kind, role.role);
  const flow = callable ? inferFlowSemantics(facts) : undefined;
  const useFlow = callable && flow?.confidence === "high" && !!flow.flowName;

  // ── Explanation ────────────────────────────────────────────────────────
  let explanation: string;

  if (isFoundation) {
    // Foundation types (interfaces, enums, models) get system-meaning identity + responsibility
    explanation = `\`${facts.name}\` ${phrasing.roleVerb} ${meaning!.identitySummary}. ${meaning!.responsibility}`;
  } else if (useFlow) {
    // Flow-first rendering for callable entities with high-confidence flow
    explanation = renderFlowExplanation(facts, flow!, phrasing);
  } else {
    // Prefer system-aware role description when hierarchy context is strong
    const systemRoleDesc = synthesizeSystemRole(facts, role.role, sem);
    const roleDesc = systemRoleDesc ?? describeRoleLocal(role.role, facts);
    explanation = `\`${facts.name}\` ${phrasing.roleVerb} ${roleDesc}.`;
  }

  if (facts.signature) {
    explanation += ` Signature: \`${facts.signature}\`.`;
  }

  if (facts.docstring) {
    explanation += ` ${facts.docstring}`;
  }

  // ── Context ───────────────────────────────────────────────────────────
  const contextLines: string[] = [];

  if (facts.path) {
    contextLines.push(`Defined in: ${facts.path}`);
  }

  if (facts.container) {
    contextLines.push(`Container: ${facts.container.kind} ${facts.container.name}`);
  }

  if (facts.systemPath && facts.systemPath.length > 1) {
    contextLines.push(`System path: ${facts.systemPath.slice(0, -1).map(n => n.name).join(" > ")}`);
  }

  if (facts.callerCount > 0) {
    contextLines.push(`Called by: ${facts.callerCount} entities`);
  }

  if (facts.calleeCount > 0) {
    contextLines.push(`Calls: ${facts.calleeCount} entities`);
  }

  if (useFlow && flow!.upstreamHint) {
    contextLines.push(`Called from: ${flow!.upstreamHint.replace(/^called from /, "")}`);
  }

  if (useFlow && flow!.downstreamHint) {
    contextLines.push(`Feeds into: ${flow!.downstreamHint.replace(/^feeds /, "")}`);
  }

  if (facts.memberCount > 0) {
    contextLines.push(`Contains: ${facts.memberCount} members`);
  }

  if (facts.importerCount > 0) {
    contextLines.push(`Imported by: ${facts.importerCount} modules`);
  }

  if (facts.downstreamDependents > 0) {
    contextLines.push(`Downstream dependents: ${facts.downstreamDependents} (depth ${facts.downstreamDepth})`);
  }

  if (facts.introducedRev !== undefined) {
    contextLines.push(`First seen: rev ${facts.introducedRev}`);
  }

  if (facts.historyLength > 0) {
    contextLines.push(`Patch history: ${facts.historyLength} patches`);
  }

  const context = contextLines.join("\n");

  // ── Used by (named examples) ──────────────────────────────────────────
  const usedBy = (isFoundation && meaning!.usageSummary)
    ? meaning!.usageSummary
    : renderUsedBy(facts);

  // ── Why it matters (role + importance + hierarchy fusion) ─────────────
  const whyItMatters = (isFoundation && meaning!.importanceNarrative)
    ? meaning!.importanceNarrative
    : useFlow
      ? renderFlowWhyItMatters(facts, flow!, importance, phrasing)
      : renderWhyItMatters(facts, role, importance, phrasing, sem);

  // ── Notes (clean diagnostics) ─────────────────────────────────────────
  const notes = renderNotes(facts);

  return { explanation, context, usedBy, whyItMatters, notes };
}

// ── Used by ─────────────────────────────────────────────────────────────────

function renderUsedBy(facts: EntityFacts): string | null {
  const examples = facts.topCallers.length > 0
    ? facts.topCallers
    : facts.topDependents;

  if (examples.length === 0) return null;

  const total = Math.max(facts.callerCount, facts.dependentCount);

  if (examples.length === 1) {
    if (total > 1) {
      return `Used by ${examples[0]} and ${total - 1} other${total - 1 === 1 ? "" : "s"}.`;
    }
    return `Used by ${examples[0]}.`;
  }

  const listed = examples.slice(0, 3).join(", ");
  const remaining = total - examples.length;
  if (remaining > 0) {
    return `Used by ${listed}, and ${remaining} other${remaining === 1 ? "" : "s"}.`;
  }
  return `Used by ${listed}.`;
}

// ── Why it matters ──────────────────────────────────────────────────────────

function renderWhyItMatters(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
  phrasing: { roleVerb: string; impactVerb: string },
  sem: HierarchySemantics,
): string {
  const { level, category } = importance;
  const verb = phrasing.impactVerb;
  const hasHierarchy = !!(sem.layerName || sem.flowName);

  if (category === "pipeline-choke-point") {
    const callerPhrase = facts.callerCount === 1
      ? "only 1 direct caller"
      : `only ${facts.callerCount} direct callers`;

    if (hasHierarchy) {
      const location = sem.flowName ?? sem.layerName!;
      return (
        `Although it has ${callerPhrase}, it sits inside the ${location} ` +
        `and feeds ${facts.downstreamDependents} downstream dependents, ` +
        `making it a critical decision point in that flow. ` +
        `Consider running \`ix impact ${facts.name}\` before modifying.`
      );
    }

    return (
      `Although it has ${callerPhrase}, it sits in a path with ` +
      `${facts.downstreamDependents} downstream dependents, making it a ` +
      `structurally important decision point in the pipeline. ` +
      `Consider running \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (category === "broad-shared-dependency") {
    // Try hierarchy-aware phrasing first
    const hierPhrase = hierarchyImpactPhrase(facts, sem);
    if (hierPhrase) {
      return (
        `Because ${hierPhrase}. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }

    // Fall back to local role fusion
    const roleContext = roleFusionPhraseLocal(role.role, facts);
    if (roleContext) {
      return (
        `${roleContext}, changes here ${verb} propagate across the codebase. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }

    const reasonStr = importance.reasons.length > 0
      ? importance.reasons[0]
      : "High connectivity";
    return (
      `${reasonStr}. This is a central shared dependency — changes ${verb} propagate broadly. ` +
      `Run \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (category === "localized-helper") {
    if (hasHierarchy) {
      const location = sem.flowName ?? sem.layerName!;
      return (
        `Its usage is localized within the ${location}, suggesting it is a narrow internal helper ` +
        `with limited impact beyond that scope.`
      );
    }
    return (
      "Its usage is localized, suggesting it is a narrow internal helper " +
      "with limited system-wide impact."
    );
  }

  // normal category
  if (level === "high") {
    const hierPhrase = hierarchyImpactPhrase(facts, sem);
    if (hierPhrase) {
      return (
        `Because ${hierPhrase}. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }

    const roleContext = roleFusionPhraseLocal(role.role, facts);
    if (roleContext) {
      return (
        `${roleContext}, changes here ${verb} have wide impact. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }

    const reasonStr = importance.reasons.length > 0
      ? importance.reasons[0]
      : "This entity has high connectivity";
    return (
      `${reasonStr}. Changes here ${verb} have wide impact — run ` +
      `\`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (level === "low") {
    return (
      "Minimal inbound connections. " +
      "Changes are unlikely to affect other parts of the codebase."
    );
  }

  // medium / normal
  if (hasHierarchy) {
    const location = sem.flowName ?? sem.layerName!;
    const reasonStr = importance.reasons.length > 0
      ? importance.reasons[0]
      : "Moderate connectivity";
    return (
      `${reasonStr}. ` +
      `Review callers in the ${location} before making breaking changes.`
    );
  }

  const reasonStr = importance.reasons.length > 0
    ? importance.reasons[0]
    : "Moderate connectivity";
  return (
    `${reasonStr}. ` +
    "Review callers before making breaking changes."
  );
}

/** Local-only role fusion phrases (no hierarchy context). */
function roleFusionPhraseLocal(role: RoleLabel, facts: EntityFacts): string | null {
  switch (role) {
    case "api-client":
      return `As the central API client used across ${facts.callerCount > 0 ? facts.callerCount + " commands" : "the codebase"}`;
    case "service":
      return `As a core service with ${facts.memberCount} methods`;
    case "shared-utility":
      return `As a shared utility called by ${facts.callerCount} entities`;
    case "resolution-helper":
      return `As a resolution helper in the matching pipeline`;
    case "orchestrator":
      return `As an orchestrator coordinating ${facts.calleeCount} operations`;
    default:
      return null;
  }
}

// ── Notes (human-readable diagnostics) ──────────────────────────────────────

function renderNotes(facts: EntityFacts): string[] {
  const notes: string[] = [];
  for (const d of facts.diagnostics) {
    switch (d.code) {
      case "unresolved_call_target":
        notes.push("Some downstream calls could not be resolved to named entities. Run `ix ingest` to improve coverage.");
        break;
      case "stale_source":
        notes.push("Source file has changed since last ingest — results may be incomplete.");
        break;
      default:
        notes.push(d.message);
    }
  }
  return notes;
}
