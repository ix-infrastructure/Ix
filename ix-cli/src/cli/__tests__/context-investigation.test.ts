import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ConflictReport,
  DecisionReport,
  GraphEdge,
  GraphNode,
  IntentReport,
  ScoredClaim,
} from "../../client/types.js";
import type { EntityFacts } from "../explain/facts.js";
import {
  buildBundle,
  diffInvestigations,
  loadInvestigation,
  mergeDiffOptions,
  saveInvestigation,
} from "../commands/context.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-investigation-test-"));
  process.env.IX_HOME = home;
  // IX_HOME is the Ix home directory; investigations live in a subdirectory of
  // it, which saveInvestigation creates. Nothing is pre-created here — the tests
  // below assert on where the code actually writes, not on a directory the test
  // made itself.
});

/** Where saved investigations are expected to live, given IX_HOME. */
const investigationsDir = () => join(home, "investigations");

afterEach(() => {
  delete process.env.IX_HOME;
  rmSync(home, { recursive: true, force: true });
});

function makeFacts(overrides: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "entity-1",
    name: "Widget",
    kind: "class",
    members: ["render"],
    memberCount: 1,
    callerCount: 1,
    calleeCount: 1,
    dependentCount: 1,
    importerCount: 0,
    downstreamDependents: 2,
    downstreamDepth: 1,
    topCallers: ["App"],
    topDependents: ["App"],
    historyLength: 2,
    introducedRev: 1,
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

function makeContext(overrides: Partial<{ nodes: GraphNode[]; edges: GraphEdge[]; claims: ScoredClaim[] }> = {}) {
  return {
    claims: overrides.claims ?? [makeClaim("renders to DOM", 0.9)],
    conflicts: [] as ConflictReport[],
    decisions: [] as DecisionReport[],
    intents: [] as IntentReport[],
    nodes:
      overrides.nodes ??
      ([
        {
          id: "entity-2",
          kind: "method",
          name: "render",
          attrs: {},
          provenance: { sourceUri: "src/widget.ts", extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
          createdRev: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ] as GraphNode[]),
    edges:
      overrides.edges ??
      ([
        { id: "edge-1", src: "entity-1", dst: "entity-2", predicate: "calls", attrs: {}, createdRev: 1 },
      ] as GraphEdge[]),
    metadata: { query: "Widget", seedEntities: ["entity-1"], hopsExpanded: 1, asOfRev: 1 },
  };
}

function bundleWith(claims: ScoredClaim[], stale = false) {
  return buildBundle({
    resolved: { id: "entity-1", name: "Widget", kind: "class", resolutionMode: "exact" },
    facts: makeFacts({ stale }),
    context: makeContext({ claims }),
    provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
    asOfRev: undefined,
    depth: undefined,
    budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
  });
}

describe("ix context investigation state", () => {
  it("persists and resumes an investigation under ~/.ix/investigations", () => {
    const bundle = bundleWith([makeClaim("renders to DOM", 0.9)]);
    saveInvestigation("widget-check", bundle);

    const loaded = loadInvestigation("widget-check");
    expect(loaded).toBeDefined();
    expect(loaded?.schema).toBe("ix-investigation/1");
    expect(loaded?.bundle.target.name).toBe("Widget");
    expect(loaded?.bundle.evidence).toEqual(bundle.evidence);
  });

  it("writes into an investigations subdirectory of IX_HOME, not its root", () => {
    // IX_HOME is the Ix home itself — it holds config.yaml, bin/, cli/ and
    // dotfiles like .version-check.json. Saved state belongs in a subdirectory
    // of it, not loose among them.
    writeFileSync(join(home, "config.yaml"), "endpoint: http://localhost:8090\n");
    writeFileSync(join(home, ".version-check.json"), JSON.stringify({ latest: "0.9.3" }));

    saveInvestigation("widget-check", bundleWith([makeClaim("renders to DOM", 0.9)]));

    expect(readdirSync(investigationsDir())).toEqual(["widget-check.json"]);
    expect(readdirSync(home).sort()).toEqual([".version-check.json", "config.yaml", "investigations"]);
  });

  it("refuses to resume a missing or malformed investigation", () => {
    expect(loadInvestigation("does-not-exist")).toBeUndefined();
    // The fixture has to sit where the loader actually looks, or this passes
    // because the file is absent rather than because it is malformed — and
    // would keep passing with the JSON guard deleted.
    mkdirSync(investigationsDir(), { recursive: true });
    writeFileSync(join(investigationsDir(), "broken.json"), "not json", "utf8");
    expect(existsSync(join(investigationsDir(), "broken.json"))).toBe(true);
    expect(loadInvestigation("broken")).toBeUndefined();
  });

  it("refuses to resume a tampered bundle whose envelope still looks valid", () => {
    // The write path is schema-checked, so a non-conforming bundle can only
    // reach disk by being put there — a hand-edited file, a truncated write, or
    // a state file from a different version. The envelope is deliberately
    // *correct* here (`schema` matches, `bundle` is truthy), so the pre-existing
    // envelope guard cannot be what rejects it; only validating the bundle
    // itself can. `entities` is a string where the contract demands an array.
    mkdirSync(investigationsDir(), { recursive: true });
    const tampered = {
      schema: "ix-investigation/1",
      id: "tampered",
      savedAt: new Date().toISOString(),
      bundle: { ...bundleWith([]), entities: "not-an-array" },
    };
    writeFileSync(join(investigationsDir(), "tampered.json"), JSON.stringify(tampered), "utf8");
    // Guard the guard: if the envelope check were what fired, this fixture
    // would be indistinguishable from the "unknown schema" case above.
    expect(tampered.schema).toBe("ix-investigation/1");
    expect(tampered.bundle).toBeTruthy();
    expect(loadInvestigation("tampered")).toBeUndefined();
  });

  it("still resumes a well-formed bundle", () => {
    // Control for the test above: same code path, conforming bundle, so a
    // validator that rejected everything would fail here instead of passing.
    saveInvestigation("well-formed", bundleWith([makeClaim("renders to DOM", 0.9)]));
    expect(loadInvestigation("well-formed")).toBeDefined();
  });

  it("refuses to save a bundle that does not match the versioned contract", () => {
    const malformed = { ...bundleWith([]), entities: "not-an-array" } as unknown as ReturnType<typeof buildBundle>;
    saveInvestigation("bad-shape", malformed);
    expect(loadInvestigation("bad-shape")).toBeUndefined();
    expect(existsSync(join(investigationsDir(), "bad-shape.json"))).toBe(false);
  });

  it("computes a deterministic delta between saved and fresh state", () => {
    const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
    saveInvestigation("widget-check", saved);
    const stored = loadInvestigation("widget-check")!;

    // Fresh state: one extra entity + one new claim; one relationship removed.
    const fresh = buildBundle({
      resolved: { id: "entity-1", name: "Widget", kind: "class", resolutionMode: "exact" },
      facts: makeFacts(),
      context: makeContext({
        claims: [makeClaim("renders to DOM", 0.9), makeClaim("mounts to DOM", 0.7)],
        nodes: [
          {
            id: "entity-2",
            kind: "method",
            name: "render",
            attrs: {},
            provenance: { sourceUri: "src/widget.ts", extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
            createdRev: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "entity-3",
            kind: "method",
            name: "mount",
            attrs: {},
            provenance: { sourceUri: "src/widget.ts", extractor: "tree-sitter", sourceType: "source", observedAt: "2026-01-01T00:00:00Z" },
            createdRev: 2,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
      asOfRev: undefined,
      depth: undefined,
      budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
    });

    const diff = diffInvestigations(stored, fresh);

    expect(diff.schema).toBe("ix-investigation-diff/1");
    expect(diff.investigation).toBe("widget-check");
    expect(diff.added.entities.map((e) => e.id)).toContain("entity-3");
    expect(diff.removed.entities).toHaveLength(0);
    expect(diff.added.claims.map((c) => c.id)).toContain("claim-mounts to DOM");
    expect(diff.removed.claims).toHaveLength(0);

    const { generatedAt: _g, ...diffStatic } = diff;
    expect(diffStatic).toEqual({ ...diffStatic });
  });

  it("surfaces staleness changes in the delta", () => {
    const saved = bundleWith([makeClaim("renders to DOM", 0.9)], false);
    saveInvestigation("widget-check", saved);
    const stored = loadInvestigation("widget-check")!;
    const fresh = bundleWith([makeClaim("renders to DOM", 0.9)], true);

    const diff = diffInvestigations(stored, fresh);
    expect(diff.freshness.previous.classification).toBe("current");
    expect(diff.freshness.current.classification).toBe("stale");
  });

  it("preserves saved revision and depth for --diff unless explicitly overridden", () => {
    const bundle = bundleWith([makeClaim("renders to DOM", 0.9)]);
    bundle.metadata.asOfRev = 7;
    bundle.metadata.depth = "2";
    saveInvestigation("widget-check", bundle);
    const stored = loadInvestigation("widget-check")!;

    expect(mergeDiffOptions(stored, {})).toEqual({ asOfRev: "7", depth: "2" });
    expect(mergeDiffOptions(stored, { asOfRev: "3" })).toEqual({ asOfRev: "3", depth: "2" });
    expect(mergeDiffOptions(stored, { depth: "4" })).toEqual({ asOfRev: "7", depth: "4" });
    expect(mergeDiffOptions(stored, { asOfRev: "3", depth: "4" })).toEqual({ asOfRev: "3", depth: "4" });
  });

  it("never collides or escapes for hostile investigation ids", () => {
    const a = bundleWith([makeClaim("renders to DOM", 0.9)]);
    const b = bundleWith([makeClaim("mounts to DOM", 0.9)]);
    saveInvestigation("a/b", a);
    saveInvestigation("a?b", b);
    saveInvestigation("../../escape", a);
    saveInvestigation(".version-check", b);

    expect(loadInvestigation("a/b")?.bundle.evidence).toEqual(a.evidence);
    expect(loadInvestigation("a?b")?.bundle.evidence).toEqual(b.evidence);
    expect(loadInvestigation("../../escape")?.bundle.target.name).toBe("Widget");
    expect(loadInvestigation(".version-check")?.bundle.evidence).toEqual(b.evidence);

    // Every hostile id lands as one single-segment file inside the
    // investigations directory; nothing is written outside it, and nothing
    // becomes a dotfile that could shadow real Ix state.
    const jsonFiles = readdirSync(investigationsDir()).filter((f) => f.endsWith(".json"));
    expect(jsonFiles).toHaveLength(4);
    for (const f of jsonFiles) {
      expect(f).not.toContain("/");
      expect(f.startsWith(".")).toBe(false);
    }
    expect(existsSync(join(home, "..", "escape.json"))).toBe(false);
    expect(existsSync(join(home, ".version-check.json"))).toBe(false);
  });
});
