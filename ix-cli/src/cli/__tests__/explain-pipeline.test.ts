import { describe, it, expect } from "vitest";
import { inferRole } from "../explain/role-inference.js";
import { inferImportance } from "../explain/importance.js";
import { renderExplanation } from "../explain/render.js";
import { inferHierarchySemantics, synthesizeSystemRole, hierarchyImpactPhrase } from "../explain/hierarchy-semantics.js";
import { inferSystemMeaning } from "../explain/system-meaning.js";
import type { EntityFacts } from "../explain/facts.js";

function makeFacts(overrides: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "test-id-1234",
    name: "SomeEntity",
    kind: "function",
    path: "src/example.ts",
    signature: undefined,
    docstring: undefined,
    container: undefined,
    members: [],
    memberCount: 0,
    callerCount: 2,
    calleeCount: 1,
    dependentCount: 3,
    importerCount: 1,
    downstreamDependents: 4,
    downstreamDepth: 2,
    topCallers: [],
    topDependents: [],
    introducedRev: 1,
    historyLength: 2,
    callList: undefined,
    stale: false,
    diagnostics: [],
    ...overrides,
  };
}

// ── Role inference ──────────────────────────────────────────────────────────

describe("inferRole", () => {
  it("detects test entities by name", () => {
    const facts = makeFacts({ name: "AuthServiceTest", path: "src/__tests__/auth.ts" });
    const result = inferRole(facts);
    expect(result.role).toBe("test");
    expect(result.confidence).toBe("high");
  });

  it("detects test entities by path containing spec", () => {
    const facts = makeFacts({ name: "describe", path: "src/auth.spec.ts" });
    const result = inferRole(facts);
    expect(result.role).toBe("test");
  });

  it("detects configuration entities", () => {
    const facts = makeFacts({ kind: "config_entry", name: "databaseConfig" });
    const result = inferRole(facts);
    expect(result.role).toBe("configuration");
    expect(result.confidence).toBe("high");
  });

  it("detects type definitions", () => {
    const facts = makeFacts({ kind: "interface", name: "UserProps" });
    const result = inferRole(facts);
    expect(result.role).toBe("type-definition");
    expect(result.confidence).toBe("high");
  });

  it("detects API client by class name and methods", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      calleeCount: 0,
      dependentCount: 20,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("api-client");
    expect(result.confidence).toBe("high");
  });

  it("detects API client even without path signals if methods match", () => {
    const facts = makeFacts({
      kind: "class",
      name: "BackendClient",
      path: "src/service.ts",
      memberCount: 5,
      members: ["get", "post", "delete", "fetch"],
      callerCount: 4,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("api-client");
  });

  it("does NOT classify IxClient-like class as data-model", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get"],
      callerCount: 12,
      calleeCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).not.toBe("data-model");
  });

  it("detects registration functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "registerExplainCommand",
      path: "src/cli/commands/explain.ts",
      callerCount: 1,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("registration-function");
    expect(result.confidence).toBe("high");
  });

  it("detects resolution helpers", () => {
    const facts = makeFacts({
      kind: "function",
      name: "resolveFileOrEntity",
      path: "src/cli/resolve.ts",
      callerCount: 10,
      calleeCount: 5,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("resolution-helper");
  });

  it("detects selection helpers like pickBest", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("selection-helper");
    expect(result.reasons.some((r) => r.includes("selection"))).toBe(true);
  });

  it("detects scoring helpers by name", () => {
    const facts = makeFacts({
      kind: "function",
      name: "scoreCandidate",
      path: "src/cli/importance.ts",
      callerCount: 2,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("detects scoring helpers by file path", () => {
    const facts = makeFacts({
      kind: "function",
      name: "evaluate",
      path: "src/ranking/score.ts",
      callerCount: 3,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("detects services by naming and structure", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["ingest", "parse", "validate", "store", "notify"],
    });
    const result = inferRole(facts);
    expect(result.role).toBe("service");
    expect(result.confidence).toBe("high");
  });

  it("detects service methods via container context", () => {
    const facts = makeFacts({
      kind: "method",
      name: "processPayment",
      path: "src/billing.ts",
      container: { kind: "class", name: "PaymentService" },
      callerCount: 3,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("service-method");
    expect(result.confidence).toBe("high");
    expect(result.reasons.some((r) => r.includes("PaymentService"))).toBe(true);
  });

  it("detects entry points (no callers, has callees)", () => {
    const facts = makeFacts({
      kind: "function",
      name: "main",
      callerCount: 0,
      calleeCount: 3,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("entry-point");
    expect(result.confidence).toBe("high");
  });

  it("detects shared utility functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "formatDate",
      callerCount: 5,
      calleeCount: 0,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("shared-utility");
    expect(result.confidence).toBe("medium");
  });

  it("detects adapters by name", () => {
    const facts = makeFacts({
      kind: "class",
      name: "DatabaseGateway",
      callerCount: 2,
      calleeCount: 3,
      memberCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("adapter");
  });

  it("detects localized helpers", () => {
    const facts = makeFacts({
      kind: "function",
      name: "doStuff",
      callerCount: 1,
      calleeCount: 1,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("localized-helper");
    expect(result.confidence).toBe("medium");
  });

  it("uses container context for unknown-fallback functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      container: { kind: "class", name: "Foo" },
    });
    const result = inferRole(facts);
    // Should NOT say "role could not be determined"
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
    expect(result.reasons.some((r) => r.includes("Foo"))).toBe(true);
  });

  it("uses file context for unknown-fallback functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "x",
      path: "src/cli/helpers.ts",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
    expect(result.reasons.some((r) => r.includes("helpers"))).toBe(true);
  });

  it("never says 'role could not be determined' for entities with file context", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const result = inferRole(facts);
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
  });
});

// ── Importance inference ────────────────────────────────────────────────────

describe("inferImportance", () => {
  it("marks high importance for many dependents (broad-shared-dependency)", () => {
    const facts = makeFacts({ dependentCount: 12, callerCount: 8, downstreamDependents: 20 });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("broad-shared-dependency");
    expect(result.reasons.some((r) => r.includes("dependents"))).toBe(true);
  });

  it("marks high importance for many callers", () => {
    const facts = makeFacts({ callerCount: 10, downstreamDependents: 15 });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("broad-shared-dependency");
  });

  it("marks low importance for isolated entities", () => {
    const facts = makeFacts({
      dependentCount: 0,
      callerCount: 0,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 0,
      downstreamDepth: 0,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("low");
  });

  it("marks medium importance for moderate connectivity", () => {
    const facts = makeFacts({
      dependentCount: 3,
      callerCount: 2,
      importerCount: 1,
      downstreamDependents: 5,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("medium");
    expect(result.category).toBe("normal");
  });

  it("detects pipeline choke point (low callers, high downstream)", () => {
    const facts = makeFacts({
      callerCount: 1,
      dependentCount: 2,
      importerCount: 0,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("pipeline-choke-point");
    expect(result.reasons.some((r) => r.includes("downstream dependents"))).toBe(true);
  });

  it("detects localized helper (low callers, small downstream)", () => {
    const facts = makeFacts({
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const result = inferImportance(facts);
    expect(result.category).toBe("localized-helper");
  });

  it("does NOT mark as choke point if callers are high", () => {
    const facts = makeFacts({
      callerCount: 8,
      downstreamDependents: 30,
    });
    const result = inferImportance(facts);
    expect(result.category).toBe("broad-shared-dependency");
    expect(result.category).not.toBe("pipeline-choke-point");
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("renderExplanation", () => {
  it("uses confident language for high-confidence roles", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).not.toContain("appears to be");
  });

  it("uses hedged language for low-confidence roles", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("appears to be");
  });

  it("includes container context in explanation for service methods", () => {
    const facts = makeFacts({
      kind: "method",
      name: "resolve",
      container: { kind: "class", name: "ConflictService" },
      callerCount: 3,
      calleeCount: 2,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("ConflictService");
  });

  it("includes container context when present", () => {
    const facts = makeFacts({
      container: { kind: "class", name: "OrderService" },
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).toContain("Container: class OrderService");
  });

  it("includes downstream dependents in context", () => {
    const facts = makeFacts({ downstreamDependents: 15, downstreamDepth: 3 });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).toContain("Downstream dependents: 15");
  });

  it("renders named usage examples when callers exist", () => {
    const facts = makeFacts({
      callerCount: 5,
      topCallers: ["registerImpactCommand", "registerOverviewCommand", "registerExplainCommand"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.usedBy).not.toBeNull();
    expect(rendered.usedBy).toContain("registerImpactCommand");
    expect(rendered.usedBy).toContain("registerOverviewCommand");
  });

  it("returns null usedBy when no examples available", () => {
    const facts = makeFacts({ callerCount: 0, topCallers: [], topDependents: [] });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.usedBy).toBeNull();
  });

  it("fuses role context into why-it-matters for api-client", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("central API client");
    expect(rendered.whyItMatters).toContain("ix impact");
  });

  it("renders pipeline choke point wording for narrow-but-critical nodes", () => {
    const facts = makeFacts({
      name: "pickBest",
      callerCount: 1,
      dependentCount: 2,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("pipeline-choke-point");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("only 1 direct caller");
    expect(rendered.whyItMatters).toContain("25 downstream dependents");
    expect(rendered.whyItMatters).toContain("structurally important");
  });

  it("renders localized helper wording for low-impact nodes", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("localized-helper");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("localized");
  });

  it("cleans unresolved_call_target into human-readable note", () => {
    const facts = makeFacts({
      diagnostics: [
        { code: "unresolved_call_target", message: "3 callee(s) could not be resolved." },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.notes.length).toBe(1);
    expect(rendered.notes[0]).not.toContain("[unresolved_call_target]");
    expect(rendered.notes[0]).toContain("could not be resolved");
  });

  it("cleans stale_source into human-readable note", () => {
    const facts = makeFacts({
      diagnostics: [
        { code: "stale_source", message: "stale" },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.notes[0]).toContain("changed since last ingest");
    expect(rendered.notes[0]).not.toContain("[stale_source]");
  });
});

// ── Confidence-to-language tiers ─────────────────────────────────────────────

describe("confidence-to-language mapping", () => {
  it("high-confidence roles use 'serves as', never 'likely' or 'appears'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["ingest", "parse", "validate", "store", "notify"],
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).not.toContain("is likely");
    expect(rendered.explanation).not.toContain("appears to be");
  });

  it("medium-confidence roles use 'is likely'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "formatDate",
      callerCount: 5,
      calleeCount: 0,
      memberCount: 0,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("medium");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("is likely");
    expect(rendered.explanation).not.toContain("serves as");
  });

  it("low-confidence roles use 'appears to be'", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("low");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("appears to be");
    expect(rendered.explanation).not.toContain("serves as");
    expect(rendered.explanation).not.toContain("is likely");
  });

  it("high-confidence broad dependency uses 'will propagate' not 'likely to affect'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("will propagate");
    expect(rendered.whyItMatters).not.toContain("likely to affect");
  });

  it("medium-confidence broad dependency uses 'may propagate'", () => {
    // Force medium confidence via a class with client methods but no name/path signals
    const facts = makeFacts({
      kind: "class",
      name: "DataHub",
      path: "src/core.ts",
      memberCount: 4,
      members: ["get", "post", "fetch", "query"],
      callerCount: 10,
      calleeCount: 3,
      dependentCount: 12,
      downstreamDependents: 20,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("medium");
    const importance = inferImportance(facts);
    expect(importance.category).toBe("broad-shared-dependency");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("may propagate");
  });

  it("localized helper uses 'is localized' not 'appears localized'", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("localized-helper");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("is localized");
    expect(rendered.whyItMatters).not.toContain("appears localized");
  });
});

// ── File-based role inference ───────────────────────────────────────────────

describe("file-based role inference", () => {
  it("inferImportance function in importance.ts → scoring-helper", () => {
    const facts = makeFacts({
      kind: "function",
      name: "inferImportance",
      path: "src/cli/explain/importance.ts",
      callerCount: 2,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("resolve in api.ts file stays resolution-helper", () => {
    const facts = makeFacts({
      kind: "function",
      name: "resolvePrefix",
      path: "src/client/api.ts",
      callerCount: 3,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("resolution-helper");
  });
});

// ── Fixture-like regression tests ───────────────────────────────────────────

describe("fixture regression: IxClient", () => {
  const ixClientFacts = makeFacts({
    kind: "class",
    name: "IxClient",
    path: "ix-cli/src/client/api.ts",
    memberCount: 15,
    members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch",
              "decide", "provenance", "listPatches", "stats", "listByKind", "listDecisions", "resolvePrefix"],
    callerCount: 12,
    calleeCount: 0,
    dependentCount: 20,
    importerCount: 8,
    downstreamDependents: 35,
    downstreamDepth: 3,
    topCallers: ["registerImpactCommand", "registerOverviewCommand", "registerExplainCommand"],
  });

  it("infers api-client role, not data-model", () => {
    const role = inferRole(ixClientFacts);
    expect(role.role).toBe("api-client");
    expect(role.role).not.toBe("data-model");
    expect(role.confidence).toBe("high");
  });

  it("infers high importance as broad shared dependency", () => {
    const importance = inferImportance(ixClientFacts);
    expect(importance.level).toBe("high");
    expect(importance.category).toBe("broad-shared-dependency");
  });

  it("renders confident explanation with API client and named examples", () => {
    const role = inferRole(ixClientFacts);
    const importance = inferImportance(ixClientFacts);
    const rendered = renderExplanation(ixClientFacts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).toContain("API client");
    expect(rendered.whyItMatters).toContain("central API client");
    expect(rendered.usedBy).toContain("registerImpactCommand");
  });
});

describe("fixture regression: pickBest", () => {
  const pickBestFacts = makeFacts({
    kind: "function",
    name: "pickBest",
    path: "ix-cli/src/cli/resolve.ts",
    callerCount: 1,
    calleeCount: 3,
    dependentCount: 2,
    importerCount: 0,
    memberCount: 0,
    downstreamDependents: 25,
    downstreamDepth: 3,
    topCallers: ["resolveFileOrEntity"],
  });

  it("infers selection-helper role, not unknown", () => {
    const role = inferRole(pickBestFacts);
    expect(role.role).toBe("selection-helper");
    expect(role.role).not.toBe("unknown");
  });

  it("infers pipeline choke point importance", () => {
    const importance = inferImportance(pickBestFacts);
    expect(importance.level).toBe("high");
    expect(importance.category).toBe("pipeline-choke-point");
  });

  it("renders choke point wording, not 'moderate impact'", () => {
    const role = inferRole(pickBestFacts);
    const importance = inferImportance(pickBestFacts);
    const rendered = renderExplanation(pickBestFacts, role, importance);
    expect(rendered.whyItMatters).not.toContain("Moderate impact");
    expect(rendered.whyItMatters).toContain("downstream");
    expect(rendered.whyItMatters).toContain("critical decision point");
  });

  it("includes named usage example", () => {
    const role = inferRole(pickBestFacts);
    const importance = inferImportance(pickBestFacts);
    const rendered = renderExplanation(pickBestFacts, role, importance);
    expect(rendered.usedBy).toContain("resolveFileOrEntity");
  });
});

// ── Hierarchy semantics inference ─────────────────────────────────────────────

describe("inferHierarchySemantics", () => {
  it("infers client layer from Cli > Client path", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "api-client");
    expect(sem.layerName).toBe("CLI client layer");
    expect(sem.boundaryRole).toBe("boundary");
    expect(sem.systemRole).toContain("boundary");
  });

  it("infers resolution pipeline from Resolve path", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Resolve", kind: "subsystem" },
        { name: "resolve.ts", kind: "file" },
      ],
      subsystemName: "Resolve",
    });
    const sem = inferHierarchySemantics(facts, "resolution-helper");
    expect(sem.flowName).toBe("resolution pipeline");
  });

  it("infers impact pipeline from Impact path", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Impact", kind: "subsystem" },
        { name: "impact.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "orchestrator");
    expect(sem.flowName).toBe("impact pipeline");
  });

  it("infers explanation subsystem from Explain path", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Explain", kind: "subsystem" },
        { name: "render.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "shared-utility");
    expect(sem.flowName).toBe("explanation pipeline");
    expect(sem.layerName).toBe("explanation subsystem");
  });

  it("infers conflict-resolution flow from Conflict path", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
        { name: "conflict.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "service-method");
    expect(sem.flowName).toBe("conflict-resolution flow");
  });

  it("infers command layer from Commands path (not more specific)", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Commands", kind: "module" },
        { name: "locate.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "registration-function");
    expect(sem.layerName).toBe("command layer");
  });

  it("falls back to subsystem name when no specific match", () => {
    const facts = makeFacts({
      subsystemName: "Ingestion",
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Ingestion", kind: "subsystem" },
        { name: "parser.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "service");
    expect(sem.layerName).toBe("Ingestion subsystem");
  });

  it("returns empty reasons when no systemPath", () => {
    const facts = makeFacts({ systemPath: undefined });
    const sem = inferHierarchySemantics(facts, "unknown");
    expect(sem.reasons).toEqual([]);
    expect(sem.layerName).toBeUndefined();
  });
});

// ── System-aware role synthesis ──────────────────────────────────────────────

describe("synthesizeSystemRole", () => {
  it("produces boundary description for api-client in client layer", () => {
    const facts = makeFacts({ kind: "class", name: "IxClient" });
    const sem = inferHierarchySemantics(
      { ...facts, systemPath: [{ name: "Cli", kind: "system" }, { name: "Client", kind: "subsystem" }, { name: "api.ts", kind: "file" }] },
      "api-client",
    );
    const result = synthesizeSystemRole(facts, "api-client", sem);
    expect(result).toContain("boundary");
    expect(result).toContain("CLI client layer");
  });

  it("produces flow-aware description for selection-helper in resolution pipeline", () => {
    const sem: any = { flowName: "resolution pipeline", layerName: "resolution pipeline", reasons: [] };
    const facts = makeFacts({ name: "pickBest" });
    const result = synthesizeSystemRole(facts, "selection-helper", sem);
    expect(result).toContain("resolution pipeline");
  });

  it("returns null when no hierarchy context", () => {
    const sem: any = { reasons: [] };
    const facts = makeFacts({});
    const result = synthesizeSystemRole(facts, "api-client", sem);
    expect(result).toBeNull();
  });
});

// ── System-aware explanation output ─────────────────────────────────────────

describe("system-aware explanation sentence", () => {
  it("IxClient explanation mentions client layer, not just 'API client for the CLI'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
      subsystemName: "Cli / Client",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("client layer");
    expect(rendered.explanation).toContain("boundary");
  });

  it("pickBest explanation mentions resolution pipeline", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Resolution", kind: "subsystem" },
        { name: "resolve.ts", kind: "file" },
      ],
      subsystemName: "Resolution",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("resolution flow");
  });

  it("resolve in ConflictService mentions conflict-resolution flow", () => {
    const facts = makeFacts({
      kind: "method",
      name: "resolve",
      path: "src/cli/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callerCount: 3,
      calleeCount: 2,
      dependentCount: 5,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
        { name: "conflict.ts", kind: "file" },
        { name: "ConflictService", kind: "class" },
      ],
      subsystemName: "Conflict",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("conflict-resolution flow");
  });

  it("falls back to local description when no systemPath", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should use local-only description
    expect(rendered.explanation).toContain("API client");
    expect(rendered.explanation).not.toContain("client layer");
  });
});

// ── System-aware "Why it matters" ───────────────────────────────────────────

describe("system-aware why-it-matters", () => {
  it("IxClient: mentions backend-facing CLI operations, not generic 'codebase'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
      subsystemName: "Cli / Client",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should mention client layer and backend operations, not generic "codebase"
    expect(rendered.whyItMatters).toContain("client layer");
    expect(rendered.whyItMatters).toContain("backend");
    expect(rendered.whyItMatters).not.toContain("across the codebase");
  });

  it("pickBest: mentions resolution pipeline in choke-point wording", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      dependentCount: 2,
      downstreamDependents: 25,
      downstreamDepth: 3,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Resolution", kind: "subsystem" },
        { name: "resolve.ts", kind: "file" },
      ],
      subsystemName: "Resolution",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("pipeline-choke-point");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("resolution flow");
    expect(rendered.whyItMatters).toContain("decision point");
  });

  it("localized helper: mentions scope when hierarchy context available", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Explain", kind: "subsystem" },
        { name: "render.ts", kind: "file" },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("localized-helper");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("explanation");
    expect(rendered.whyItMatters).toContain("localized");
  });

  it("falls back to generic wording when no hierarchy data", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Without hierarchy data, generic phrasing is acceptable
    expect(rendered.whyItMatters).toContain("ix impact");
    expect(rendered.whyItMatters).toBeDefined();
  });

  it("medium-importance entity: mentions layer in review advice", () => {
    const facts = makeFacts({
      kind: "function",
      name: "formatDate",
      callerCount: 3,
      dependentCount: 3,
      importerCount: 1,
      downstreamDependents: 5,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Commands", kind: "module" },
        { name: "utils.ts", kind: "file" },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.level).toBe("medium");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("command layer");
  });
});

// ── Graceful fallback behavior ──────────────────────────────────────────────

describe("graceful fallback without map data", () => {
  it("no systemPath: explanation is still valid", () => {
    const facts = makeFacts({
      systemPath: undefined,
      subsystemName: undefined,
      moduleName: undefined,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).not.toContain("System path:");
    expect(rendered.explanation).toBeDefined();
    expect(rendered.whyItMatters).toBeDefined();
  });

  it("empty systemPath: no crash, local behavior", () => {
    const facts = makeFacts({ systemPath: [] });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toBeDefined();
  });

  it("systemPath with only file nodes: no hierarchy claims", () => {
    const facts = makeFacts({
      systemPath: [
        { name: "utils.ts", kind: "file" },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).not.toContain("subsystem");
    expect(rendered.explanation).not.toContain("pipeline");
  });
});

// ── Distinction from overview ───────────────────────────────────────────────

describe("explain vs overview distinction", () => {
  it("explain output includes role, importance category, and rendered sections that overview lacks", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["a", "b", "c", "d", "e"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);

    expect(role.role).toBeDefined();
    expect(role.confidence).toBeDefined();
    expect(importance.level).toBeDefined();
    expect(importance.category).toBeDefined();
    expect(rendered.explanation).toBeDefined();
    expect(rendered.whyItMatters).toBeDefined();
    expect(rendered.notes).toBeDefined();
  });
});

// ── System meaning inference ────────────────────────────────────────────────

describe("inferSystemMeaning", () => {
  it("detects foundation archetype for enum kinds", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "NodeKind",
      importerCount: 8,
      dependentCount: 12,
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning).not.toBeNull();
    expect(meaning!.archetype).toBe("foundation");
  });

  it("detects foundation archetype for interface kinds", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "GraphQueryApi",
      importerCount: 5,
      dependentCount: 8,
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning).not.toBeNull();
    expect(meaning!.archetype).toBe("foundation");
    expect(meaning!.identitySummary).toContain("contract");
  });

  it("detects boundary archetype for api-client role", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["get", "post", "entity"],
      callerCount: 12,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "api-client");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "api-client", sem, importance);
    expect(meaning).not.toBeNull();
    expect(meaning!.archetype).toBe("boundary");
  });

  it("detects flow archetype for selection-helper in pipeline", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Resolution", kind: "subsystem" },
        { name: "resolve.ts", kind: "file" },
      ],
    });
    const sem = inferHierarchySemantics(facts, "selection-helper");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "selection-helper", sem, importance);
    expect(meaning).not.toBeNull();
    expect(meaning!.archetype).toBe("flow");
  });

  it("returns null for general archetype without hierarchy", () => {
    const facts = makeFacts({
      kind: "function",
      name: "doStuff",
      callerCount: 1,
      calleeCount: 1,
    });
    const sem = inferHierarchySemantics(facts, "localized-helper");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "localized-helper", sem, importance);
    expect(meaning).toBeNull();
  });

  it("infers domain noun from entity name", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "NodeKind",
      importerCount: 8,
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning!.identitySummary).toContain("node");
  });

  it("generates responsibility for widely-imported foundation", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "ParseResult",
      importerCount: 6,
      dependentCount: 10,
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning!.responsibility).toContain("multiple services");
  });

  it("generates importance narrative for foundation with hierarchy", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "NodeKind",
      importerCount: 8,
      dependentCount: 12,
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Model", kind: "subsystem" },
        { name: "graph.ts", kind: "file" },
      ],
      subsystemName: "Model",
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning!.importanceNarrative).toContain("shared");
    expect(meaning!.importanceNarrative).toContain("ix impact");
  });

  it("generates usage summary for widely-imported foundation", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "GraphQueryApi",
      importerCount: 5,
      callerCount: 5,
      topCallers: ["ContextService", "SearchRoutes", "IngestionService"],
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "API", kind: "subsystem" },
        { name: "query.ts", kind: "file" },
      ],
      subsystemName: "API",
    });
    const sem = inferHierarchySemantics(facts, "type-definition");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "type-definition", sem, importance);
    expect(meaning!.usageSummary).toBeDefined();
    expect(meaning!.usageSummary).toContain("ContextService");
  });

  it("detects foundation for model files with members", () => {
    const facts = makeFacts({
      kind: "file",
      name: "Node.scala",
      path: "memory-layer/src/main/scala/model/Node.scala",
      memberCount: 5,
      importerCount: 6,
    });
    const sem = inferHierarchySemantics(facts, "container");
    const importance = inferImportance(facts);
    const meaning = inferSystemMeaning(facts, "container", sem, importance);
    expect(meaning).not.toBeNull();
    expect(meaning!.archetype).toBe("foundation");
    expect(meaning!.identitySummary).toContain("definition file");
  });
});

// ── System meaning integration with render ──────────────────────────────────

describe("system-meaning render integration", () => {
  it("foundation type: explanation uses domain-aware identity, not generic 'type definition'", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "NodeKind",
      importerCount: 8,
      dependentCount: 12,
      downstreamDependents: 20,
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Model", kind: "subsystem" },
        { name: "graph.ts", kind: "file" },
      ],
      subsystemName: "Model",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should mention "node" domain and "classification" or "foundational"
    expect(rendered.explanation).toContain("node");
    expect(rendered.explanation).toContain("foundational");
    // Should NOT just say "a type definition"
    expect(rendered.explanation).not.toBe(expect.stringContaining("a type definition."));
  });

  it("foundation type: whyItMatters explains systemic consequences", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "NodeKind",
      importerCount: 8,
      dependentCount: 12,
      downstreamDependents: 20,
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Model", kind: "subsystem" },
        { name: "graph.ts", kind: "file" },
      ],
      subsystemName: "Model",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("contract");
    expect(rendered.whyItMatters).toContain("ix impact");
  });

  it("foundation type: usedBy uses contextual summary when available", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "GraphQueryApi",
      importerCount: 5,
      callerCount: 5,
      dependentCount: 8,
      topCallers: ["ContextService", "SearchRoutes", "IngestionService"],
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "API", kind: "subsystem" },
        { name: "query.ts", kind: "file" },
      ],
      subsystemName: "API",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should use system-meaning usage summary, not plain "Used by X, Y, Z"
    expect(rendered.usedBy).toContain("ContextService");
  });

  it("foundation type without hierarchy: still gets domain-aware explanation", () => {
    const facts = makeFacts({
      kind: "enum",
      name: "EdgeKind",
      importerCount: 4,
      dependentCount: 6,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("edge");
    expect(rendered.explanation).toContain("foundational");
  });

  it("foundation model file: gets file-specific explanation", () => {
    const facts = makeFacts({
      kind: "file",
      name: "Node.scala",
      path: "memory-layer/src/main/scala/model/Node.scala",
      memberCount: 5,
      importerCount: 6,
      dependentCount: 10,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("definition file");
    expect(rendered.explanation).toContain("model");
  });

  it("non-foundation entity: explanation unchanged by system meaning", () => {
    // IxClient without hierarchy → should use existing local logic, not system meaning
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should use existing local description
    expect(rendered.explanation).toContain("API client");
    expect(rendered.explanation).not.toContain("foundational");
  });

  it("non-foundation entity with hierarchy: existing pipeline handles it", () => {
    // pickBest with resolution pipeline → flow archetype, but existing render handles it
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      dependentCount: 2,
      downstreamDependents: 25,
      downstreamDepth: 3,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Resolution", kind: "subsystem" },
        { name: "resolve.ts", kind: "file" },
      ],
      subsystemName: "Resolution",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Should use flow-semantics rendering for callable with high-confidence flow
    expect(rendered.explanation).toContain("resolution flow");
    expect(rendered.whyItMatters).toContain("decision point");
  });

  it("confidence language still applies to foundation types", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "UserProps",
      importerCount: 2,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).not.toContain("appears to be");
  });
});

// ── Flow semantics inference ────────────────────────────────────────────────

import { inferFlowSemantics } from "../explain/flow-semantics.js";

describe("inferFlowSemantics", () => {
  it("pickBest in resolve.ts → resolution flow, selection step, high confidence", () => {
    const facts = makeFacts({
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("resolution flow");
    expect(flow.roleInFlow).toBe("selection step");
    expect(flow.confidence).toBe("high");
  });

  it("resolveConflict in conflict.ts + ConflictService → conflict-resolution flow", () => {
    const facts = makeFacts({
      name: "resolveConflict",
      path: "src/cli/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("conflict-resolution flow");
    expect(flow.roleInFlow).toBe("conflict resolver");
    expect(flow.confidence).toBe("high");
  });

  it("parseInput in parser.ts → parsing pipeline, parsing step", () => {
    const facts = makeFacts({
      name: "parseInput",
      path: "src/parser.ts",
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("parsing pipeline");
    expect(flow.roleInFlow).toBe("parsing step");
    expect(flow.confidence).toBe("high");
  });

  it("scoreCandidate → scoring pipeline, scoring step", () => {
    const facts = makeFacts({
      name: "scoreCandidate",
      path: "src/scoring.ts",
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("scoring pipeline");
    expect(flow.roleInFlow).toBe("scoring step");
  });

  it("doStuff in utils.ts → low confidence, no flow", () => {
    const facts = makeFacts({
      name: "doStuff",
      path: "src/utils.ts",
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.confidence).toBe("low");
    expect(flow.flowName).toBeUndefined();
  });

  it("container-based: execute in IngestionService → ingestion pipeline", () => {
    const facts = makeFacts({
      name: "execute",
      container: { kind: "class", name: "IngestionService" },
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("ingestion pipeline");
  });

  it("priority: resolve in ConflictService + conflict.ts → conflict wins over resolution", () => {
    const facts = makeFacts({
      name: "resolve",
      path: "src/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.flowName).toBe("conflict-resolution flow");
  });

  it("upstream/downstream hints populated correctly", () => {
    const facts = makeFacts({
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
      topCallers: ["resolveFileOrEntity"],
      downstreamDependents: 25,
    });
    const flow = inferFlowSemantics(facts);
    expect(flow.upstreamHint).toBe("called from resolveFileOrEntity");
    expect(flow.downstreamHint).toContain("25 downstream");
  });
});

// ── Flow-aware rendering for callables ──────────────────────────────────────

describe("flow-aware rendering for callables", () => {
  it("pickBest: explanation says 'selection step in the resolution flow'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
      topCallers: ["resolveFileOrEntity"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("selection step");
    expect(rendered.explanation).toContain("resolution flow");
    expect(rendered.explanation).not.toContain("CLI client layer");
  });

  it("pickBest: context includes 'Called from:' and 'Feeds into:'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
      topCallers: ["resolveFileOrEntity"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).toContain("Called from:");
    expect(rendered.context).toContain("Feeds into:");
  });

  it("pickBest: whyItMatters references 'selection step' and 'resolution'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
      topCallers: ["resolveFileOrEntity"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("selection step");
    expect(rendered.whyItMatters).toContain("resolution flow");
  });

  it("resolveConflict in ConflictService: explanation says 'conflict'", () => {
    const facts = makeFacts({
      kind: "method",
      name: "resolveConflict",
      path: "src/cli/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callerCount: 3,
      calleeCount: 2,
      dependentCount: 5,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("conflict");
  });

  it("weak signal (doStuff): falls back, no 'Called from:' or 'Feeds into:'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "doStuff",
      path: "src/utils.ts",
      callerCount: 2,
      topCallers: ["main"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).not.toContain("Called from:");
    expect(rendered.context).not.toContain("Feeds into:");
  });

  it("non-callable (interface ResolveOptions): no flow rendering despite file name", () => {
    const facts = makeFacts({
      kind: "interface",
      name: "ResolveOptions",
      path: "src/cli/resolve.ts",
      importerCount: 4,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    // Interface is foundation type, not callable → no flow rendering
    expect(rendered.context).not.toContain("Called from:");
    expect(rendered.context).not.toContain("Feeds into:");
  });

  it("confidence language preserved for flow-rendered callables", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "ix-cli/src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
  });
});
