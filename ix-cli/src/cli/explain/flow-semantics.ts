import type { EntityFacts } from "./facts.js";

export interface FlowSemantics {
  confidence: "low" | "medium" | "high";
  flowName?: string;
  roleInFlow?: string;
  upstreamHint?: string;
  downstreamHint?: string;
}

interface FlowRule {
  namePat?: RegExp;
  pathPat?: RegExp;
  containerPat?: RegExp;
  flowName: string;
  roleInFlow: string;
  priority: number;
}

// Rules ordered by priority (higher = checked later, wins ties)
const FLOW_RULES: FlowRule[] = [
  { namePat: /parse|tokenize|lex/i, pathPat: /parser/i, flowName: "parsing pipeline", roleInFlow: "parsing step", priority: 1 },
  { namePat: /parse|tokenize|lex/i, flowName: "parsing pipeline", roleInFlow: "parsing step", priority: 1 },
  { namePat: /resolve|lookup/i, pathPat: /resolve/i, flowName: "resolution flow", roleInFlow: "resolution step", priority: 2 },
  { namePat: /pick|select|choose|rank/i, pathPat: /resolve/i, flowName: "resolution flow", roleInFlow: "selection step", priority: 3 },
  { namePat: /score|weight/i, flowName: "scoring pipeline", roleInFlow: "scoring step", priority: 1 },
  { namePat: /rank/i, flowName: "ranking pipeline", roleInFlow: "ranking step", priority: 1 },
  { namePat: /ingest|index/i, flowName: "ingestion pipeline", roleInFlow: "ingestion step", priority: 1 },
  { namePat: /persist|save|store/i, flowName: "ingestion pipeline", roleInFlow: "persistence step", priority: 1 },
  { namePat: /render|format|display/i, flowName: "rendering pipeline", roleInFlow: "rendering step", priority: 1 },
  { namePat: /impact|traverse|walk/i, flowName: "impact pipeline", roleInFlow: "traversal step", priority: 1 },
  { namePat: /explain|infer|synthesize/i, flowName: "explanation pipeline", roleInFlow: "inference step", priority: 1 },
  // Container-based rules
  { containerPat: /IngestionService/i, flowName: "ingestion pipeline", roleInFlow: "ingestion step", priority: 2 },
  { containerPat: /ConflictService/i, flowName: "conflict-resolution flow", roleInFlow: "conflict resolver", priority: 4 },
  { containerPat: /Parser/i, flowName: "parsing pipeline", roleInFlow: "parsing step", priority: 2 },
  { containerPat: /Scorer|Ranker/i, flowName: "scoring pipeline", roleInFlow: "scoring step", priority: 2 },
  // Path-based for conflict
  { pathPat: /conflict/i, namePat: /resolve|conflict/i, flowName: "conflict-resolution flow", roleInFlow: "conflict resolver", priority: 5 },
  { pathPat: /conflict/i, flowName: "conflict-resolution flow", roleInFlow: "conflict resolution step", priority: 3 },
];

export function inferFlowSemantics(facts: EntityFacts): FlowSemantics {
  const path = facts.path ?? "";
  const name = facts.name ?? "";
  const containerName = facts.container?.name ?? "";

  let best: { rule: FlowRule; score: number } | null = null;

  for (const rule of FLOW_RULES) {
    let score = 0;
    let matches = true;

    if (rule.namePat) {
      if (rule.namePat.test(name)) score += 2;
      else if (!rule.pathPat && !rule.containerPat) { matches = false; continue; }
      else if (!rule.pathPat?.test(path) && !rule.containerPat?.test(containerName)) { matches = false; continue; }
    }

    if (rule.pathPat) {
      if (rule.pathPat.test(path)) score += 2;
      else if (!rule.namePat?.test(name) && !rule.containerPat?.test(containerName)) { matches = false; continue; }
    }

    if (rule.containerPat) {
      if (rule.containerPat.test(containerName)) score += 3;
      else if (rule.containerPat && !rule.namePat && !rule.pathPat) { matches = false; continue; }
    }

    if (!matches || score === 0) continue;

    const totalScore = score + rule.priority;
    if (!best || totalScore > best.score) {
      best = { rule, score: totalScore };
    }
  }

  if (!best) {
    return { confidence: "low" };
  }

  // Determine confidence based on how many signals matched
  const confidence: "low" | "medium" | "high" = best.score >= 5 ? "high" : best.score >= 3 ? "medium" : "low";

  // Build hints
  let upstreamHint: string | undefined;
  let downstreamHint: string | undefined;

  if (facts.topCallers.length > 0) {
    upstreamHint = `called from ${facts.topCallers[0]}`;
  }
  if (facts.downstreamDependents > 0) {
    downstreamHint = `feeds ${facts.downstreamDependents} downstream dependents`;
  }

  return {
    confidence,
    flowName: best.rule.flowName,
    roleInFlow: best.rule.roleInFlow,
    upstreamHint,
    downstreamHint,
  };
}
