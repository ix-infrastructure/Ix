import { describe, it, expect } from "vitest";
import { inferRiskSemantics, humanizeLabel, type ImpactFacts } from "../impact/risk-semantics.js";

/**
 * These tests verify the normalized JSON schema contract for ix impact.
 * Both container and leaf impact must have the same top-level keys.
 */

const REQUIRED_TOP_LEVEL_KEYS = [
  "resolvedTarget",
  "systemPath",
  "riskSummary",
  "riskLevel",
  "riskCategory",
  "atRiskBehavior",
  "summary",
];

const REQUIRED_SUMMARY_KEYS = [
  "members",
  "callers",
  "callees",
  "directImporters",
  "directDependents",
  "memberLevelCallers",
];

describe("impact JSON schema normalization", () => {
  it("container impact shape has all required keys", () => {
    // Simulates the container impact JSON output shape
    // Optimized output: resolutionMode/resultSource dropped, empty arrays omitted
    const containerOutput = {
      resolvedTarget: { kind: "class", name: "MyClass" },
      systemPath: [{ name: "CLI", kind: "subsystem" }, { name: "Commands", kind: "module" }],
      riskSummary: "Medium risk — widely shared dependency affecting the CLI layer.",
      riskLevel: "medium",
      riskCategory: "shared",
      atRiskBehavior: ["Multiple callers across different subsystems"],
      nextStep: "Check callers with ix callers MyClass",
      summary: {
        members: 5,
        callers: 0,
        callees: 0,
        directImporters: 2,
        directDependents: 1,
        memberLevelCallers: 10,
      },
      topImpactedMembers: [{ name: "foo", kind: "method", id: "m1", callerCount: 3 }],
      propagationBuckets: [{ region: "Commands", regionKind: "module", count: 2, members: [{ name: "fn1", kind: "function" }] }],
    };

    for (const key of REQUIRED_TOP_LEVEL_KEYS) {
      expect(containerOutput).toHaveProperty(key);
    }
    for (const key of REQUIRED_SUMMARY_KEYS) {
      expect(containerOutput.summary).toHaveProperty(key);
    }
    // Risk fields
    expect(typeof containerOutput.riskSummary).toBe("string");
    expect(typeof containerOutput.riskLevel).toBe("string");
    expect(typeof containerOutput.riskCategory).toBe("string");
    expect(Array.isArray(containerOutput.atRiskBehavior)).toBe(true);
    // Optional fields are omitted when empty (callerList, calleeList, decisions, tasks, bugs, diagnostics)
    expect(containerOutput).not.toHaveProperty("callerList");
    expect(containerOutput).not.toHaveProperty("decisions");
  });

  it("leaf impact shape has all required keys", () => {
    // Optimized output: resolutionMode/resultSource dropped, empty arrays omitted
    const leafOutput = {
      resolvedTarget: { kind: "function", name: "verify_token" },
      systemPath: [{ name: "file.ts", kind: "file" }],
      riskSummary: "Low risk — localized impact with limited propagation.",
      riskLevel: "low",
      riskCategory: "localized",
      atRiskBehavior: ["Limited to immediate callers"],
      summary: {
        members: 0,
        callers: 3,
        callees: 2,
        directImporters: 0,
        directDependents: 0,
        memberLevelCallers: 0,
      },
      callerList: [{ kind: "method", name: "login" }],
      calleeList: [{ kind: "function", name: "decode_jwt" }],
    };

    for (const key of REQUIRED_TOP_LEVEL_KEYS) {
      expect(leafOutput).toHaveProperty(key);
    }
    for (const key of REQUIRED_SUMMARY_KEYS) {
      expect(leafOutput.summary).toHaveProperty(key);
    }
    // Leaf: zero counts still present in summary
    expect(leafOutput.summary.members).toBe(0);
    expect(leafOutput.summary.directImporters).toBe(0);
    expect(leafOutput.summary.directDependents).toBe(0);
    expect(leafOutput.summary.memberLevelCallers).toBe(0);
    // Optional fields omitted when empty (topImpactedMembers, propagationBuckets, etc.)
    expect(leafOutput).not.toHaveProperty("topImpactedMembers");
    expect(leafOutput).not.toHaveProperty("diagnostics");
  });

  it("container and leaf have identical top-level keys", () => {
    const containerKeys = REQUIRED_TOP_LEVEL_KEYS.slice().sort();
    const leafKeys = REQUIRED_TOP_LEVEL_KEYS.slice().sort();
    expect(containerKeys).toEqual(leafKeys);
  });

  it("container and leaf have identical summary keys", () => {
    const containerSummaryKeys = REQUIRED_SUMMARY_KEYS.slice().sort();
    const leafSummaryKeys = REQUIRED_SUMMARY_KEYS.slice().sort();
    expect(containerSummaryKeys).toEqual(leafSummaryKeys);
  });
});

// ── Risk semantics inference ────────────────────────────────────────────────

function makeFacts(overrides: Partial<ImpactFacts> = {}): ImpactFacts {
  return {
    name: "SomeEntity",
    kind: "function",
    members: 0,
    callers: 2,
    callees: 1,
    directImporters: 0,
    directDependents: 0,
    memberLevelCallers: 0,
    propagationBuckets: [],
    ...overrides,
  };
}

describe("inferRiskSemantics: boundary class", () => {
  it("IxClient-like class: risk summary mentions backend-facing CLI operations / client boundary", () => {
    const facts = makeFacts({
      name: "IxClient",
      kind: "class",
      members: 15,
      callers: 0,
      directImporters: 8,
      directDependents: 20,
      memberLevelCallers: 66,
      systemPath: [
        { name: "Cli", kind: "system" },
        { name: "Cli / Client", kind: "subsystem" },
        { name: "api.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Cli / Client", regionKind: "subsystem", count: 34 },
        { region: "Commands", regionKind: "module", count: 18 },
        { region: "Explain", regionKind: "module", count: 6 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("boundary");
    expect(risk.riskLevel).toBe("critical");
    expect(risk.riskSummary.toLowerCase()).toContain("backend-facing");
    expect(risk.riskSummary.toLowerCase()).toContain("boundary");
  });

  it("IxClient-like class: at-risk behavior is operational, not just counts", () => {
    const facts = makeFacts({
      name: "IxClient",
      kind: "class",
      members: 15,
      directImporters: 8,
      directDependents: 20,
      memberLevelCallers: 66,
      propagationBuckets: [
        { region: "Cli / Client", regionKind: "subsystem", count: 34 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.behaviorAtRisk.length).toBeGreaterThan(0);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("command");
    expect(joined).not.toMatch(/^\d+$/); // Not just numbers
  });
});

describe("inferRiskSemantics: flow function", () => {
  it("pickBest-like function: risk summary mentions candidate selection / resolution flow", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("flow");
    expect(risk.riskSummary.toLowerCase()).toContain("candidate selection");
    expect(risk.riskSummary.toLowerCase()).toContain("resolution flow");
    // Should not lead with "callers: 1, callees: 4"
    expect(risk.riskSummary).not.toMatch(/callers?:\s*\d/);
  });

  it("pickBest-like function: at-risk behavior mentions selection/resolution", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
    });
    const risk = inferRiskSemantics(facts);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("selection");
  });
});

describe("inferRiskSemantics: conflict-resolution method", () => {
  it("resolve-like method: risk summary mentions conflict-resolution behavior", () => {
    const facts = makeFacts({
      name: "resolveConflict",
      kind: "method",
      path: "src/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callers: 3,
      callees: 2,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
        { name: "conflict.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Conflict", regionKind: "subsystem", count: 5 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("flow");
    expect(risk.riskSummary.toLowerCase()).toContain("conflict");
  });

  it("resolve-like method: propagation mentions conflict flow", () => {
    const facts = makeFacts({
      name: "resolveConflict",
      kind: "method",
      path: "src/conflict.ts",
      container: { kind: "class", name: "ConflictService" },
      callers: 3,
      callees: 2,
      systemPath: [
        { name: "CLI", kind: "system" },
        { name: "Conflict", kind: "subsystem" },
      ],
    });
    const risk = inferRiskSemantics(facts);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("conflict");
  });
});

describe("inferRiskSemantics: foundational shared type", () => {
  it("NodeKind-like enum: risk summary mentions shared node interpretation / model-parser consistency", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      callers: 0,
      directImporters: 8,
      directDependents: 12,
      memberLevelCallers: 0,
      systemPath: [
        { name: "IX Memory", kind: "system" },
        { name: "Model", kind: "subsystem" },
        { name: "graph.ts", kind: "file" },
      ],
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
        { region: "Context", regionKind: "module", count: 2 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("foundation");
    expect(risk.riskLevel).toBe("critical");
    expect(risk.riskSummary.toLowerCase()).toContain("node");
    expect(risk.riskSummary.toLowerCase()).toContain("risk");
  });

  it("NodeKind-like enum: at-risk behavior mentions classification and interpretation", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.behaviorAtRisk.length).toBeGreaterThan(0);
    const joined = risk.behaviorAtRisk.join(" ").toLowerCase();
    expect(joined).toContain("classification");
    expect(joined).toContain("interpretation");
  });

  it("NodeKind-like enum: propagation uses hierarchy buckets", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      directImporters: 8,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    // Risk summary should reference layers, not raw IDs
    expect(risk.riskSummary.toLowerCase()).not.toContain("id:");
    expect(risk.riskSummary).toContain("layer");
  });
});

describe("inferRiskSemantics: localized entity", () => {
  it("low-connectivity function gets low risk", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      kind: "function",
      callers: 1,
      callees: 0,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.riskLevel).toBe("low");
    expect(risk.category).toBe("localized");
  });
});

describe("inferRiskSemantics: shared dependency", () => {
  it("widely-called function gets shared category", () => {
    const facts = makeFacts({
      name: "formatOutput",
      kind: "function",
      callers: 8,
      callees: 2,
      propagationBuckets: [
        { region: "Commands", regionKind: "module", count: 5 },
        { region: "Explain", regionKind: "module", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.category).toBe("shared");
    expect(risk.riskLevel).not.toBe("low");
  });
});

// ── humanizeLabel ───────────────────────────────────────────────────────────

describe("humanizeLabel", () => {
  it("Cli / Client → CLI client layer", () => {
    expect(humanizeLabel("Cli / Client")).toBe("CLI client layer");
  });

  it("Api → API layer", () => {
    expect(humanizeLabel("Api")).toBe("API layer");
  });

  it("Model / Db → model and database layer", () => {
    expect(humanizeLabel("Model / Db")).toBe("model and database layer");
  });

  it("Ingestion / Parsers → ingestion and parser layer", () => {
    expect(humanizeLabel("Ingestion / Parsers")).toBe("ingestion and parser layer");
  });

  it("Context → context layer", () => {
    expect(humanizeLabel("Context")).toBe("context layer");
  });
});

// ── Flow-specific risk summary ──────────────────────────────────────────────

describe("inferRiskSemantics: flow-specific risk summary", () => {
  it("pickBest summary contains 'candidate selection' and 'resolution flow'", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.riskSummary.toLowerCase()).toContain("candidate selection");
    expect(risk.riskSummary.toLowerCase()).toContain("resolution flow");
  });
});

// ── Flow-aware most-affected ────────────────────────────────────────────────

describe("inferRiskSemantics: flow-aware most-affected", () => {
  it("pickBest with topCallerNames mentions the caller and selection", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
      topCallerNames: ["resolveEntityFull"],
      propagationBuckets: [
        { region: "Resolution", regionKind: "subsystem", count: 14 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.mostAffectedHint).toContain("resolveEntityFull");
    expect(risk.mostAffectedHint!.toLowerCase()).toContain("selection");
  });
});

// ── Foundation importer spread ──────────────────────────────────────────────

describe("inferRiskSemantics: foundation importer spread", () => {
  it("NodeKind-like with directImporters=8: summary or behavior mentions 'contract' or 'imported'", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
      propagationBuckets: [
        { region: "Ingestion / Parsers", regionKind: "subsystem", count: 8 },
        { region: "Model / Db", regionKind: "subsystem", count: 3 },
      ],
    });
    const risk = inferRiskSemantics(facts);
    const allText = [risk.riskSummary, ...risk.behaviorAtRisk].join(" ").toLowerCase();
    expect(allText).toContain("contract");
    expect(allText).toContain("imported");
  });
});

// ── Next-step guidance ──────────────────────────────────────────────────────

describe("inferRiskSemantics: next-step guidance", () => {
  it("foundation with high importers → nextStep contains 'ix explain'", () => {
    const facts = makeFacts({
      name: "NodeKind",
      kind: "enum",
      members: 24,
      directImporters: 8,
      directDependents: 12,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toContain("ix explain");
  });

  it("flow with callers → nextStep contains 'ix depends'", () => {
    const facts = makeFacts({
      name: "pickBest",
      kind: "function",
      path: "ix-cli/src/cli/resolve.ts",
      callers: 1,
      callees: 4,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toContain("ix depends");
  });

  it("localized → nextStep is undefined", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      kind: "function",
      callers: 1,
      callees: 0,
    });
    const risk = inferRiskSemantics(facts);
    expect(risk.nextStep).toBeUndefined();
  });
});
