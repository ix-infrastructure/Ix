// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { IxClient } from "../../client/api.js";
import { buildBundle, clampBudgets, diffInvestigations } from "../commands/context.js";
import { collectFacts, type ContextFacts, type EntityLocation } from "../explain/facts.js";
import { collectRelatedFiles } from "../explain/related-files.js";

/**
 * Evidence order for `ix context`: tiers that do not interleave, callers and
 * dependents ahead of the neighbour rows, one "used by" row with its total,
 * and no entity in two rows.
 */

function loc(id: string, name: string, path: string, lines?: [number, number], kind = "function"): EntityLocation {
  return { id, name, kind, path, ...(lines ? { lineStart: lines[0], lineEnd: lines[1] } : {}) };
}

function baseFacts(over: Partial<ContextFacts>): ContextFacts {
  return {
    id: "f-target", name: "config.ts", kind: "file", path: "src/cli/config.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 7, stale: false, diagnostics: [],
    ...over,
  };
}

function claims(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    claim: { id: `cl-${i}`, entityId: "f-target", statement: `claim number ${i} about config`, status: "active" },
    relevance: 1, confidence: { score: 0.5 },
  }));
}

function bundleFor(facts: ContextFacts, extra: { claims?: number; edges?: Array<{ src: string; dst: string; predicate: string }> } = {}) {
  return buildBundle({
    resolved: { id: facts.id, name: facts.name, kind: facts.kind, resolutionMode: "exact" },
    facts,
    context: {
      claims: claims(extra.claims ?? 0), conflicts: [], decisions: [], intents: [],
      nodes: [], edges: extra.edges ?? [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    budgets: clampBudgets({}, "llm"),
    format: "llm",
    isStale: () => false,
  });
}

/** A file target with more structural rows than the default budget holds. */
function bigFileFacts(): ContextFacts {
  const memberRefs = Array.from({ length: 10 }, (_, i) =>
    ({ ...loc(`m-${i}`, `member${i}`, "src/cli/config.ts", [i * 20 + 1, i * 20 + 15]), usedBy: 10 - i, usedFromFiles: 1 }));
  return baseFacts({
    memberRefs, members: memberRefs.map((m) => m.name), memberCount: 10,
    relatedRefs: [{ id: "r-1", name: "far.ts", kind: "file", path: "src/far.ts", score: 1, reason: "", via: ["x"] }] as never,
    importRefs: Array.from({ length: 8 }, (_, i) => loc(`i-${i}`, `dep${i}.ts`, `src/dep${i}.ts`, undefined, "file")),
    neighbourRefs: Array.from({ length: 6 }, (_, i) => loc(`n-${i}`, `helper${i}`, `src/dep${i}.ts`, [1, 9])),
    dependentCount: 214, topDependents: ["stats.ts", "rank.ts", "watch.ts"],
    topDependentRefs: [
      loc("d-1", "stats.ts", "src/cli/commands/stats.ts", undefined, "file"),
      loc("d-2", "rank.ts", "src/cli/commands/rank.ts", undefined, "file"),
      loc("d-3", "watch.ts", "src/cli/commands/watch.ts", undefined, "file"),
    ],
    callerCount: 2, topCallers: ["main"],
    topCallerRefs: [loc("c-1", "main", "src/cli/main.ts", [10, 40])],
    usedByCount: 214,
  });
}

describe("evidence tiers", () => {
  it("ranks callers and dependents of a file target inside the first 20 rows and within the default budget", () => {
    const bundle = bundleFor(bigFileFacts(), { claims: 6 });

    const usedBy = bundle.evidence.findIndex((e) => e.refs.includes("d-1"));
    expect(usedBy).toBeGreaterThanOrEqual(0);
    expect(usedBy).toBeLessThan(20);
    // Before the neighbour and import rows, after the leading members.
    const firstNeighbour = bundle.evidence.findIndex((e) => e.source === "facts.neighbours");
    const firstImport = bundle.evidence.findIndex((e) => e.source === "facts.imports");
    if (firstNeighbour >= 0) expect(usedBy).toBeLessThan(firstNeighbour);
    if (firstImport >= 0) expect(usedBy).toBeLessThan(firstImport);
    for (const id of ["c-1", "d-1", "d-2", "d-3"]) {
      expect(bundle.evidence.some((e) => e.refs.includes(id)), id).toBe(true);
    }
  });

  it("does not interleave tiers: every structural row ranks ahead of every claim", () => {
    const bundle = bundleFor(bigFileFacts(), { claims: 3 });
    const scores = bundle.evidence.map((e) => e.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    const kinds = bundle.evidence.map((e) => e.kind);
    const lastStructural = kinds.lastIndexOf("structural");
    const firstClaim = kinds.indexOf("claim");
    if (firstClaim >= 0) expect(lastStructural).toBeLessThan(firstClaim);
  });
});

describe("used-by row", () => {
  it("merges callers and dependents into one row titled with the total", () => {
    const facts = baseFacts({
      callerCount: 1, topCallers: ["main"], topCallerRefs: [loc("c-1", "main", "src/cli/main.ts", [10, 40])],
      dependentCount: 214, topDependents: ["main", "stats.ts"],
      topDependentRefs: [
        loc("c-1", "main", "src/cli/main.ts", [10, 40]),
        loc("d-1", "stats.ts", "src/cli/commands/stats.ts", undefined, "file"),
      ],
      usedByCount: 214,
    });
    const bundle = bundleFor(facts);
    const rows = bundle.evidence.filter((e) => e.refs.includes("c-1") || e.refs.includes("d-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toMatch(/^used by \(2 of 214\): /);
    expect(rows[0]!.refs).toEqual(["c-1", "d-1"]);
    expect((rows[0] as { count?: unknown }).count).toEqual({ shown: 2, total: 214 });
  });
});

describe("evidence de-duplication", () => {
  it("never puts one entity in two rows", () => {
    const facts = bigFileFacts();
    // The same file as an import and a dependent, a member restated by a
    // CONTAINS edge, and an import restated by an IMPORTS edge.
    facts.topDependentRefs = [...facts.topDependentRefs!, loc("i-0", "dep0.ts", "src/dep0.ts", undefined, "file")];
    const bundle = buildBundle({
      resolved: { id: facts.id, name: facts.name, kind: facts.kind, resolutionMode: "exact" },
      facts,
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [],
        edges: [
          { src: "f-target", dst: "m-0", predicate: "CONTAINS" },
          { src: "f-target", dst: "i-1", predicate: "IMPORTS" },
          { src: "x-1", dst: "f-target", predicate: "REFERENCES" },
        ],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: clampBudgets({ maxEvidence: 200, maxTokens: 200_000 }, "json"),
      isStale: () => false,
    });

    const seen = new Map<string, string>();
    for (const row of bundle.evidence) {
      if (row.kind === "claim" || row.kind === "decision" || row.kind === "intent") continue;
      if (row.kind === "target" || row.id.startsWith("provenance:")) continue;
      for (const ref of row.refs) {
        if (ref === "f-target") continue;
        expect(seen.get(ref), `${ref} in ${row.id} and ${seen.get(ref)}`).toBeUndefined();
        seen.set(ref, row.id);
      }
    }
    // The relationship that names something new survives.
    expect(bundle.evidence.some((e) => e.refs.includes("x-1"))).toBe(true);
  });
});

describe("evidence ids", () => {
  it("keys member rows by entity id, so same-name members do not collide", () => {
    const facts = baseFacts({
      memberRefs: [
        loc("m-a", "render", "src/cli/config.ts", [1, 10]),
        loc("m-b", "render", "src/cli/config.ts", [20, 30]),
      ],
      members: ["render", "render"], memberCount: 2,
    });
    const bundle = bundleFor(facts);
    const ids = bundle.evidence.filter((e) => e.source === "facts.members").map((e) => e.id);
    expect(ids).toEqual(["member:m-a", "member:m-b"]);
    expect(new Set(bundle.evidence.map((e) => e.id)).size).toBe(bundle.evidence.length);
  });
});

describe("member use counts", () => {
  it("shows N+ when the use probe hit its cap", () => {
    const facts = baseFacts({
      memberRefs: [
        { ...loc("m-a", "hub", "src/cli/config.ts", [1, 10]), usedBy: 50, usedFromFiles: 12, usedByCapped: true },
        { ...loc("m-b", "leaf", "src/cli/config.ts", [20, 30]), usedBy: 3, usedFromFiles: 1 },
      ],
      members: ["hub", "leaf"], memberCount: 2,
    });
    const bundle = bundleFor(facts);
    const reason = (id: string) => bundle.evidence.find((e) => e.id === `member:${id}`)!.reason;
    expect(reason("m-a")).toContain("used by 50+ across");
    expect(reason("m-b")).toContain("used by 3 across");
  });
});

// ---------------------------------------------------------------- collectFacts

const TARGET = "t-0";

interface Raw { id: string; name: string; kind: string; path: string }

/** A target with the given callers; `order` permutes what the backend returns. */
function callerClient(callers: Raw[], edges: Array<{ src: string; dst: string; predicate: string }>, memberUses = 0): IxClient {
  const node = (r: Raw) => ({ id: r.id, name: r.name, kind: r.kind, attrs: {}, provenance: { sourceUri: r.path } });
  return {
    async entity(id: string) {
      return { node: { id, name: "rank", kind: "function", attrs: {}, provenance: { sourceUri: "src/cli/rank.ts" } }, edges: [] };
    },
    async expand(id: string, opts?: { direction?: string; predicates?: string[]; limit?: number }) {
      if (id === TARGET && opts?.direction === "in" && opts.predicates?.includes("CALLS")) {
        return { nodes: callers.map(node), edges };
      }
      if (id === TARGET && opts?.predicates?.[0] === "CONTAINS") {
        return { nodes: [{ id: "m-hub", name: "hub", kind: "function", attrs: {}, provenance: { sourceUri: "src/cli/rank.ts" } }], edges: [] };
      }
      if (id === "m-hub") {
        const nodes = Array.from({ length: memberUses }, (_, i) =>
          ({ id: `u-${i}`, name: `u${i}`, kind: "function", provenance: { sourceUri: `src/u${i}.ts` } }));
        return { nodes, edges: [] };
      }
      return { nodes: [], edges: [] };
    },
    async provenance(id: string) { return { entityId: id, chain: [] }; },
  } as unknown as IxClient;
}

const CALLERS: Raw[] = [
  { id: "c-test", name: "itRanks", kind: "function", path: "src/cli/__tests__/rank.test.ts" },
  { id: "c-far1", name: "farOne", kind: "function", path: "src/other/far.ts" },
  { id: "c-far2", name: "farTwo", kind: "function", path: "src/other/far.ts" },
  { id: "c-near", name: "nearby", kind: "function", path: "src/cli/near.ts" },
  { id: "c-heavy", name: "heavy", kind: "function", path: "src/zz/heavy.ts" },
  { id: "c-light", name: "light", kind: "function", path: "src/aa/light.ts" },
];
const EDGES = [
  ...CALLERS.map((c) => ({ src: c.id, dst: TARGET, predicate: "CALLS" })),
  { src: "c-heavy", dst: TARGET, predicate: "CALLS" },
  { src: "c-heavy", dst: TARGET, predicate: "CALLS" },
];

function permutations<T>(xs: T[]): T[][] {
  // Rotations and reversals: enough to change every position.
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rot = [...xs.slice(i), ...xs.slice(0, i)];
    out.push(rot, [...rot].reverse());
  }
  return out;
}

describe("collectFacts caller ranking", () => {
  it("is independent of the backend's return order", async () => {
    const lists = await Promise.all(permutations(CALLERS).map(async (order) => {
      const facts = await collectFacts(callerClient(order, [...EDGES].reverse()), TARGET, "rank", "function", "context");
      return { callers: facts.topCallerRefs!.map((r) => r.id), dependents: facts.topDependentRefs!.map((r) => r.id) };
    }));
    for (const l of lists) expect(l).toEqual(lists[0]);
  });

  it("ranks non-test, distinct-file, same-directory, then most-linked callers first", async () => {
    const facts = await collectFacts(callerClient(CALLERS, EDGES), TARGET, "rank", "function", "context");
    // Same directory first, then the caller with the most edges to the target,
    // then path order; the second caller from far.ts and the test come last.
    expect(facts.topCallerRefs!.map((r) => r.id)).toEqual(["c-near", "c-heavy", "c-light"]);
    expect(facts.callerCount).toBe(6);
  });

  it("marks a member use count that hit the probe cap", async () => {
    const facts = await collectFacts(callerClient(CALLERS, EDGES, 50), TARGET, "rank", "function", "context");
    expect(facts.memberRefs?.[0]).toMatchObject({ usedBy: 50, usedByCapped: true });
    const under = await collectFacts(callerClient(CALLERS, EDGES, 7), TARGET, "rank", "function", "context");
    expect(under.memberRefs?.[0]?.usedByCapped).toBeUndefined();
  });
});

// ------------------------------------------------------------- walk fan-out

describe("walk seeds", () => {
  // The backend's first three dependents are all in one test directory; the
  // ranked list spreads over distinct non-test files. The walks must keep
  // starting from the backend's three, so ranking adds no fetches (CL-07 perf).
  const deps: Raw[] = [
    { id: "d-1", name: "a.test.ts", kind: "file", path: "src/__tests__/a.test.ts" },
    { id: "d-2", name: "b.test.ts", kind: "file", path: "src/__tests__/b.test.ts" },
    { id: "d-3", name: "c.test.ts", kind: "file", path: "src/__tests__/c.test.ts" },
    { id: "d-4", name: "x.ts", kind: "file", path: "src/x.ts" },
    { id: "d-5", name: "y.ts", kind: "file", path: "src/y.ts" },
    { id: "d-6", name: "z.ts", kind: "file", path: "src/z.ts" },
  ];

  function client(expanded: string[]): IxClient {
    const node = (r: Raw) => ({ id: r.id, name: r.name, kind: r.kind, attrs: {}, provenance: { sourceUri: r.path } });
    return {
      async entity(id: string) {
        return { node: { id, name: "rank", kind: "function", attrs: {}, provenance: { sourceUri: "src/rank.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[] }) {
        if (id === TARGET && opts?.direction === "in" && opts.predicates?.includes("REFERENCES")) {
          return { nodes: deps.map(node), edges: [] };
        }
        if (id !== TARGET) expanded.push(id);
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;
  }

  it("fans out from the backend's sample, not the ranked display list", async () => {
    const expanded: string[] = [];
    const facts = await collectFacts(client(expanded), TARGET, "rank", "function", "context");

    expect(facts.topDependentRefs!.map((r) => r.id)).toEqual(["d-4", "d-5", "d-6"]);
    expect(facts.walkSeeds?.dependents.map((r) => r.id)).toEqual(["d-1", "d-2", "d-3"]);
    expect([...new Set(expanded)].sort()).toEqual(["d-1", "d-2", "d-3"]);

    const walked: string[] = [];
    await collectRelatedFiles(client(walked), { id: TARGET, kind: "function" }, facts);
    for (const id of ["d-4", "d-5", "d-6"]) expect(walked).not.toContain(id);
    for (const id of ["d-1", "d-2", "d-3"]) expect(walked).toContain(id);
  });
});

describe("explain scope", () => {
  it("keeps the backend's caller order for ix explain, and no used-by total", async () => {
    const facts = await collectFacts(callerClient(CALLERS, EDGES), TARGET, "rank", "function");
    expect(facts.topCallerRefs!.map((r) => r.id)).toEqual(["c-test", "c-far1", "c-far2"]);
    expect(facts).not.toHaveProperty("usedByCount");
  });
});

describe("--diff across a callers change", () => {
  it("reports the used-by row as changed when its callers or total change", () => {
    const before = bundleFor(baseFacts({
      callerCount: 3, topCallers: ["main"], topCallerRefs: [loc("c-1", "main", "src/cli/main.ts", [10, 40])],
      usedByCount: 3,
    }));
    const after = bundleFor(baseFacts({
      callerCount: 40, topCallers: ["main", "run"],
      topCallerRefs: [loc("c-1", "main", "src/cli/main.ts", [10, 40]), loc("c-2", "run", "src/cli/run.ts", [1, 9])],
      usedByCount: 40,
    }));
    const diff = diffInvestigations({ id: "x", savedAt: "2026-01-01T00:00:00Z", bundle: before } as never, after);
    expect(diff.removed.evidence.map((e) => e.title)).toEqual(["used by (1 of 3): main (main.ts)"]);
    expect(diff.added.evidence.map((e) => e.title)).toEqual(["used by (2 of 40): main (main.ts), run (run.ts)"]);

    const same = diffInvestigations({ id: "x", savedAt: "2026-01-01T00:00:00Z", bundle: before } as never, before);
    expect(same.added.evidence).toEqual([]);
    expect(same.removed.evidence).toEqual([]);
  });

  it("keeps the used-by reason to locations, not a second copy of the names", () => {
    const b = bundleFor(bigFileFacts());
    const row = b.evidence.find((e) => e.id === "used-by")!;
    expect(row.reason).not.toContain("main ");
    expect(row.reason).toContain("src/cli/main.ts:10-40");
  });
});
