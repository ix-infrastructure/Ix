import type { EntityFacts } from "./facts.js";
import type { RoleLabel } from "./role-inference.js";

export interface HierarchySemantics {
  layerName?: string;
  flowName?: string;
  boundaryRole?: string;
  systemRole?: string;
  reasons: string[];
}

// Maps subsystem/path keywords to semantic layer/flow names
const SUBSYSTEM_FLOW_MAP: Array<{ match: RegExp; flowName?: string; layerName?: string }> = [
  { match: /resolve/i, flowName: "resolution pipeline", layerName: "resolution pipeline" },
  { match: /impact/i, flowName: "impact pipeline" },
  { match: /explain/i, flowName: "explanation pipeline", layerName: "explanation subsystem" },
  { match: /conflict/i, flowName: "conflict-resolution flow" },
  { match: /ingest/i, flowName: "ingestion pipeline" },
  { match: /parse|parser/i, flowName: "parsing pipeline" },
  { match: /score|scoring/i, flowName: "scoring pipeline" },
  { match: /rank/i, flowName: "ranking pipeline" },
  { match: /command|commands/i, layerName: "command layer" },
  { match: /client/i, layerName: "CLI client layer" },
];

function matchSubsystem(name: string): { flowName?: string; layerName?: string } | null {
  for (const entry of SUBSYSTEM_FLOW_MAP) {
    if (entry.match.test(name)) {
      return { flowName: entry.flowName, layerName: entry.layerName };
    }
  }
  return null;
}

export function inferHierarchySemantics(facts: EntityFacts, role: RoleLabel): HierarchySemantics {
  const reasons: string[] = [];
  const systemPath = facts.systemPath ?? [];

  if (systemPath.length === 0) {
    return { reasons };
  }

  // Extract subsystem name from path
  const subsystemNode = systemPath.find((n) => n.kind === "subsystem");
  const moduleNode = systemPath.find((n) => n.kind === "module");
  const subsystemName = subsystemNode?.name ?? facts.subsystemName;
  const moduleName = moduleNode?.name ?? facts.moduleName;

  // Try to match subsystem or module name to known flow/layer
  const searchName = subsystemName ?? moduleName ?? "";
  const matched = searchName ? matchSubsystem(searchName) : null;

  let layerName: string | undefined;
  let flowName: string | undefined;
  let boundaryRole: string | undefined;
  let systemRole: string | undefined;

  if (matched) {
    flowName = matched.flowName;
    layerName = matched.layerName ?? matched.flowName;
  } else if (subsystemName) {
    layerName = `${subsystemName} subsystem`;
  } else if (moduleName) {
    layerName = `${moduleName} layer`;
  }

  // Detect boundary roles (API clients, adapters at system edge)
  if (role === "api-client" && (layerName?.includes("client") || searchName.toLowerCase().includes("client"))) {
    boundaryRole = "boundary";
    systemRole = `boundary between the CLI and backend services`;
    reasons.push(`Located in the CLI client layer`);
  }

  if (layerName) reasons.push(`Part of the ${layerName}`);
  if (flowName) reasons.push(`Participates in the ${flowName}`);

  return { layerName, flowName, boundaryRole, systemRole, reasons };
}

export function synthesizeSystemRole(
  facts: EntityFacts,
  role: RoleLabel,
  sem: HierarchySemantics,
): string | null {
  if (!sem.layerName && !sem.flowName) return null;

  // Boundary roles
  if (sem.boundaryRole === "boundary" && sem.layerName) {
    return `the ${sem.boundaryRole} of the ${sem.layerName} — the typed boundary between the CLI and backend services`;
  }

  // Flow-aware roles
  if (sem.flowName) {
    switch (role) {
      case "selection-helper":
        return `a selection step in the ${sem.flowName}`;
      case "resolution-helper":
        return `a resolution step in the ${sem.flowName}`;
      case "scoring-helper":
        return `a scoring step in the ${sem.flowName}`;
      case "orchestrator":
        return `an orchestrator in the ${sem.flowName}`;
      case "service-method":
        return `a method in the ${sem.flowName}`;
      default:
        if (sem.layerName) return `a component of the ${sem.layerName}`;
        return null;
    }
  }

  if (sem.layerName) {
    return `a component of the ${sem.layerName}`;
  }

  return null;
}

export function hierarchyImpactPhrase(
  facts: EntityFacts,
  sem: HierarchySemantics,
): string | null {
  if (!sem.layerName && !sem.flowName) return null;

  const location = sem.flowName ?? sem.layerName!;
  const count = facts.downstreamDependents;

  if (count > 10) {
    return `it sits in the ${location} and feeds ${count} downstream dependents, changes propagate widely through the system`;
  }
  if (facts.callerCount >= 5) {
    return `it is called by ${facts.callerCount} entities in the ${location}`;
  }

  return null;
}
