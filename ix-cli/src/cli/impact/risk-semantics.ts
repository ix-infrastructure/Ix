/**
 * Risk-semantics inference for ix impact.
 *
 * Categorizes a target entity as foundation / flow / boundary / shared / localized / unknown
 * and produces risk-level, at-risk-behavior, and risk-summary language that the
 * impact command renders at the top of its output.
 */

export type RiskCategory =
  | "foundation"
  | "flow"
  | "boundary"
  | "localized"
  | "shared"
  | "unknown";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RiskSemantics {
  category: RiskCategory;
  riskLevel: RiskLevel;
  /** One-sentence risk summary for the top of impact output. */
  riskSummary: string;
  /** 1–3 concrete behaviors/use-cases at risk. */
  behaviorAtRisk: string[];
  /** Free-form contextual label for the "most affected" section. */
  mostAffectedHint?: string;
  reasons: string[];
  /** Specific role phrase for flow-category entities. */
  flowRole?: string;
  /** Flow-centric propagation aggregate for methods/functions. */
  flowPropagation?: { flowName: string; count: number };
  /** Suggested next command for the user. */
  nextStep?: string;
}

// ── Input shape (subset of what impact.ts already collects) ──────────────────

export interface ImpactFacts {
  name: string;
  kind: string;
  path?: string;

  // Container (class/module name wrapping this entity)
  container?: { kind: string; name: string };

  // System hierarchy path (root-first)
  systemPath?: Array<{ name: string; kind: string }>;

  // Counts
  members: number;
  callers: number;
  callees: number;
  directImporters: number;
  directDependents: number;
  memberLevelCallers: number;

  // Propagation buckets (already computed by impact.ts)
  propagationBuckets: Array<{ region: string; regionKind: string; count: number }>;

  // Top caller names (populated by leaf impact)
  topCallerNames?: string[];
}

// ── Token helpers ────────────────────────────────────────────────────────────

function splitTokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-./]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function fileBaseName(path?: string): string {
  if (!path) return "";
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

function allTokens(facts: ImpactFacts): string[] {
  const out: string[] = [];
  out.push(...splitTokens(facts.name));
  if (facts.path) out.push(...splitTokens(fileBaseName(facts.path)));
  if (facts.container) out.push(...splitTokens(facts.container.name));
  if (facts.systemPath) {
    for (const n of facts.systemPath) {
      out.push(...splitTokens(n.name));
    }
  }
  return out;
}

function humanSubsystems(facts: ImpactFacts): string[] {
  if (!facts.systemPath) return [];
  return facts.systemPath
    .filter((n) => ["subsystem", "module", "region"].includes(n.kind))
    .map((n) => n.name);
}

// ── Humanize labels ─────────────────────────────────────────────────────────

const ABBREVIATIONS: Record<string, string> = {
  cli: "CLI",
  api: "API",
  db: "database",
  github: "GitHub",
};

const SUBSYSTEM_MAPPINGS: Record<string, string> = {
  explain: "explanation",
  impact: "impact analysis",
  resolve: "resolution",
  resolution: "resolution",
  conflict: "conflict-resolution",
  ingestion: "ingestion",
  parsers: "parser",
};

function humanizePart(part: string): string {
  const trimmed = part.trim();
  const lower = trimmed.toLowerCase();

  // Check subsystem mappings first
  if (SUBSYSTEM_MAPPINGS[lower]) return SUBSYSTEM_MAPPINGS[lower];

  // Check abbreviations
  if (ABBREVIATIONS[lower]) return ABBREVIATIONS[lower];

  // Default: lowercase
  return lower;
}

export function humanizeLabel(raw: string): string {
  // Strip trailing parenthetical suffixes like " (2f)", " (region)"
  const stripped = raw.replace(/\s*\([^)]*\)\s*$/, "");

  // Split on " / "
  const parts = stripped.split(" / ").map(humanizePart);

  if (parts.length >= 2) {
    // When first part is an abbreviation (CLI, API), it acts as a modifier → space-join
    const first = parts[0];
    const isAbbrev = first === first.toUpperCase() && first.length >= 2 && first.length <= 4;
    const joiner = isAbbrev ? " " : " and ";
    return `${parts.join(joiner)} layer`;
  }

  return `${parts[0]} layer`;
}

// ── Kind sets ────────────────────────────────────────────────────────────────

const TYPE_KINDS = new Set([
  "interface", "type", "type_alias", "enum", "sealed_trait",
  "trait", "abstract_class",
]);

const CONTAINER_KINDS = new Set([
  "class", "module", "file", "object", "trait", "interface",
]);

const CALLABLE_KINDS = new Set([
  "function", "method", "def", "fun", "constructor",
]);

// ── Flow detection (reuses token patterns from flow-semantics.ts) ────────────

interface FlowMatch {
  flowName: string;
  behaviorDomain: string;
}

const FLOW_PATTERNS: Array<{ triggers: string[]; flowName: string; behaviorDomain: string }> = [
  { triggers: ["conflict", "merge", "conflicts"], flowName: "conflict-resolution", behaviorDomain: "conflict handling" },
  { triggers: ["resolve", "resolution", "match", "select", "pick", "lookup", "resolver", "matcher", "selector"], flowName: "resolution", behaviorDomain: "entity resolution" },
  { triggers: ["parse", "decode", "read", "tokenize", "lex", "parser", "decoder", "reader", "lexer"], flowName: "parsing", behaviorDomain: "input parsing" },
  { triggers: ["impact"], flowName: "impact analysis", behaviorDomain: "impact analysis" },
  { triggers: ["explain", "render"], flowName: "explanation", behaviorDomain: "explanation generation" },
  { triggers: ["ingest", "store", "persist", "save", "ingestion"], flowName: "ingestion", behaviorDomain: "file ingestion" },
  { triggers: ["score", "rank", "weight", "evaluate"], flowName: "scoring", behaviorDomain: "candidate scoring" },
];

function detectFlow(tokens: string[]): FlowMatch | undefined {
  for (const p of FLOW_PATTERNS) {
    if (p.triggers.some((t) => tokens.includes(t))) {
      return { flowName: p.flowName, behaviorDomain: p.behaviorDomain };
    }
  }
  return undefined;
}

// ── Flow role inference ──────────────────────────────────────────────────────

const FLOW_ROLE_PATTERNS: Array<{ triggers: string[]; role: string }> = [
  { triggers: ["pick", "select", "best", "filter", "choose"], role: "candidate selection" },
  { triggers: ["resolve", "lookup", "match"], role: "reference resolution" },
  { triggers: ["conflict", "merge"], role: "conflict resolution" },
  { triggers: ["score", "rank", "evaluate"], role: "candidate scoring" },
  { triggers: ["parse", "decode", "tokenize"], role: "input parsing" },
  { triggers: ["render"], role: "output rendering" },
  { triggers: ["infer"], role: "semantic inference" },
  { triggers: ["ingest", "store", "persist"], role: "data ingestion" },
];

function inferFlowRole(tokens: string[], flow?: FlowMatch): string | undefined {
  for (const p of FLOW_ROLE_PATTERNS) {
    if (p.triggers.some((t) => tokens.includes(t))) {
      return p.role;
    }
  }
  return flow?.behaviorDomain;
}

// ── Model/API signals ────────────────────────────────────────────────────────

function hasModelSignal(tokens: string[]): boolean {
  return tokens.some((t) => ["model", "models", "schema", "db", "database", "entity", "entities", "domain"].includes(t));
}

// ── Domain noun (mirrors system-meaning.ts) ──────────────────────────────────

function inferDomainNoun(name: string): string {
  const tokens = splitTokens(name);
  if (tokens.includes("node")) return "node";
  if (tokens.includes("edge")) return "edge";
  if (tokens.includes("graph")) return "graph";
  if (tokens.includes("parse") || tokens.includes("parser")) return "parse result";
  if (tokens.includes("context")) return "context";
  if (tokens.includes("entity")) return "entity";
  if (tokens.includes("patch")) return "patch";
  if (tokens.includes("query")) return "query";
  if (tokens.includes("config")) return "configuration";
  if (tokens.includes("user")) return "user";
  return "domain";
}

// ── Propagation layer names ──────────────────────────────────────────────────

function propagationLayerPhrase(facts: ImpactFacts): string {
  const subs = humanSubsystems(facts);
  if (subs.length >= 2) {
    const humanized = subs.slice(0, 2).map((s) => humanizeLabel(s));
    return `the ${humanized.join(" and ")}`;
  }
  if (subs.length === 1) return `the ${humanizeLabel(subs[0])}`;

  // Fall back to propagation buckets
  const regions = facts.propagationBuckets
    .filter((b) => b.region !== "(unmapped)")
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((b) => humanizeLabel(b.region));
  if (regions.length >= 2) return `the ${regions[0]} and ${regions[1]}`;
  if (regions.length === 1) return `the ${regions[0]}`;
  return "dependent subsystems";
}

// ── Category detection ───────────────────────────────────────────────────────

function detectCategory(facts: ImpactFacts): { category: RiskCategory; reasons: string[] } {
  const kind = facts.kind.toLowerCase();
  const tokens = allTokens(facts);

  // Foundation: type definitions, enums, interfaces, shared model files
  if (TYPE_KINDS.has(kind)) {
    return { category: "foundation", reasons: [`kind "${kind}" is a type-level construct`] };
  }
  if (kind === "file" && hasModelSignal(tokens) && facts.members > 0) {
    return { category: "foundation", reasons: ["model file containing type definitions"] };
  }

  // Boundary: classes/objects named *Client, *Adapter, or in client/api paths
  if (CONTAINER_KINDS.has(kind)) {
    const nameTokens = splitTokens(facts.name);
    if (nameTokens.includes("client") || nameTokens.includes("adapter")) {
      return { category: "boundary", reasons: [`name "${facts.name}" indicates a boundary component`] };
    }
    if (tokens.some((t) => ["client", "api", "backend"].includes(t)) &&
        (facts.callers > 5 || facts.memberLevelCallers > 10)) {
      return { category: "boundary", reasons: ["high-caller class in client/API path"] };
    }
  }

  // Flow: callable entities or service classes in flow-related paths
  const flow = detectFlow(tokens);
  if (flow && (CALLABLE_KINDS.has(kind) || kind === "method")) {
    return { category: "flow", reasons: [`callable in ${flow.flowName} flow`] };
  }
  if (flow && CONTAINER_KINDS.has(kind) && tokens.some((t) => ["service"].includes(t))) {
    return { category: "flow", reasons: [`service class in ${flow.flowName} flow`] };
  }

  // Shared: high fan-in containers that aren't boundary
  if (CONTAINER_KINDS.has(kind) && (facts.directImporters >= 5 || facts.directDependents >= 8 || facts.memberLevelCallers >= 20)) {
    return { category: "shared", reasons: ["high fan-in container"] };
  }

  // Shared: high fan-in callables
  if (CALLABLE_KINDS.has(kind) && facts.callers >= 5) {
    return { category: "shared", reasons: ["widely-called function"] };
  }

  // Localized: low connectivity
  const totalFanIn = facts.callers + facts.directImporters + facts.directDependents;
  if (totalFanIn <= 2) {
    return { category: "localized", reasons: ["limited inbound connections"] };
  }

  return { category: "unknown", reasons: ["no strong category signals"] };
}

// ── Risk level ───────────────────────────────────────────────────────────────

function computeRiskLevel(facts: ImpactFacts, category: RiskCategory): RiskLevel {
  const totalDependents = facts.directImporters + facts.directDependents + facts.memberLevelCallers;
  const bucketCount = facts.propagationBuckets.filter((b) => b.region !== "(unmapped)").length;

  if (category === "foundation") {
    if (facts.directImporters >= 5 || totalDependents >= 10) return "critical";
    if (facts.directImporters >= 2 || totalDependents >= 4) return "high";
    return "medium";
  }

  if (category === "boundary") {
    if (facts.memberLevelCallers >= 30 || bucketCount >= 3) return "critical";
    if (facts.memberLevelCallers >= 10 || totalDependents >= 10) return "high";
    return "medium";
  }

  if (category === "flow") {
    if (facts.callers >= 5 || totalDependents >= 10) return "high";
    if (facts.callers >= 2) return "medium";
    // Even single-caller flow nodes can be medium if they're choke points
    if (facts.callees >= 3) return "medium";
    return "low";
  }

  if (category === "shared") {
    if (totalDependents >= 15 || bucketCount >= 3) return "high";
    if (totalDependents >= 5) return "medium";
    return "medium";
  }

  if (category === "localized") return "low";

  // unknown
  if (totalDependents >= 10) return "medium";
  return "low";
}

// ── Risk summary sentence ────────────────────────────────────────────────────

function buildRiskSummary(facts: ImpactFacts, category: RiskCategory, riskLevel: RiskLevel): string {
  const level = riskLevel === "critical" ? "High" : capitalize(riskLevel);
  const tokens = allTokens(facts);
  const domain = inferDomainNoun(facts.name);
  const layers = propagationLayerPhrase(facts);

  switch (category) {
    case "foundation": {
      const noun = domain === "domain" ? "shared type" : `shared ${domain}`;
      let summary = `${level} risk to ${noun} interpretation across ${layers}.`;
      if (facts.directImporters >= 5) {
        summary = summary.replace(/\.$/, `, imported as a shared contract by ${facts.directImporters} modules.`);
      }
      return summary;
    }
    case "boundary":
      return `${level} risk to backend-facing CLI operations through the ${facts.name} boundary.`;
    case "flow": {
      const flow = detectFlow(tokens);
      const flowRole = inferFlowRole(splitTokens(facts.name), flow);
      const flowName = flow?.flowName ?? "pipeline";
      if (flowRole) {
        return `${level} risk to ${flowRole} in the ${flowName} flow.`;
      }
      const flowLabel = flow ? flow.behaviorDomain : "pipeline processing";
      return `${level} risk to ${flowLabel} in the ${flowName} flow.`;
    }
    case "shared":
      return `${level} risk — widely shared dependency affecting ${layers}.`;
    case "localized":
      return `${level} risk — localized impact with limited propagation.`;
    default:
      return `${level} risk to dependent code.`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── At-risk behavior ─────────────────────────────────────────────────────────

function buildBehaviorAtRisk(facts: ImpactFacts, category: RiskCategory): string[] {
  const tokens = allTokens(facts);
  const domain = inferDomainNoun(facts.name);
  const flow = detectFlow(tokens);

  switch (category) {
    case "foundation": {
      const behaviors: string[] = [];
      const domainLabel = domain === "domain" ? "type" : domain;
      behaviors.push(`${capitalize(domainLabel)} classification and interpretation`);
      if (facts.directImporters >= 3) {
        behaviors.push(`Widely imported (${facts.directImporters} modules) as a shared ${domainLabel} contract`);
      } else if (facts.directImporters >= 2) {
        behaviors.push(`Cross-module consistency for ${domainLabel} contracts`);
      }
      if (facts.members > 0) {
        behaviors.push(`Downstream services that depend on ${domainLabel} type definitions`);
      } else {
        behaviors.push(`Downstream code relying on shared ${domainLabel} representation`);
      }
      return behaviors;
    }

    case "boundary": {
      const behaviors: string[] = [];
      behaviors.push("Backend-facing CLI commands");
      behaviors.push("Command-to-service communication");
      if (facts.members > 5) {
        behaviors.push(`API request behavior across ${facts.members} client methods`);
      } else {
        behaviors.push("API request behavior across the client layer");
      }
      return behaviors;
    }

    case "flow": {
      const behaviors: string[] = [];
      const flowLabel = flow?.behaviorDomain ?? "processing";
      if (tokens.some((t) => ["pick", "select", "best", "filter", "choose"].includes(t))) {
        behaviors.push(`Candidate selection during ${flowLabel}`);
      } else if (tokens.some((t) => ["resolve", "lookup", "match"].includes(t))) {
        behaviors.push(`Reference resolution during ${flowLabel}`);
      } else if (tokens.some((t) => ["conflict", "merge"].includes(t))) {
        behaviors.push(`Conflict handling logic`);
      } else {
        behaviors.push(`${capitalize(flowLabel)} outcomes`);
      }
      const flowName = flow?.flowName ?? "pipeline";
      behaviors.push(`Downstream ${flowName} steps`);
      if (facts.callers > 0) {
        behaviors.push(`Upstream callers that depend on ${flowLabel} results`);
      }
      return behaviors;
    }

    case "shared": {
      const behaviors: string[] = [];
      behaviors.push("Multiple callers across different subsystems");
      if (facts.callees > 0) {
        behaviors.push("Downstream operations coordinated by this component");
      }
      behaviors.push("Cross-module behavior consistency");
      return behaviors;
    }

    case "localized":
      return ["Limited to immediate callers"];

    default:
      return ["Dependent code behavior"];
  }
}

// ── Most-affected hint ───────────────────────────────────────────────────────

function buildMostAffectedHint(facts: ImpactFacts, category: RiskCategory): string | undefined {
  const domain = inferDomainNoun(facts.name);
  const tokens = allTokens(facts);

  switch (category) {
    case "foundation":
      if (domain !== "domain") {
        return `model types and parsers that depend on ${domain} classification`;
      }
      return "modules that import shared type contracts";
    case "boundary":
      return "command handlers that depend on client access";
    case "flow": {
      const flow = detectFlow(tokens);
      const flowName = flow?.flowName ?? "processing";
      const flowRole = inferFlowRole(splitTokens(facts.name), flow);
      const hints: string[] = [];
      if (facts.topCallerNames && facts.topCallerNames.length > 0) {
        hints.push(`${flowName} entrypoints like ${facts.topCallerNames[0]}`);
      } else {
        hints.push(`upstream callers in the ${flowName} flow`);
      }
      hints.push(`downstream ${flowRole ?? flowName} stages`);
      return hints.join("; ");
    }
    case "shared":
      return "callers across multiple subsystems";
    default:
      return undefined;
  }
}

// ── Next step ────────────────────────────────────────────────────────────────

function buildNextStep(facts: ImpactFacts, category: RiskCategory): string | undefined {
  if ((category === "foundation" || category === "shared") && facts.directImporters >= 3) {
    return `Understand its system role: ix explain ${facts.name}`;
  }
  if (category === "boundary" && facts.memberLevelCallers >= 10) {
    return `Trace propagation: ix depends ${facts.name} --depth 2`;
  }
  if (category === "flow" && facts.callers >= 1) {
    return `Trace flow propagation: ix depends ${facts.name} --depth 2`;
  }
  return undefined;
}

// ── Flow propagation ─────────────────────────────────────────────────────────

function buildFlowPropagation(
  facts: ImpactFacts,
  category: RiskCategory,
  tokens: string[],
): { flowName: string; count: number } | undefined {
  if (category !== "flow") return undefined;
  const flow = detectFlow(tokens);
  if (!flow) return undefined;
  const totalCount = facts.propagationBuckets.reduce((sum, b) => sum + b.count, 0);
  if (totalCount === 0) return undefined;
  return { flowName: flow.flowName, count: totalCount };
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function inferRiskSemantics(facts: ImpactFacts): RiskSemantics {
  const { category, reasons } = detectCategory(facts);
  const riskLevel = computeRiskLevel(facts, category);
  const riskSummary = buildRiskSummary(facts, category, riskLevel);
  const behaviorAtRisk = buildBehaviorAtRisk(facts, category);
  const mostAffectedHint = buildMostAffectedHint(facts, category);
  const tokens = allTokens(facts);
  const flow = detectFlow(tokens);
  const flowRole = category === "flow" ? inferFlowRole(splitTokens(facts.name), flow) : undefined;
  const flowPropagation = buildFlowPropagation(facts, category, tokens);
  const nextStep = buildNextStep(facts, category);

  return {
    category,
    riskLevel,
    riskSummary,
    behaviorAtRisk,
    mostAffectedHint,
    reasons,
    flowRole,
    flowPropagation,
    nextStep,
  };
}
