// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "../../client/types.js";
import { buildBundle, renderBundle } from "../commands/context.js";
import { contextBundleSchema } from "../context-bundle-schema.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";

const FILE = "file-1";

function member(id: string, name: string, lines: [number, number], use?: [number, number]): EntityLocation {
  return {
    id, name, kind: "function", path: "src/cli/config.ts", lineStart: lines[0], lineEnd: lines[1],
    ...(use ? { usedBy: use[0], usedFromFiles: use[1] } : {}),
  };
}

function facts(overrides: Partial<ContextFacts> = {}): ContextFacts {
  const memberRefs = overrides.memberRefs ?? [
    member("m-resolve", "resolveWorkspaceRoot", [322, 342], [13, 5]),
    member("m-real", "real", [40, 41], [2, 0]),
  ];
  return {
    id: FILE, name: "config.ts", kind: "file", path: "src/cli/config.ts",
    members: memberRefs.map((m) => m.name), memberRefs, memberCount: memberRefs.length,
    callerCount: 0, calleeCount: 0, dependentCount: 1, importerCount: 1,
    topCallers: [], topCallerRefs: [],
    topDependents: ["stats.ts"],
    topDependentRefs: [{ id: "d-stats", name: "stats.ts", kind: "file", path: "src/cli/commands/stats.ts" }],
    historyLength: 1, introducedRev: 7, stale: false, diagnostics: [],
    ...overrides,
  };
}

function node(id: string, name: string, kind = "function", sourceUri?: string): GraphNode {
  return {
    id, name, kind, attrs: {},
    provenance: sourceUri ? { sourceUri } : undefined,
    createdRev: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as GraphNode;
}

function bundle(opts: {
  facts?: ContextFacts;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  provenance?: unknown;
  maxEntities?: number;
} = {}) {
  return buildBundle({
    resolved: { id: FILE, name: "config.ts", kind: "file", resolutionMode: "exact" },
    facts: opts.facts ?? facts(),
    context: {
      claims: [], conflicts: [], decisions: [], intents: [],
      nodes: opts.nodes ?? [], edges: opts.edges ?? [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: opts.provenance ?? {},
    budgets: { maxEntities: opts.maxEntities ?? 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
    isStale: () => false,
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

describe("ix context evidence says where things are", () => {
  it("locates the target, its members and its dependents", () => {
    const b = bundle();

    expect(b.target.path).toBe("src/cli/config.ts");
    const byTitle = new Map(b.evidence.map((e) => [e.title, e]));
    expect(byTitle.get("config.ts (file)")?.location).toEqual({ path: "src/cli/config.ts" });
    expect(byTitle.get("member resolveWorkspaceRoot")?.location).toEqual({
      path: "src/cli/config.ts", lineStart: 322, lineEnd: 342,
    });
    expect(byTitle.get("member resolveWorkspaceRoot")?.refs).toEqual(["m-resolve"]);
    expect(byTitle.get("dependent stats.ts")?.location).toEqual({ path: "src/cli/commands/stats.ts" });
  });

  it("keeps the members in the order the facts ranked them, and says why", () => {
    const b = bundle();
    const members = b.evidence.filter((e) => e.id.startsWith("member:"));

    expect(members.map((e) => e.title)).toEqual(["member resolveWorkspaceRoot", "member real"]);
    expect(members[0]?.reason).toBe("defined in the target; used by 13 across 5 other files");
    expect(members[1]?.reason).toBe("defined in the target; used by 2 within this file");
  });

  it("still gives name-only evidence when the facts carry no locations", () => {
    const b = bundle({
      facts: facts({ memberRefs: undefined, topDependentRefs: undefined, members: ["render"] }),
    });
    const render = b.evidence.find((e) => e.title === "member render");

    expect(render).toBeDefined();
    expect(render?.location).toBeUndefined();
    expect(render?.reason).toBe("defined in the target");
  });

  it("puts located entities ahead of the backend's alphabetical nodes, so the budget keeps them", () => {
    const nodes = ["aaa", "bbb", "ccc"].map((n) => node(`n-${n}`, n));
    const b = bundle({ nodes, maxEntities: 3 });

    expect(b.entities.map((e) => e.name)).toEqual(["config.ts", "resolveWorkspaceRoot", "real"]);
    expect(b.entities[1]).toMatchObject({ path: "src/cli/config.ts", lineStart: 322, lineEnd: 342 });
    expect(b.truncation.entitiesTruncated).toBe(4);
  });

  it("takes a compact summary's repository path, and still its sourceUri from older backends", () => {
    const b = buildBundle({
      resolved: { id: FILE, name: "config.ts", kind: "file", resolutionMode: "exact" },
      facts: facts({ memberRefs: [], members: [], topDependentRefs: [], topDependents: [] }),
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        nodeSummaries: [
          { id: "s-new", kind: "function", name: "fromNew", rev: 1, sourceUri: null, path: "src/new.ts" },
          { id: "s-old", kind: "function", name: "fromOld", rev: 1, sourceUri: "src/old.ts" },
        ],
        edgeSummaries: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
      isStale: () => false,
    });

    const paths = Object.fromEntries(b.entities.map((e) => [e.name, e.path]));
    expect(paths.fromNew).toBe("src/new.ts");
    expect(paths.fromOld).toBe("src/old.ts");
  });

  it("does not let a large file's members crowd out the files around it", () => {
    // `ingest.ts` has over a hundred members. Putting all of them ahead of the
    // context nodes filled a 50-entity budget and cut `supported-extensions.ts`,
    // the file a cross-file question about it needed.
    const many = Array.from({ length: 60 }, (_, i) =>
      member(`m-${i}`, `fn${i}`, [i + 1, i + 2], [60 - i, 1]));
    const imported = node("n-ext", "supported-extensions.ts", "file", "src/cli/supported-extensions.ts");
    const b = bundle({ facts: facts({ memberRefs: many, members: many.map((m) => m.name) }), nodes: [imported] });

    const names = b.entities.map((e) => e.name);
    expect(names.slice(1, 11)).toEqual(many.slice(0, 10).map((m) => m.name));
    expect(names).toContain("supported-extensions.ts");
    expect(names.indexOf("supported-extensions.ts")).toBeLessThan(names.indexOf("fn10"));
    expect(b.entities).toHaveLength(50);
  });

  it("says what the target imports and calls, ahead of what points back at it", () => {
    // The answer to a question asked from an entry point is most often in a
    // file that entry point imports. Before this the bundle only pointed
    // inward -- members, callers, dependents -- and never named it.
    const imports: EntityLocation[] = [
      { id: "i-resolve", name: "resolve.ts", kind: "file", path: "src/cli/resolve.ts" },
    ];
    const callees: EntityLocation[] = [
      { id: "c-scope", name: "ensureReadScope", kind: "function", path: "src/cli/resolve.ts",
        lineStart: 56, lineEnd: 80 },
    ];
    const b = bundle({ facts: facts({ importRefs: imports, calleeRefs: callees }) });

    const structural = b.evidence.filter((e) => e.kind === "structural").map((e) => e.title);
    expect(structural).toContain("imports resolve.ts");
    expect(structural).toContain("calls ensureReadScope");
    expect(structural.indexOf("imports resolve.ts"))
      .toBeLessThan(structural.indexOf("dependent stats.ts"));

    const imported = b.evidence.find((e) => e.title === "imports resolve.ts");
    expect(imported?.location).toEqual({ path: "src/cli/resolve.ts" });
    expect(imported?.reason).toBe("the target imports this");
    expect(b.evidence.find((e) => e.title === "calls ensureReadScope")?.location)
      .toEqual({ path: "src/cli/resolve.ts", lineStart: 56, lineEnd: 80 });

    // And they are entities, so the file an answer lives in is in the bundle.
    expect(b.entities.map((e) => e.name)).toContain("resolve.ts");
  });

  it("names what the neighbouring files define, with where", () => {
    // Members were collected for the target alone, so "which function resolves
    // a workspace" got `config.ts` and nothing inside it: symbol recall was
    // 0.00 on 10 of 11 benchmark tasks even where the right file came back.
    const b = bundle({
      facts: facts({
        importRefs: [{ id: "i-config", name: "config.ts", kind: "file", path: "src/cli/config.ts" }],
        neighbourRefs: [
          { id: "n-resolve", name: "resolveWorkspaceRoot", kind: "function",
            path: "src/cli/config.ts", lineStart: 322, lineEnd: 342 },
          { id: "n-default", name: "getDefaultWorkspace", kind: "function",
            path: "src/cli/config.ts", lineStart: 289, lineEnd: 291 },
        ],
      }),
    });

    const defines = b.evidence.find((e) => e.title === "config.ts defines resolveWorkspaceRoot");
    expect(defines?.location).toEqual({ path: "src/cli/config.ts", lineStart: 322, lineEnd: 342 });
    expect(defines?.refs).toEqual(["n-resolve"]);
    // They are entities, which is what a retrieval score counts as a symbol.
    const names = b.entities.map((e) => e.name);
    expect(names).toContain("resolveWorkspaceRoot");
    expect(names).toContain("getDefaultWorkspace");
    // After the file they came from, so the budget keeps the file first.
    expect(names.indexOf("config.ts")).toBeLessThan(names.indexOf("resolveWorkspaceRoot"));
  });

  it("reads provenance from the chain /v1/provenance actually returns", () => {
    const b = bundle({
      provenance: {
        entityId: FILE,
        chain: [
          { rev: 3, source: { uri: "src/old.ts", extractor: "tree-sitter/1.0", sourceType: "code" } },
          { rev: 9, source: { uri: "src/cli/config.ts", sourceHash: "abc", extractor: "tree-sitter/1.25", sourceType: "code" } },
        ],
      },
    });

    expect(b.provenance).toMatchObject({
      sourceUri: "src/cli/config.ts", sourceHash: "abc", extractor: "tree-sitter/1.25", sourceType: "code",
    });
    expect(b.evidence.find((e) => e.kind === "provenance")?.reason).toBe(
      "provenance code, extractor tree-sitter/1.25",
    );
  });

  it("names relationship endpoints, qualifying a name two entities share", () => {
    const nodes = [
      node("n-a", "README.md", "file", "docs/README.md"),
      node("n-b", "README.md", "file", "README.md"),
    ];
    const edges = [
      { id: "e1", src: "n-a", dst: "n-b", predicate: "REFERENCES", attrs: {}, createdRev: 1 },
      { id: "e2", src: FILE, dst: "m-resolve", predicate: "CONTAINS", attrs: {}, createdRev: 1 },
      { id: "e3", src: FILE, dst: "not-in-bundle", predicate: "IMPORTS", attrs: {}, createdRev: 1 },
    ] as GraphEdge[];
    const titles = bundle({ nodes, edges }).evidence.filter((e) => e.kind === "relationship").map((e) => e.title);

    expect(titles).toContain("README.md (docs/README.md) --REFERENCES--> README.md (README.md)");
    expect(titles).toContain("config.ts --CONTAINS--> resolveWorkspaceRoot");
    expect(titles).toContain("config.ts --IMPORTS--> not-in-bundle");
  });

  it("renders locations in text and llm output", () => {
    const b = bundle();

    const text = captureLog(() => renderBundle(b, "text"));
    expect(text.some((l) => l.includes("path:") && l.includes("src/cli/config.ts"))).toBe(true);
    expect(text).toContain(
      "         src/cli/config.ts:322-342 — defined in the target; used by 13 across 5 other files",
    );

    const llm = captureLog(() => renderBundle(b, "llm"));
    expect(llm[0]).toContain("target_path=src/cli/config.ts");
    // Score is tier + position, and the target's own members lead the
    // structural facts: a file with many imports pushed all of its own members
    // out of the evidence budget when they came last.
    expect(llm).toContain(
      'evidence score=10 kind=structural title="member resolveWorkspaceRoot" path=src/cli/config.ts lines=322-342',
    );
  });

  it("survives the schema round trip, and older bundles without locations still parse", () => {
    const b = bundle();
    const parsed = contextBundleSchema.parse(JSON.parse(JSON.stringify(b)));

    expect(parsed.target.path).toBe("src/cli/config.ts");
    expect(parsed.entities[1]).toMatchObject({ lineStart: 322, lineEnd: 342 });
    expect(parsed.evidence.find((e) => e.title === "member real")?.location).toEqual({
      path: "src/cli/config.ts", lineStart: 40, lineEnd: 41,
    });

    const legacy = JSON.parse(JSON.stringify(b));
    delete legacy.target.path;
    for (const e of legacy.evidence) delete e.location;
    for (const e of legacy.entities) { delete e.lineStart; delete e.lineEnd; }
    expect(contextBundleSchema.safeParse(legacy).success).toBe(true);
  });
});
