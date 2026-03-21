import type { EntityFacts } from "./facts.js";

export type RoleLabel =
  | "test"
  | "configuration"
  | "type-definition"
  | "data-model"
  | "api-client"
  | "entry-point"
  | "registration-function"
  | "service"
  | "service-method"
  | "adapter"
  | "orchestrator"
  | "resolution-helper"
  | "selection-helper"
  | "scoring-helper"
  | "container"
  | "shared-utility"
  | "localized-helper"
  | "unknown";

export interface RoleInference {
  role: RoleLabel;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}

/** Split a name into tokens for camelCase, snake_case, and kebab-case. */
function tokenize(name: string): string[] {
  return name
    .split(/(?=[A-Z])|_|-/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Extract file name (without extension) from a path. */
function fileName(path?: string): string {
  if (!path) return "";
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "").toLowerCase();
}

function nameOrPathContains(facts: EntityFacts, ...terms: string[]): boolean {
  const lower = (facts.name ?? "").toLowerCase();
  const pathLower = (facts.path ?? "").toLowerCase();
  return terms.some((t) => lower.includes(t) || pathLower.includes(t));
}

function pathContains(facts: EntityFacts, ...terms: string[]): boolean {
  const pathLower = (facts.path ?? "").toLowerCase();
  return terms.some((t) => pathLower.includes(t));
}

export function inferRole(facts: EntityFacts): RoleInference {
  const reasons: string[] = [];
  let role: RoleLabel = "unknown";
  let confidence: "low" | "medium" | "high" = "low";

  const tokens = tokenize(facts.name);
  const kind = (facts.kind ?? "").toLowerCase();
  const file = fileName(facts.path);
  const fileTokens = tokenize(file);
  const memberLower = facts.members.map((m) => m.toLowerCase());
  const containerName = facts.container?.name ?? "";
  const containerKind = (facts.container?.kind ?? "").toLowerCase();
  const containerTokens = tokenize(containerName);

  // ── 1. Test ──────────────────────────────────────────────────────────
  if (
    nameOrPathContains(facts, "test", "spec", "__tests__") ||
    tokens.includes("test") ||
    tokens.includes("spec")
  ) {
    role = "test";
    confidence = "high";
    reasons.push("Name or path indicates a test file or test entity");
  }

  // ── 2. Configuration ─────────────────────────────────────────────────
  if (role === "unknown") {
    if (
      kind === "config_entry" ||
      nameOrPathContains(facts, "config", ".env", ".yaml", ".yml", ".toml")
    ) {
      role = "configuration";
      confidence = "high";
      reasons.push("Entity kind or naming indicates configuration");
    }
  }

  // ── 3. Type definition ───────────────────────────────────────────────
  if (role === "unknown") {
    if (
      kind === "interface" ||
      kind === "type" ||
      kind === "type_alias" ||
      tokens.some((t) => ["type", "props", "schema"].includes(t))
    ) {
      role = "type-definition";
      confidence = "high";
      reasons.push("Entity is an interface, type alias, or has type-related naming");
    }
  }

  // ── 4. API client / backend client ───────────────────────────────────
  if (role === "unknown") {
    const apiPathSignals = pathContains(facts, "api", "client", "http");
    const apiNameSignals = tokens.some((t) =>
      ["client", "api"].includes(t),
    );
    const clientMethodNames = new Set([
      "get", "post", "put", "delete", "patch", "fetch", "request",
      "query", "search", "entity", "expand", "ingest",
    ]);
    const clientMethodCount = memberLower.filter((m) => clientMethodNames.has(m)).length;
    const hasClientMethods = clientMethodCount >= 2;

    if (kind === "class" && (apiNameSignals || apiPathSignals) && (hasClientMethods || facts.memberCount > 2)) {
      role = "api-client";
      confidence = "high";
      reasons.push("Class with API/client naming and HTTP-like methods");
      if (facts.callerCount > 0 || facts.dependentCount > 0) {
        reasons.push(`Used by ${facts.callerCount} callers / ${facts.dependentCount} dependents`);
      }
    } else if (
      kind === "class" &&
      hasClientMethods &&
      facts.memberCount > 3 &&
      facts.calleeCount > 0
    ) {
      role = "api-client";
      confidence = "medium";
      reasons.push("Class with multiple HTTP-like methods and outgoing calls");
    }
  }

  // ── 5. Registration function ─────────────────────────────────────────
  if (role === "unknown") {
    const callableKinds = new Set(["function", "method"]);
    if (
      callableKinds.has(kind) &&
      tokens[0] === "register"
    ) {
      role = "registration-function";
      const bootPath = pathContains(facts, "command", "cli", "bootstrap", "main", "register");
      confidence = bootPath ? "high" : "medium";
      reasons.push("Function name starts with 'register'");
      if (bootPath) reasons.push("Located in a CLI/command registration path");
    }
  }

  // ── 6. Selection helper (checked before resolution-helper — more specific) ─
  if (role === "unknown") {
    const selectionNames = ["pick", "best", "select", "choose", "rank", "filter"];
    const hasSelectionName = tokens.some((t) => selectionNames.includes(t));
    const selectionPathSignals = pathContains(facts, "resolve", "select", "pick", "rank", "match");
    const callableKinds = new Set(["function", "method"]);

    if (callableKinds.has(kind) && hasSelectionName) {
      role = "selection-helper";
      confidence = selectionPathSignals ? "high" : "medium";
      reasons.push("Name suggests a selection or ranking function");
      if (selectionPathSignals) reasons.push("Located in a resolution/selection path");
    }
  }

  // ── 7. Scoring helper ────────────────────────────────────────────────
  if (role === "unknown") {
    const scoringNames = ["score", "weight", "rank", "rate", "evaluate"];
    const hasScoringName = tokens.some((t) => scoringNames.includes(t));
    const scoringFilePath = pathContains(facts, "importance", "ranking", "score", "weight");
    const callableKinds = new Set(["function", "method"]);

    if (callableKinds.has(kind) && (hasScoringName || scoringFilePath)) {
      role = "scoring-helper";
      confidence = hasScoringName && scoringFilePath ? "high" : "medium";
      reasons.push("Name or file path suggests a scoring or ranking function");
    }
  }

  // ── 8. Resolution helper ─────────────────────────────────────────────
  if (role === "unknown") {
    const resolveNameSignals = tokens.some((t) =>
      ["resolve", "resolver", "lookup", "match"].includes(t),
    );
    const resolvePathSignals = pathContains(facts, "resolve", "resolver", "match", "lookup");
    const callableKinds = new Set(["function", "method"]);

    if (
      callableKinds.has(kind) &&
      (resolveNameSignals || resolvePathSignals) &&
      facts.calleeCount > 0
    ) {
      role = "resolution-helper";
      confidence = resolveNameSignals && resolvePathSignals ? "high" : "medium";
      reasons.push("Name/path suggests resolution or lookup behavior");
      if (facts.calleeCount > 0) reasons.push(`Calls ${facts.calleeCount} downstream entities`);
    }
  }

  // ── 9. Data model ────────────────────────────────────────────────────
  if (role === "unknown") {
    const modelTerms = ["model", "entity", "record", "dto"];
    const hasModelName =
      kind === "class" && tokens.some((t) => modelTerms.includes(t));
    const isDataClass =
      kind === "class" && facts.callerCount > 0 && facts.calleeCount === 0 && facts.memberCount <= 2;
    if (hasModelName || isDataClass) {
      role = "data-model";
      confidence = hasModelName ? "high" : "medium";
      if (hasModelName) reasons.push("Class name suggests a data model");
      if (isDataClass) reasons.push("Class has callers but makes no outgoing calls and has few members");
    }
  }

  // ── 10. Entry point ──────────────────────────────────────────────────
  if (role === "unknown") {
    const callableKinds = new Set(["function", "method"]);
    if (
      facts.callerCount === 0 &&
      facts.calleeCount > 0 &&
      callableKinds.has(kind)
    ) {
      role = "entry-point";
      const entryNames = ["main", "run", "start", "handler", "execute"];
      const isNamedEntry = tokens.some((t) => entryNames.includes(t));
      confidence = isNamedEntry ? "high" : "medium";
      reasons.push("Function has no callers but calls other entities");
      if (isNamedEntry) reasons.push("Name suggests an entry point");
    }
  }

  // ── 11. Service ──────────────────────────────────────────────────────
  if (role === "unknown") {
    const containerKindSet = new Set(["class", "object"]);
    const serviceTerms = ["service", "manager", "provider", "handler", "controller", "coordinator"];
    if (
      containerKindSet.has(kind) &&
      facts.memberCount > 2 &&
      tokens.some((t) => serviceTerms.includes(t))
    ) {
      role = "service";
      confidence = "high";
      reasons.push("Class/object with multiple members and service-like naming");
    }
  }

  // ── 12. Service method (container-aware) ─────────────────────────────
  if (role === "unknown") {
    const callableKinds = new Set(["function", "method"]);
    const serviceTerms = ["service", "manager", "provider", "handler", "controller", "coordinator"];
    const containerIsService =
      containerKind === "class" &&
      containerTokens.some((t) => serviceTerms.includes(t));

    if (callableKinds.has(kind) && containerIsService) {
      role = "service-method";
      confidence = "high";
      reasons.push(`Method inside ${containerName}`);
    }
  }

  // ── 13. Adapter ──────────────────────────────────────────────────────
  if (role === "unknown") {
    if (nameOrPathContains(facts, "adapter", "connector", "gateway", "proxy")) {
      role = "adapter";
      confidence = "medium";
      reasons.push("Name or path suggests an adapter or external integration");
    }
  }

  // ── 14. Orchestrator ────────────────────────────────────────────────
  if (role === "unknown") {
    if (facts.calleeCount >= 5 && facts.callerCount <= 2) {
      role = "orchestrator";
      confidence = "medium";
      reasons.push(`Calls ${facts.calleeCount} entities but has only ${facts.callerCount} callers`);
    }
  }

  // ── 15. Container ───────────────────────────────────────────────────
  if (role === "unknown") {
    const containerKindSet = new Set(["file", "module"]);
    if (containerKindSet.has(kind) && facts.memberCount > 0) {
      role = "container";
      confidence = "high";
      reasons.push(`${kind} containing ${facts.memberCount} members`);
    }
  }

  // ── 16. Shared utility (many direct callers) ────────────────────────
  if (role === "unknown") {
    if (
      facts.callerCount >= 3 &&
      facts.memberCount === 0 &&
      facts.calleeCount <= 2
    ) {
      role = "shared-utility";
      confidence = "medium";
      reasons.push(`Called by ${facts.callerCount} entities with no members — widely shared utility`);
    }
  }

  // ── 17. Localized helper ────────────────────────────────────────────
  if (role === "unknown") {
    const callableKinds = new Set(["function", "method"]);
    if (
      callableKinds.has(kind) &&
      facts.callerCount >= 1 &&
      facts.callerCount <= 2 &&
      facts.calleeCount > 0
    ) {
      role = "localized-helper";
      confidence = "medium";
      reasons.push(`Few callers (${facts.callerCount}) with outgoing calls — appears to be a localized helper`);
    }
  }

  // ── 18. Context-aware fallback (no more "role could not be determined") ──
  if (role === "unknown") {
    const callableKinds = new Set(["function", "method"]);

    if (callableKinds.has(kind) && containerName) {
      // Method/function inside a known container
      role = "localized-helper";
      confidence = "low";
      reasons.push(`${kind} within ${containerName}`);
    } else if (callableKinds.has(kind) && facts.path) {
      // Function in a known file
      role = "localized-helper";
      confidence = "low";
      reasons.push(`${kind} defined in ${fileName(facts.path)}`);
    } else if (kind === "class" || kind === "object") {
      role = "localized-helper";
      confidence = "low";
      reasons.push(`${kind} with limited structural signals`);
    } else {
      // Truly minimal — still avoid "role could not be determined"
      confidence = "low";
      if (facts.path) {
        reasons.push(`Defined in ${fileName(facts.path)}`);
      } else if (containerName) {
        reasons.push(`Located within ${containerName}`);
      } else {
        reasons.push("Limited structural signals available");
      }
    }
  }

  return { role, confidence, reasons };
}
