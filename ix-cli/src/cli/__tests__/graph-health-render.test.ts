// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { renderExplainLlm } from "../explain/llm.js";
import { buildBundle, renderFullBundle as renderBundle } from "../commands/context.js";
import { contextBundleSchema } from "../context-bundle-schema.js";
import { assessGraphStats, assessTargetStructure } from "../graph-health.js";
import type { ContextFacts, EntityFacts } from "../explain/facts.js";

/**
 * On a hollowed graph (every node, almost no edge), `ix explain` used to say
 * `callers=0 role=localized-helper importance=low` and `ix context` said
 * `stale=false classification=current` -- confident, and wrong: the healthy
 * graph of the same commit has a caller. These pin what they say instead.
 */

const DEGRADED = assessGraphStats({
  nodes: { total: 9243, byKind: [{ kind: "file", count: 333 }, { kind: "function", count: 8910 }] },
  edges: { total: 387, byPredicate: [{ predicate: "CONTAINS", count: 38 }, { predicate: "DEFINES", count: 38 }, { predicate: "CONTAINS_CHUNK", count: 39 }, { predicate: "CALLS", count: 222 }] },
});

function explainFacts(over: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "9dbdebd9-0000", name: "parseBudgetOption", kind: "function", path: "ix-cli/src/cli/options.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    downstreamDependents: 0, downstreamDepth: 1,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 1243, stale: false, diagnostics: [],
    ...over,
  };
}

const role = { role: "localized-helper" as const, confidence: "low" as const, reasons: [] };
const importance = { level: "low" as const, category: "localized-helper" as const, reasons: [] };
const rendered = { explanation: "", context: "", usedBy: "", usedByIsNameList: true, whyItMatters: "", notes: [] };

describe("ix explain on a degraded graph", () => {
  it("says so first and withholds what it would infer from missing edges", () => {
    const lines = renderExplainLlm(explainFacts(), role, importance, rendered, DEGRADED);

    expect(lines[0]).toMatch(/^graph status=degraded reason=hollow message=".*9243 nodes but 387 edges.*" fix="ix reset --workspace --yes --ingest"$/);
    expect(lines).toContain("role role=unknown confidence=none reason=graph_degraded");
    expect(lines).toContain("importance level=unknown reason=graph_degraded");
    expect(lines.join("\n")).not.toContain("localized-helper");
    // A zero from a graph without edges is not "no callers".
    expect(lines).toContain(
      "edges callers=unknown callees=unknown dependents=unknown importers=unknown members=unknown downstream=unknown depth=1 history=1 complete=false",
    );
  });

  it("keeps a non-zero count: an edge that survived is still a floor", () => {
    const line = renderExplainLlm(explainFacts({ callerCount: 2 }), role, importance, rendered, DEGRADED)
      .find((l) => l.startsWith("edges "));
    expect(line).toContain("callers=2 ");
  });

  it("is unchanged on a healthy graph, or when the check could not run", () => {
    for (const health of [undefined, { status: "ok" as const }, { status: "unknown" as const }]) {
      const lines = renderExplainLlm(explainFacts(), role, importance, rendered, health);
      expect(lines[0]).toMatch(/^entity /);
      expect(lines).toContain("role role=localized-helper confidence=low");
      expect(lines.find((l) => l.startsWith("edges "))).toBe(
        "edges callers=0 callees=0 dependents=0 importers=0 members=0 downstream=0 depth=1 history=1",
      );
    }
  });

  it("flags a target no file contains even when the workspace looks fine", () => {
    const orphan = assessTargetStructure({ name: "parseBudgetOption", kind: "function", path: "ix-cli/src/cli/options.ts" });
    const lines = renderExplainLlm(explainFacts(), role, importance, rendered, orphan);
    expect(lines[0]).toContain("reason=orphaned_target");
  });
});

function contextFacts(): ContextFacts {
  return {
    id: "t-1", name: "parseBudgetOption", kind: "function", path: "ix-cli/src/cli/options.ts",
    members: [], memberRefs: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 1243, stale: false, diagnostics: [],
  };
}

function bundle(graphHealth?: Parameters<typeof buildBundle>[0]["graphHealth"]) {
  return buildBundle({
    resolved: { id: "t-1", name: "parseBudgetOption", kind: "function", resolutionMode: "exact" },
    facts: contextFacts(),
    context: {
      claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxTokens: 1500, maxChars: 12000 },
    isStale: () => false,
    graphCompleted: true,
    graphHealth,
  });
}

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe("ix context on a degraded graph", () => {
  it("does not call the bundle current, and carries the verdict", () => {
    const b = bundle(DEGRADED);
    expect(b.freshness.classification).toBe("degraded");
    expect(b.graph).toMatchObject({ status: "degraded", reason: "hollow", fix: "ix reset --workspace --yes --ingest" });
    // It survives --save / --out: the schema declares it.
    expect(contextBundleSchema.parse(b).graph?.status).toBe("degraded");
  });

  it("drops stale=false from the llm header and puts the graph record right after it", () => {
    const lines = captureLog(() => renderBundle(bundle(DEGRADED), "llm"));
    expect(lines[0]).toContain("graph=degraded classification=degraded");
    expect(lines[0]).not.toContain("stale=");
    expect(lines[1]).toMatch(/^graph status=degraded reason=hollow /);
  });

  it("warns a person in text", () => {
    const text = captureLog(() => renderBundle(bundle(DEGRADED), "text")).join("\n");
    expect(text).toContain("Graph is degraded.");
    expect(text).toContain("Fix: ix reset --workspace --yes --ingest");
  });

  it("is unchanged on a healthy graph", () => {
    const b = bundle({ status: "ok" });
    expect(b.freshness.classification).toBe("current");
    expect(b.graph).toBeUndefined();
    const lines = captureLog(() => renderBundle(b, "llm"));
    expect(lines[0]).toContain("stale=false classification=current");
    expect(lines.some((l) => l.startsWith("graph "))).toBe(false);
  });
});
