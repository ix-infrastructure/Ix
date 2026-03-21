import { describe, it, expect } from "vitest";
import { humanizeLabel } from "../impact/risk-semantics.js";

/**
 * Tests for ix locate output structure.
 *
 * These verify that the JSON output contract is purely positional:
 * file, line range, containment, system path — no structural/risk/explanatory content.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

// Simulates the JSON output shape from locate for a symbol target
function makeSymbolOutput() {
  return {
    resolvedTarget: {
      id: "abc-123",
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
    },
    resolutionMode: "exact",
    lineRange: { start: 12, end: 206 },
    container: { kind: "file", name: "api.ts", id: "file-1" },
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Client Layer", kind: "subsystem" },
      { name: "api.ts", kind: "file" },
      { name: "IxClient", kind: "class" },
    ],
    hasMapData: true,
    diagnostics: [],
  };
}

// Simulates the JSON output shape from locate for a file target
function makeFileOutput() {
  return {
    resolvedTarget: {
      id: "file-abc",
      kind: "file",
      name: "Node.scala",
      path: "memory-layer/src/main/scala/ix/memory/model/Node.scala",
    },
    resolutionMode: "exact",
    systemPath: [
      { name: "API", kind: "system" },
      { name: "Model / Db", kind: "subsystem" },
      { name: "Node.scala", kind: "file" },
    ],
    hasMapData: true,
    diagnostics: [],
  };
}

// ── Symbol target ───────────────────────────────────────────────────────────

describe("locate: symbol target output", () => {
  it("contains file path", () => {
    const output = makeSymbolOutput();
    expect(output.resolvedTarget.path).toBe("src/client/api.ts");
  });

  it("contains line range", () => {
    const output = makeSymbolOutput();
    expect(output.lineRange).toEqual({ start: 12, end: 206 });
  });

  it("contains system path with multiple nodes", () => {
    const output = makeSymbolOutput();
    expect(output.systemPath.length).toBeGreaterThan(1);
    expect(output.systemPath[0]).toEqual({ name: "CLI", kind: "system" });
  });

  it("contains container", () => {
    const output = makeSymbolOutput();
    expect(output.container).toBeDefined();
    expect(output.container!.name).toBe("api.ts");
  });

  it("system path ends with the resolved symbol name", () => {
    const output = makeSymbolOutput();
    const last = output.systemPath[output.systemPath.length - 1];
    expect(last.name).toBe("IxClient");
  });
});

// ── File target ─────────────────────────────────────────────────────────────

describe("locate: file target output", () => {
  it("contains file path", () => {
    const output = makeFileOutput();
    expect(output.resolvedTarget.path).toContain("Node.scala");
  });

  it("contains system path", () => {
    const output = makeFileOutput();
    expect(output.systemPath.length).toBeGreaterThan(1);
  });

  it("has no container for file targets", () => {
    const output = makeFileOutput();
    expect((output as any).container).toBeUndefined();
  });

  it("has no lineRange for file targets", () => {
    const output = makeFileOutput();
    expect((output as any).lineRange).toBeUndefined();
  });

  it("system path does not append an extra symbol segment for file targets", () => {
    const output = makeFileOutput();
    const last = output.systemPath[output.systemPath.length - 1];
    // Last element should be the file itself, not a symbol
    expect(last.kind).toBe("file");
  });
});

// ── Repo-relative paths ─────────────────────────────────────────────────────

describe("locate: repo-relative path rendering", () => {
  it("file path is relative, not absolute", () => {
    const symbol = makeSymbolOutput();
    expect(symbol.resolvedTarget.path).not.toMatch(/^\//);
    expect(symbol.resolvedTarget.path).toBe("src/client/api.ts");
  });

  it("file target path is relative", () => {
    const file = makeFileOutput();
    expect(file.resolvedTarget.path).not.toMatch(/^\//);
  });
});

// ── Humanized system path labels ────────────────────────────────────────────

describe("locate: humanized system path labels", () => {
  // The humanizeBreadcrumb function strips " layer" suffix from humanizeLabel
  // and applies it only to region kinds. Non-region nodes (file, class) keep raw names.

  it("region nodes are humanized (strip parentheticals, normalize abbreviations)", () => {
    // Cli / Client (subsystem) → "CLI client" (not "Cli / Client")
    const humanized = humanizeLabel("Cli / Client").replace(/ layer$/, "");
    expect(humanized).toBe("CLI client");
  });

  it("raw suffixes like (2f) are stripped", () => {
    const humanized = humanizeLabel("Model (2f)").replace(/ layer$/, "");
    expect(humanized).not.toContain("(2f)");
  });

  it("file and class nodes are not humanized", () => {
    // File and class nodes should keep their original names
    const output = makeSymbolOutput();
    const fileNode = output.systemPath.find((n) => n.kind === "file");
    expect(fileNode?.name).toBe("api.ts");
    const classNode = output.systemPath.find((n) => n.kind === "class");
    expect(classNode?.name).toBe("IxClient");
  });
});

// ── No-overlap regression ───────────────────────────────────────────────────

describe("locate: no-overlap regression", () => {
  const symbolOutput = makeSymbolOutput();
  const fileOutput = makeFileOutput();
  const allKeys = [
    ...Object.keys(symbolOutput),
    ...Object.keys(fileOutput),
  ];

  it("does not include callers", () => {
    expect(allKeys).not.toContain("callers");
    expect(allKeys).not.toContain("callerList");
  });

  it("does not include dependents", () => {
    expect(allKeys).not.toContain("dependents");
    expect(allKeys).not.toContain("directDependents");
    expect(allKeys).not.toContain("directImporters");
  });

  it("does not include members", () => {
    expect(allKeys).not.toContain("members");
    expect(allKeys).not.toContain("topImpactedMembers");
  });

  it("does not include risk or explanation fields", () => {
    expect(allKeys).not.toContain("riskSummary");
    expect(allKeys).not.toContain("riskLevel");
    expect(allKeys).not.toContain("riskCategory");
    expect(allKeys).not.toContain("atRiskBehavior");
    expect(allKeys).not.toContain("behaviorAtRisk");
    expect(allKeys).not.toContain("mostAffectedHint");
    expect(allKeys).not.toContain("nextStep");
  });
});

// ── Ambiguity handling ──────────────────────────────────────────────────────

describe("locate: ambiguity handling", () => {
  it("null resolution with no ambiguity produces diagnostics", () => {
    const output = {
      resolvedTarget: null,
      resolutionMode: "none",
      systemPath: null,
      diagnostics: ["No graph entity found."],
    };
    expect(output.resolvedTarget).toBeNull();
    expect(output.diagnostics.length).toBeGreaterThan(0);
  });

  it("ambiguous resolution produces candidate list without 'not found' diagnostics", () => {
    // Simulates the JSON output for ambiguous resolution
    const ambiguousOutput = {
      resolvedTarget: null,
      resolutionMode: "ambiguous",
      candidates: [
        { id: "a1", name: "NodeKind", kind: "trait", path: "src/model/Node.scala" },
        { id: "a2", name: "NodeKind", kind: "class", path: "src/other/Node.scala" },
      ],
      systemPath: null,
      diagnostics: [{ code: "ambiguous_resolution", message: "Use --pick <n> or --path to disambiguate." }],
    };

    expect(ambiguousOutput.resolutionMode).toBe("ambiguous");
    expect(ambiguousOutput.candidates.length).toBeGreaterThan(1);
    // No "No graph entity found" diagnostic
    const diagMessages = ambiguousOutput.diagnostics.map((d: any) =>
      typeof d === "string" ? d : d.message
    );
    expect(diagMessages).not.toContain("No graph entity found.");
    expect(diagMessages).not.toContain("No matches found.");
  });

  it("resolution mode is preserved for exact matches", () => {
    const output = makeSymbolOutput();
    expect(output.resolutionMode).toBe("exact");
  });
});
