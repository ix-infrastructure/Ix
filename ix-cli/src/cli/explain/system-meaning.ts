import type { EntityFacts } from "./facts.js";
import type { RoleLabel } from "./role-inference.js";
import type { HierarchySemantics } from "./hierarchy-semantics.js";
import type { ImportanceInference } from "./importance.js";

export interface SystemMeaning {
  archetype: "foundation" | "boundary" | "flow" | "general";
  identitySummary: string;
  responsibility: string;
  usageSummary?: string;
  importanceNarrative?: string;
}

const FOUNDATION_KINDS = new Set(["enum", "interface", "type", "trait", "data_class"]);
const BOUNDARY_ROLES = new Set<RoleLabel>(["api-client", "adapter"]);
const FLOW_ROLES = new Set<RoleLabel>([
  "selection-helper", "resolution-helper", "scoring-helper",
  "orchestrator", "service-method", "service",
]);

/** Extract domain noun from entity name (e.g. NodeKind → "node", ParseResult → "parse result"). */
function domainNounFromName(name: string): string {
  // camelCase/PascalCase → words
  const words = name
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  // Drop common suffixes that aren't the domain noun
  const drop = new Set(["kind", "type", "api", "result", "config", "service", "interface"]);
  const domainWords = words.filter((w) => !drop.has(w));
  return domainWords.length > 0 ? domainWords[0] : words[0];
}

function isModelFile(facts: EntityFacts): boolean {
  const path = facts.path?.toLowerCase() ?? "";
  return (
    facts.kind === "file" &&
    (path.includes("/model/") || path.includes("model.") || path.includes("/schema/")) &&
    facts.memberCount > 0
  );
}

function isFoundation(facts: EntityFacts, role: RoleLabel): boolean {
  if (FOUNDATION_KINDS.has(facts.kind)) return true;
  if (role === "type-definition" && (facts.importerCount >= 3 || facts.dependentCount >= 3)) return true;
  if (role === "data-model") return true;
  if (isModelFile(facts)) return true;
  return false;
}

function buildFoundationMeaning(facts: EntityFacts, sem: HierarchySemantics, importance: ImportanceInference): SystemMeaning {
  const noun = domainNounFromName(facts.name);
  const location = sem.layerName ?? sem.flowName;

  let identitySummary: string;
  if (isModelFile(facts)) {
    identitySummary = `a foundational definition file for ${noun}-related types`;
  } else if (facts.kind === "interface") {
    identitySummary = `a foundational contract defining the ${noun} interface`;
  } else if (facts.kind === "enum") {
    identitySummary = `a foundational ${noun} classification used across the system`;
  } else {
    identitySummary = `a foundational ${noun} type`;
  }

  let responsibility: string;
  if (facts.importerCount >= 5 || facts.dependentCount >= 8) {
    responsibility = `Consumed by multiple services and layers — changes affect the entire ${location ?? "system"}.`;
  } else {
    responsibility = `Defines the ${noun} contract used in ${location ?? "this subsystem"}.`;
  }

  let usageSummary: string | undefined;
  if (facts.topCallers.length > 0) {
    const names = facts.topCallers.slice(0, 3).join(", ");
    usageSummary = `Used by ${names}${facts.callerCount > 3 ? ` and ${facts.callerCount - 3} others` : ""}.`;
  }

  let importanceNarrative: string | undefined;
  if (importance.level === "high") {
    const context = location ? `in the ${location}` : "across the system";
    importanceNarrative = `This is a shared foundational type ${context}. Changes propagate to all importers — run \`ix impact ${facts.name}\` before modifying.`;
  }

  return { archetype: "foundation", identitySummary, responsibility, usageSummary, importanceNarrative };
}

function buildBoundaryMeaning(facts: EntityFacts, sem: HierarchySemantics, importance: ImportanceInference): SystemMeaning {
  const layer = sem.layerName ?? "CLI layer";
  const identitySummary = `the typed boundary between the CLI and backend services in the ${layer}`;
  const responsibility = `Provides all graph queries to CLI commands. Changes here affect every command that reads the knowledge graph.`;
  return { archetype: "boundary", identitySummary, responsibility };
}

function buildFlowMeaning(facts: EntityFacts, sem: HierarchySemantics, importance: ImportanceInference): SystemMeaning {
  const flow = sem.flowName ?? sem.layerName ?? "pipeline";
  const identitySummary = `a component of the ${flow}`;
  const responsibility = `Participates in the ${flow} — affects how this pipeline processes data.`;
  return { archetype: "flow", identitySummary, responsibility };
}

export function inferSystemMeaning(
  facts: EntityFacts,
  role: RoleLabel,
  sem: HierarchySemantics,
  importance: ImportanceInference,
): SystemMeaning | null {
  if (isFoundation(facts, role)) {
    return buildFoundationMeaning(facts, sem, importance);
  }

  if (BOUNDARY_ROLES.has(role) && sem.boundaryRole === "boundary") {
    return buildBoundaryMeaning(facts, sem, importance);
  }

  if (FLOW_ROLES.has(role) && (sem.flowName || sem.layerName)) {
    return buildFlowMeaning(facts, sem, importance);
  }

  return null;
}
