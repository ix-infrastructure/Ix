import type { EntityFacts } from "./facts.js";

export type ImportanceCategory =
  | "broad-shared-dependency"
  | "pipeline-choke-point"
  | "localized-helper"
  | "normal";

export interface ImportanceInference {
  level: "low" | "medium" | "high";
  category: ImportanceCategory;
  reasons: string[];
}

export function inferImportance(facts: EntityFacts): ImportanceInference {
  const reasons: string[] = [];

  // ── Collect high-level signals ────────────────────────────────────────

  const directlyBroad =
    facts.callerCount >= 8 ||
    facts.dependentCount >= 10 ||
    facts.importerCount >= 5;

  const largeMemberHub =
    facts.memberCount >= 10 && facts.callerCount >= 3;

  const isHigh = directlyBroad || largeMemberHub;

  const isLow =
    facts.dependentCount === 0 &&
    facts.callerCount <= 1 &&
    facts.importerCount === 0 &&
    facts.memberCount <= 1 &&
    facts.downstreamDependents <= 1;

  // Pipeline choke point: few direct callers but large downstream cone
  const isChokePoint =
    facts.callerCount <= 2 &&
    facts.downstreamDependents >= 8;

  // Localized helper: few direct callers, small downstream cone
  const isLocalizedHelper =
    facts.callerCount <= 2 &&
    facts.downstreamDependents <= 3 &&
    !isHigh;

  // ── Determine level + category ────────────────────────────────────────

  if (isChokePoint) {
    // Choke points are always at least high importance regardless of direct counts
    if (facts.dependentCount >= 10) {
      reasons.push(`${facts.dependentCount} direct dependents — widely depended upon`);
    }
    if (facts.callerCount > 0) {
      reasons.push(`Only ${facts.callerCount} direct caller(s)`);
    }
    reasons.push(
      `${facts.downstreamDependents} downstream dependents across ${facts.downstreamDepth} levels — structurally critical pipeline node`,
    );
    return { level: "high", category: "pipeline-choke-point", reasons };
  }

  if (isHigh) {
    if (facts.dependentCount >= 10) {
      reasons.push(`${facts.dependentCount} dependents — widely depended upon`);
    }
    if (facts.callerCount >= 8) {
      reasons.push(`Called by ${facts.callerCount} other entities`);
    }
    if (facts.importerCount >= 5) {
      reasons.push(`Imported by ${facts.importerCount} modules`);
    }
    if (largeMemberHub) {
      reasons.push(`Large entity (${facts.memberCount} members) with ${facts.callerCount} callers`);
    }
    return { level: "high", category: "broad-shared-dependency", reasons };
  }

  if (isLow) {
    reasons.push("Minimal inbound connections — low impact if changed");
    const cat: ImportanceCategory = isLocalizedHelper ? "localized-helper" : "normal";
    return { level: "low", category: cat, reasons };
  }

  // ── Medium ────────────────────────────────────────────────────────────

  if (facts.callerCount > 0) {
    reasons.push(`Called by ${facts.callerCount} other entities`);
  }
  if (facts.dependentCount > 0) {
    reasons.push(`${facts.dependentCount} dependents`);
  }
  if (facts.importerCount > 0) {
    reasons.push(`Imported by ${facts.importerCount} modules`);
  }
  if (facts.downstreamDependents > 3) {
    reasons.push(`${facts.downstreamDependents} downstream dependents`);
  }

  const cat: ImportanceCategory = isLocalizedHelper ? "localized-helper" : "normal";
  return { level: "medium", category: cat, reasons };
}
