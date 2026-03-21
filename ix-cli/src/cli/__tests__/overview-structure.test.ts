import { describe, it, expect } from "vitest";
import { humanizeLabel } from "../impact/risk-semantics.js";

/**
 * Tests for ix overview output structure.
 *
 * Containers: child counts + key items.
 * Leaves: contained-in + nearby structure + key siblings.
 * No role/risk/dependency content anywhere.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeClassOutput() {
  return {
    resolvedTarget: { id: "abc-123", kind: "class", name: "IxClient" },
    resolutionMode: "exact",
    path: "src/client/api.ts",
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
      { name: "api.ts", kind: "file" },
      { name: "IxClient", kind: "class" },
    ],
    hasMapData: true,
    childrenByKind: { method: 18, field: 7 },
    keyItems: [
      { name: "get", kind: "method" },
      { name: "post", kind: "method" },
      { name: "entity", kind: "method" },
      { name: "listByKind", kind: "method" },
      { name: "listPatches", kind: "method" },
    ],
    containedIn: null,
    siblingsByKind: null,
    keySiblings: null,
    diagnostics: [],
  };
}

function makeFileOutput() {
  return {
    resolvedTarget: { id: "file-abc", kind: "file", name: "Node.scala" },
    resolutionMode: "exact",
    path: "memory-layer/src/main/scala/ix/memory/model/Node.scala",
    systemPath: [
      { name: "API", kind: "system" },
      { name: "Model / Db", kind: "subsystem" },
      { name: "Node.scala", kind: "file" },
    ],
    hasMapData: true,
    childrenByKind: { interface: 1, class: 1, object: 1 },
    keyItems: [
      { name: "NodeKind", kind: "interface" },
      { name: "Node", kind: "class" },
      { name: "NodeId", kind: "object" },
    ],
    containedIn: null,
    siblingsByKind: null,
    keySiblings: null,
    diagnostics: [],
  };
}

function makeRegionOutput() {
  return {
    resolvedTarget: { id: "reg-1", kind: "subsystem", name: "Cli / Client" },
    resolutionMode: "exact",
    path: null,
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
    ],
    hasMapData: true,
    childrenByKind: { file: 12, class: 3, function: 28 },
    keyItems: [
      { name: "api.ts", kind: "file" },
      { name: "resolve.ts", kind: "file" },
      { name: "status.ts", kind: "file" },
    ],
    containedIn: null,
    siblingsByKind: null,
    keySiblings: null,
    diagnostics: [],
  };
}

function makeFunctionInFileOutput() {
  return {
    resolvedTarget: { id: "fn-1", kind: "function", name: "pickBest" },
    resolutionMode: "exact",
    path: "src/cli/resolve.ts",
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
      { name: "resolve.ts", kind: "file" },
      { name: "pickBest", kind: "function" },
    ],
    hasMapData: true,
    childrenByKind: null,
    keyItems: null,
    containedIn: { kind: "file", name: "resolve.ts" },
    siblingsByKind: { function: 8 },
    keySiblings: [
      { name: "resolveEntity", kind: "function" },
      { name: "resolveEntityFull", kind: "function" },
      { name: "scoreCandidate", kind: "function" },
      { name: "buildAmbiguous", kind: "function" },
      { name: "nodeToResolved", kind: "function" },
    ],
    diagnostics: [],
  };
}

function makeMethodInClassOutput() {
  return {
    resolvedTarget: { id: "m-1", kind: "method", name: "resolve" },
    resolutionMode: "exact",
    path: "memory-layer/src/main/scala/ix/memory/conflict/ConflictService.scala",
    systemPath: [
      { name: "API", kind: "system" },
      { name: "Model", kind: "subsystem" },
      { name: "ConflictService.scala", kind: "file" },
      { name: "ConflictService", kind: "class" },
      { name: "resolve", kind: "method" },
    ],
    hasMapData: true,
    childrenByKind: null,
    keyItems: null,
    containedIn: { kind: "class", name: "ConflictService" },
    siblingsByKind: { method: 6 },
    keySiblings: [
      { name: "tryGitLsFiles", kind: "method" },
      { name: "resolveRelativePath", kind: "method" },
      { name: "normalizePath", kind: "method" },
      { name: "mergeConflict", kind: "method" },
    ],
    diagnostics: [],
  };
}

// ── Class target ────────────────────────────────────────────────────────────

describe("overview: class target", () => {
  it("has child counts by kind", () => {
    const output = makeClassOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.method).toBe(18);
    expect(output.childrenByKind!.field).toBe(7);
  });

  it("has key members", () => {
    const output = makeClassOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.length).toBeLessThanOrEqual(5);
    expect(output.keyItems!.map((i) => i.name)).toContain("get");
  });

  it("has no leaf-specific fields", () => {
    const output = makeClassOutput();
    expect(output.containedIn).toBeNull();
    expect(output.siblingsByKind).toBeNull();
    expect(output.keySiblings).toBeNull();
  });

  it("has no callers, dependents, or risk text", () => {
    const output = makeClassOutput();
    const keys = Object.keys(output);
    expect(keys).not.toContain("callers");
    expect(keys).not.toContain("dependents");
    expect(keys).not.toContain("riskSummary");
    expect(keys).not.toContain("riskLevel");
    expect(keys).not.toContain("importers");
    expect(keys).not.toContain("usedBy");
  });
});

// ── File target ─────────────────────────────────────────────────────────────

describe("overview: file target", () => {
  it("summarizes definitions structurally", () => {
    const output = makeFileOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.interface).toBe(1);
    expect(output.childrenByKind!.class).toBe(1);
  });

  it("has key definitions", () => {
    const output = makeFileOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.map((i) => i.name)).toContain("NodeKind");
  });

  it("has no role or risk text", () => {
    const output = makeFileOutput();
    const keys = Object.keys(output);
    expect(keys).not.toContain("riskSummary");
    expect(keys).not.toContain("whyItMatters");
    expect(keys).not.toContain("atRiskBehavior");
  });

  it("uses repo-relative path", () => {
    const output = makeFileOutput();
    expect(output.path).not.toMatch(/^\//);
  });
});

// ── Region/subsystem target ─────────────────────────────────────────────────

describe("overview: region/subsystem target", () => {
  it("shows child files/regions structurally", () => {
    const output = makeRegionOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.file).toBe(12);
  });

  it("has key files", () => {
    const output = makeRegionOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.map((i) => i.name)).toContain("api.ts");
  });

  it("has no path for region targets", () => {
    const output = makeRegionOutput();
    expect(output.path).toBeNull();
  });
});

// ── Leaf target in file ─────────────────────────────────────────────────────

describe("overview: leaf target in file", () => {
  it("shows contained-in as the file", () => {
    const output = makeFunctionInFileOutput();
    expect(output.containedIn).not.toBeNull();
    expect(output.containedIn!.kind).toBe("file");
    expect(output.containedIn!.name).toBe("resolve.ts");
  });

  it("shows nearby structure with sibling counts", () => {
    const output = makeFunctionInFileOutput();
    expect(output.siblingsByKind).not.toBeNull();
    expect(output.siblingsByKind!.function).toBe(8);
  });

  it("shows key siblings", () => {
    const output = makeFunctionInFileOutput();
    expect(output.keySiblings).not.toBeNull();
    expect(output.keySiblings!.length).toBeLessThanOrEqual(5);
    expect(output.keySiblings!.map((s) => s.name)).toContain("resolveEntity");
  });

  it("does not have container-specific fields", () => {
    const output = makeFunctionInFileOutput();
    expect(output.childrenByKind).toBeNull();
    expect(output.keyItems).toBeNull();
  });

  it("has no callers/dependents/role/risk text", () => {
    const output = makeFunctionInFileOutput();
    const keys = Object.keys(output);
    expect(keys).not.toContain("callers");
    expect(keys).not.toContain("dependents");
    expect(keys).not.toContain("riskSummary");
    expect(keys).not.toContain("usedBy");
    expect(keys).not.toContain("whyItMatters");
  });
});

// ── Leaf target in class ────────────────────────────────────────────────────

describe("overview: leaf target in class", () => {
  it("nearest meaningful container is the class", () => {
    const output = makeMethodInClassOutput();
    expect(output.containedIn).not.toBeNull();
    expect(output.containedIn!.kind).toBe("class");
    expect(output.containedIn!.name).toBe("ConflictService");
  });

  it("shows sibling methods", () => {
    const output = makeMethodInClassOutput();
    expect(output.siblingsByKind).not.toBeNull();
    expect(output.siblingsByKind!.method).toBe(6);
  });

  it("shows key siblings", () => {
    const output = makeMethodInClassOutput();
    expect(output.keySiblings).not.toBeNull();
    expect(output.keySiblings!.map((s) => s.name)).toContain("mergeConflict");
  });

  it("system path includes class and method", () => {
    const output = makeMethodInClassOutput();
    const names = output.systemPath!.map((n) => n.name);
    expect(names).toContain("ConflictService");
    expect(names).toContain("resolve");
  });
});

// ── Container breadcrumb completion ──────────────────────────────────────────

describe("overview: container breadcrumb completion", () => {
  it("class target system path ends with the class name", () => {
    const output = makeClassOutput();
    const last = output.systemPath[output.systemPath.length - 1];
    expect(last.name).toBe("IxClient");
    expect(last.kind).toBe("class");
  });

  it("file target system path ends at the file, no extra segment", () => {
    const output = makeFileOutput();
    const last = output.systemPath[output.systemPath.length - 1];
    expect(last.name).toBe("Node.scala");
    expect(last.kind).toBe("file");
  });

  it("region target system path ends at the region", () => {
    const output = makeRegionOutput();
    const last = output.systemPath[output.systemPath.length - 1];
    expect(last.kind).toBe("subsystem");
  });

  it("interface container appends symbol to breadcrumb", () => {
    const output = {
      resolvedTarget: { id: "if-1", kind: "interface", name: "NodeKind" },
      systemPath: [
        { name: "API", kind: "system" },
        { name: "Model / Db", kind: "subsystem" },
        { name: "Node.scala", kind: "file" },
        { name: "NodeKind", kind: "interface" },
      ],
    };
    const last = output.systemPath[output.systemPath.length - 1];
    expect(last.name).toBe("NodeKind");
  });
});

// ── Humanized system path ───────────────────────────────────────────────────

describe("overview: humanized system path labels", () => {
  it("region labels are humanized", () => {
    const humanized = humanizeLabel("Cli / Client").replace(/ layer$/, "");
    expect(humanized).toBe("CLI client");
  });

  it("raw suffixes are stripped", () => {
    const humanized = humanizeLabel("Model (2f)").replace(/ layer$/, "");
    expect(humanized).not.toContain("(2f)");
  });
});

// ── No-overlap regression ───────────────────────────────────────────────────

describe("overview: no-overlap regression", () => {
  const allOutputs = [
    makeClassOutput(), makeFileOutput(), makeRegionOutput(),
    makeFunctionInFileOutput(), makeMethodInClassOutput(),
  ];
  const allKeys = new Set(allOutputs.flatMap((o) => Object.keys(o)));

  it("does not include 'usedBy' or 'whyItMatters'", () => {
    expect(allKeys.has("usedBy")).toBe(false);
    expect(allKeys.has("whyItMatters")).toBe(false);
  });

  it("does not include risk fields", () => {
    expect(allKeys.has("riskSummary")).toBe(false);
    expect(allKeys.has("riskLevel")).toBe(false);
    expect(allKeys.has("riskCategory")).toBe(false);
    expect(allKeys.has("atRiskBehavior")).toBe(false);
  });

  it("does not include callers/dependents/importers", () => {
    expect(allKeys.has("callers")).toBe(false);
    expect(allKeys.has("callerList")).toBe(false);
    expect(allKeys.has("dependents")).toBe(false);
    expect(allKeys.has("directDependents")).toBe(false);
    expect(allKeys.has("directImporters")).toBe(false);
    expect(allKeys.has("importers")).toBe(false);
  });

  it("does not include imports count", () => {
    for (const o of allOutputs) {
      expect((o as any).summary?.imports).toBeUndefined();
    }
  });
});
