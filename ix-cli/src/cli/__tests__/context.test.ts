import { describe, expect, it } from "vitest";

import type {
  ConflictReport,
  DecisionReport,
  EdgeSummary,
  GraphEdge,
  GraphNode,
  IntentReport,
  NodeSummary,
  ScoredClaim,
} from "../../client/types.js";
import type { EntityFacts } from "../explain/facts.js";
import { buildBundle, sanitizeId } from "../commands/context.js";

function makeFacts(overrides: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "entity-1",
    name: "Widget",
    kind: "class",
    members: ["render", "mount"],
    memberCount: 2,
    callerCount: 3,
    calleeCount: 2,
    dependentCount: 4,
    importerCount: 1,
    downstreamDependents: 6,
    downstreamDepth: 2,
    topCallers: ["App", "Panel", "Shell"],
    topDependents: ["App", "Panel", "Shell", "Frame"],
    historyLength: 5,
    introducedRev: 3,
    stale: false,
    diagnostics: [],
    ...overrides,
  };
}

function makeClaim(statement: string, relevance: number): ScoredClaim {
  return {
    claim: { id: `claim-${statement}`, entityId: "entity-1", statement, status: "active" },
    relevance,
    finalScore: relevance,
    confidence: {
      baseAuthority: { value: 0.5, reason: "base" },
      verification: { value: 0.5, reason: "verify" },
      recency: { value: 0.5, reason: "recent" },
      corroboration: { value: 0.5, reason: "corroborate" },
      conflictPenalty: { value: 0.5, reason: "penalty" },
      intentAlignment: { value: 0.5, reason: "intent" },
      score: 0.5,
    },
  };
}

function makeContext(overrides: Partial<{
  claims: ScoredClaim[];
  conflicts: ConflictReport[];
  decisions: DecisionReport[];
  intents: IntentReport[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeSummaries: NodeSummary[];
  edgeSummaries: EdgeSummary[];
}> = {}) {
  return {
    claims: overrides.claims ?? [makeClaim("renders to DOM", 0.9)],
    conflicts: overrides.conflicts ?? [],
    decisions: overrides.decisions ?? [],
    intents: overrides.intents ?? [],
    nodes:
      overrides.nodes ??
      ([
        {
          id: "entity-2",
          kind: "method",
          name: "render",
          attrs: {},
          provenance: { sourceUri: "src/widget.ts", extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
          createdRev: 3,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ] as GraphNode[]),
    edges:
      overrides.edges ??
      ([
        { id: "edge-1", src: "entity-1", dst: "entity-2", predicate: "calls", attrs: {}, createdRev: 3 },
      ] as GraphEdge[]),
    nodeSummaries: overrides.nodeSummaries,
    edgeSummaries: overrides.edgeSummaries,
    metadata: { query: "Widget", seedEntities: ["entity-1"], hopsExpanded: 1, asOfRev: 3 },
  };
}

function input() {
  return {
    resolved: { id: "entity-1", name: "Widget", kind: "class", resolutionMode: "exact" },
    facts: makeFacts(),
    context: makeContext(),
    provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
    asOfRev: undefined,
    depth: undefined,
    budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
  };
}

describe("ix context bundle", () => {
  it("is deterministic for identical input apart from the declared timestamp", () => {
    const first = buildBundle(input());
    const second = buildBundle(input());

    // The only permitted time-dependent field.
    expect(first.generatedAt).toBeTypeOf("string");
    const { generatedAt: _g1, ...firstStatic } = first;
    const { generatedAt: _g2, ...secondStatic } = second;
    expect(firstStatic).toEqual(secondStatic);
  });

  it("orders evidence by the deterministic tier and a stable id tiebreaker", () => {
    const bundle = buildBundle(input());
    const scores = bundle.evidence.map((item) => item.score);

    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    // The resolved target is the most relevant item.
    expect(bundle.evidence[0]?.kind).toBe("target");
    // Direct structural facts rank above context claims.
    expect(bundle.evidence[1]?.kind).toBe("structural");
    const claimItem = bundle.evidence.find((item) => item.kind === "claim");
    expect(claimItem?.source).toBe("context.claims");
  });

  it("enforces budgets and reports explicit truncation", () => {
    const bundle = buildBundle({
      ...input(),
      budgets: { maxEntities: 1, maxRelationships: 0, maxEvidence: 2, maxChars: 12000 },
    });

    expect(bundle.entities).toHaveLength(1);
    expect(bundle.truncation.entitiesTruncated).toBeGreaterThan(0);
    expect(bundle.relationships).toHaveLength(0);
    expect(bundle.truncation.relationshipsTruncated).toBe(1);
    expect(bundle.evidence.length).toBeLessThanOrEqual(2);
    expect(bundle.truncation.evidenceTruncated).toBeGreaterThanOrEqual(0);
  });

  it("never keeps a relationship whose endpoint the entity budget cut", () => {
    // The two budgets used to be applied independently, so an edge could be kept
    // while one or both of its endpoints were cut. Measured on a real target at
    // --max-entities 10: 59 of 74 relationships referenced an entity no longer
    // in the bundle, 13 of them at both ends -- and relationshipsTruncated said
    // 0, because nothing had exceeded the RELATIONSHIP budget. The renderer
    // prints those as bare UUIDs, so it looked fine.
    const nodes = ["n1", "n2", "n3", "n4"].map((id) => ({
      id,
      kind: "method",
      name: id,
      attrs: {},
      provenance: { sourceUri: `src/${id}.ts`, extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
      createdRev: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })) as GraphNode[];
    const edges = [
      { id: "e1", src: "entity-1", dst: "n1", predicate: "calls", attrs: {}, createdRev: 3 },
      { id: "e2", src: "n3", dst: "n4", predicate: "calls", attrs: {}, createdRev: 3 },
    ] as GraphEdge[];

    const bundle = buildBundle({
      ...input(),
      context: makeContext({ nodes, edges }),
      // Room for the target plus a couple of entities, not all four.
      budgets: { maxEntities: 3, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
    });

    const kept = new Set(bundle.entities.map((e) => e.id));
    for (const rel of bundle.relationships) {
      expect(kept.has(rel.src)).toBe(true);
      expect(kept.has(rel.dst)).toBe(true);
    }
    // And the count has to be honest: a relationship dropped because its
    // endpoint lost the ENTITY budget is still a relationship the caller did
    // not get, so it belongs in relationshipsTruncated.
    expect(bundle.truncation.relationshipsTruncated).toBe(
      edges.length - bundle.relationships.length,
    );
  });

  it("keeps every relationship when nothing was truncated", () => {
    // The fix must not cost edges in the common case -- it only removes ones
    // that referenced an entity the bundle no longer contains.
    const bundle = buildBundle(input());
    expect(bundle.relationships).toHaveLength(1);
    expect(bundle.truncation.relationshipsTruncated).toBe(0);
    const kept = new Set(bundle.entities.map((e) => e.id));
    expect(kept.has("entity-1") && kept.has("entity-2")).toBe(true);
  });

  it("builds entities and relationships from compact graph summaries", () => {
    const bundle = buildBundle({
      ...input(),
      context: makeContext({
        nodes: [],
        edges: [],
        nodeSummaries: [
          { id: "entity-1", kind: "class", name: "Widget", rev: 3, sourceUri: "src/widget.ts" },
          { id: "entity-2", kind: "method", name: "render", rev: 3, sourceUri: "src/widget.ts" },
          { id: "entity-3", kind: "method", name: "mount", rev: 3, sourceUri: "src/widget.ts" },
        ],
        edgeSummaries: [
          { id: "edge-1", src: "entity-1", dst: "entity-2", predicate: "calls", rev: 3 },
          { id: "edge-2", src: "entity-1", dst: "entity-3", predicate: "calls", rev: 3 },
        ],
      }),
    });

    expect(bundle.entities).toEqual([
      { id: "entity-1", name: "Widget", kind: "class", stale: false },
      { id: "entity-3", name: "mount", kind: "method", path: "src/widget.ts", stale: false },
      { id: "entity-2", name: "render", kind: "method", path: "src/widget.ts", stale: false },
    ]);
    expect(bundle.relationships).toEqual([
      { src: "entity-1", dst: "entity-2", predicate: "calls" },
      { src: "entity-1", dst: "entity-3", predicate: "calls" },
    ]);
  });

  it("asks about each entity's own staleness instead of copying the target's", () => {
    // `freshness` is the target's, from the facts collector. Every other entity
    // has its own source file and its own answer — stamping the target's onto
    // all of them reported untouched dependencies as stale whenever the target
    // was, which is the field an agent reads to decide what to trust.
    const asked: string[] = [];
    const bundle = buildBundle({
      ...input(),
      facts: makeFacts({ stale: true, path: "src/widget.ts" }),
      isStale: (path) => {
        asked.push(path);
        return false; // the dependency is current even though the target is not
      },
    });

    const target = bundle.entities.find((e) => e.id === "entity-1");
    const dependency = bundle.entities.find((e) => e.id === "entity-2");
    expect(target?.stale).toBe(true);
    expect(dependency?.stale).toBe(false);
    expect(bundle.freshness).toEqual({ stale: true, classification: "stale" });
    // The target is not re-probed; its answer was already collected.
    expect(asked).toEqual(["src/widget.ts"]);
  });

  it("probes no more entities than the budget keeps", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: `n-${i}`,
      kind: "method",
      name: `m${i}`,
      attrs: {},
      provenance: { sourceUri: `src/f${i}.ts`, extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
      createdRev: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })) as GraphNode[];
    let probes = 0;

    buildBundle({
      ...input(),
      context: makeContext({ nodes }),
      budgets: { maxEntities: 5, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
      isStale: () => { probes += 1; return false; },
    });

    // 5 kept, minus the target whose answer is already known.
    expect(probes).toBe(4);
  });

  it("classifies staleness from the collected facts", () => {
    const stale = buildBundle({ ...input(), facts: makeFacts({ stale: true }) });
    expect(stale.freshness).toEqual({ stale: true, classification: "stale" });

    const current = buildBundle({ ...input(), facts: makeFacts({ stale: false }) });
    expect(current.freshness).toEqual({ stale: false, classification: "current" });
  });

  it("orders claims, decisions, conflicts, and intents deterministically", () => {
    const decisions: DecisionReport[] = [
      { title: "zeta", rationale: "late", entityId: "entity-1", rev: 1 },
      { title: "alpha", rationale: "second", entityId: "entity-1", rev: 1 },
      { title: "alpha", rationale: "first", entityId: "entity-1", rev: 2 },
    ];
    const conflicts: ConflictReport[] = [
      { id: "c-1", claimA: "zeta claim", claimB: "delta claim", reason: "r", recommendation: "rec" },
      { id: "c-2", claimA: "alpha claim", claimB: "beta claim", reason: "r", recommendation: "rec" },
    ];
    const intents: IntentReport[] = [
      { id: "i-2", statement: "zeta intent", status: "active", confidence: 0.5 },
      { id: "i-1", statement: "alpha intent", status: "active", confidence: 0.5 },
    ];
    const claims = [makeClaim("zeta statement", 0.5), makeClaim("alpha one", 0.9), makeClaim("alpha two", 0.7)];
    const shuffled = {
      claims: [...claims].reverse(),
      conflicts: [...conflicts].reverse(),
      decisions: [...decisions].reverse(),
      intents: [...intents].reverse(),
    };

    const first = buildBundle({ ...input(), context: makeContext(shuffled) });
    const second = buildBundle({ ...input(), context: makeContext({ ...shuffled }) });

    expect(first.claims.map((c) => c.statement)).toEqual(["alpha one", "alpha two", "zeta statement"]);
    expect(first.decisions.map((d) => d.title)).toEqual(["alpha", "alpha", "zeta"]);
    expect(first.conflicts.map((c) => c.claimA)).toEqual(["alpha claim", "zeta claim"]);
    expect(first.intents.map((i) => i.statement)).toEqual(["alpha intent", "zeta intent"]);
    // Same data in any input order produces the same bundle sections.
    expect(second.claims).toEqual(first.claims);
    expect(second.decisions).toEqual(first.decisions);
    expect(second.conflicts).toEqual(first.conflicts);
    expect(second.intents).toEqual(first.intents);
  });

  it("bounds evidence by the exact serialized representation, not an estimate", () => {
    const claims = Array.from({ length: 60 }, (_, i) => makeClaim(`statement number ${i} with some padding text`, 0.5));
    const budgets = { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 500 };

    const bundle = buildBundle({ ...input(), context: makeContext({ claims }), budgets });

    // maxChars bounds the sum of the serialized JSON sizes of the kept items.
    const keptSerialized = bundle.evidence.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    expect(keptSerialized).toBeLessThanOrEqual(500);
    expect(bundle.evidence.length).toBeLessThan(25); // the char budget bit before the count budget
    expect(bundle.truncation.evidenceTruncated).toBeGreaterThan(0);
    expect(bundle.truncation.charactersTruncated).toBeGreaterThan(0);
    // Identical inputs produce an identical budgeted list.
    expect(bundle.evidence).toEqual(
      buildBundle({ ...input(), context: makeContext({ claims }), budgets }).evidence,
    );
  });

  it("encodes investigation ids injectively so distinct ids never collide", () => {
    expect(sanitizeId("widget-check")).toBe("widget-check");
    expect(sanitizeId("a/b")).not.toBe(sanitizeId("a?b"));
    expect(sanitizeId("a/b")).not.toBe(sanitizeId("a:b"));
    expect(sanitizeId("a?b")).not.toBe(sanitizeId("a~2Fb"));
    expect(sanitizeId("~")).toBe("~7E");
    expect(sanitizeId("../../etc/passwd")).not.toContain("/");
    expect(sanitizeId("C:\\Windows")).not.toContain("\\");
    expect(sanitizeId("")).toBe("unnamed");
    // No id may produce a dotfile, and encoding the dot only in first position
    // keeps the mapping injective.
    expect(sanitizeId(".version-check")).toBe("~2Eversion-check");
    expect(sanitizeId(".version-check")).not.toBe(sanitizeId("~2Eversion-check"));
    expect(sanitizeId("a.b")).toBe("a.b");
    const names = ["a/b", "a?b", "a:b", "a~2Fb", "C:\\Windows", "../..", "~"].map(sanitizeId);
    expect(new Set(names).size).toBe(names.length);
  });
});
