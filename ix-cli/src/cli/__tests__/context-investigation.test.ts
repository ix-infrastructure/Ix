import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
let priorExitCode: number | string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ix-investigation-test-"));
  process.env.IX_HOME = home;
  // loadInvestigation sets process.exitCode on a refusal. That is the host
  // process's exit code, so leaving it set would fail the whole vitest run even
  // with every test green.
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  // IX_HOME is the Ix home directory; investigations live in a subdirectory of
  // it, which saveInvestigation creates. Nothing is pre-created here — the tests
  // below assert on where the code actually writes, not on a directory the test
  // made itself.
});

/** Where saved investigations are expected to live, given IX_HOME. */
const investigationsDir = () => join(home, "investigations");

afterEach(() => {
  delete process.env.IX_HOME;
  process.exitCode = priorExitCode;
  rmSync(home, { recursive: true, force: true });
});

/** Write a raw state file exactly where loadInvestigation looks for it. */
function writeState(id: string, state: unknown): void {
  mkdirSync(investigationsDir(), { recursive: true });
  writeFileSync(join(investigationsDir(), `${id}.json`), JSON.stringify(state), "utf8");
}

/** A well-formed envelope around `bundle`, so only the bundle is under test. */
function envelope(id: string, bundle: unknown) {
  return { schema: "ix-investigation/1", id, savedAt: "2026-01-01T00:00:00Z", bundle };
}

/**
 * Capture what renderWarning printed while `fn` ran.
 *
 * The refusal message is the only thing that says *which* guard rejected a
 * fixture; asserting on the return value alone cannot tell the envelope check
 * from the schema check. renderWarning goes to console.log (ui.ts), so that is
 * what gets spied on.
 */
function captureWarnings(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  // chalk wraps the message as a whole, so the text stays contiguous; strip the
  // colour codes anyway so a CI run with colour forced on matches a local one.
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

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

  it("refuses to resume a tampered bundle, and says the bundle was what failed", () => {
    // The write path is schema-checked, so a non-conforming bundle can only
    // reach disk by being put there — a hand-edited file, a truncated write, or
    // a state file from a different version. The envelope is deliberately
    // *correct* here, so only bundle validation can be what rejects it.
    writeState("tampered", envelope("tampered", { ...bundleWith([]), entities: "not-an-array" }));

    const warning = captureWarnings(() => {
      expect(loadInvestigation("tampered")).toBeUndefined();
    });

    // Which guard fired is only observable in the message. Asserting on the
    // envelope fields of the fixture object instead would compare a literal to
    // itself and could never fail, leaving the envelope check and the schema
    // check indistinguishable.
    expect(warning).toContain("does not match the ix-context-bundle/1 schema");
    expect(warning).not.toContain("unknown schema");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a bundle written against a different contract version", () => {
    // The whole point of a versioned contract: `schema` is pinned to a literal,
    // so a v99 body cannot be rendered by --resume or re-sent by --diff as if
    // it were a v1 one. A `z.string()` here would accept this.
    writeState("skewed", envelope("skewed", { ...bundleWith([]), schema: "ix-context-bundle/99" }));

    const warning = captureWarnings(() => {
      expect(loadInvestigation("skewed")).toBeUndefined();
    });

    expect(warning).toContain("different contract than ix-context-bundle/1");
  });

  it("refuses an evidence item with no title, which the llm renderer dereferences", () => {
    // renderBundle does `item.title.replaceAll(...)` for --format llm. Validation
    // that accepts an untyped evidence record just moves the failure downstream
    // from a named refusal to an uncaught TypeError.
    const evidence = [{ id: "e1", kind: "provenance", source: "s", score: 1, reason: "r", refs: [] }];
    writeState("titleless", envelope("titleless", { ...bundleWith([]), evidence }));

    expect(loadInvestigation("titleless")).toBeUndefined();
  });

  it("refuses empty budgets, which would fabricate an all-removed diff", () => {
    // --diff forwards saved budgets into buildFreshBundle, where
    // `Math.min(n, undefined)` is NaN and `slice(0, NaN)` is []. The fresh side
    // comes back empty and every saved item is reported as removed — a delta
    // that never happened, with no error anywhere.
    writeState("budgetless", envelope("budgetless", { ...bundleWith([]), budgets: {} }));

    expect(loadInvestigation("budgetless")).toBeUndefined();
  });

  it("refuses metadata whose diff inputs are not the types --diff re-sends", () => {
    // mergeDiffOptions passes metadata.depth and metadata.asOfRev straight into
    // the next backend request. They are the only saved values besides
    // target.name that leave the machine, so they are typed, not trusted.
    const metadata = { rankingRule: "deterministic-tier", depth: { nested: true }, asOfRev: "not-a-number" };
    writeState("bad-metadata", envelope("bad-metadata", { ...bundleWith([]), metadata }));

    expect(loadInvestigation("bad-metadata")).toBeUndefined();
  });

  // One field per fixture. A single fixture breaking both `id` and `savedAt`
  // passes as soon as *either* rule fires, so it cannot show that both are
  // enforced — dropping the savedAt check entirely left such a test green.
  it("refuses an envelope whose id is not a string", () => {
    // id is rendered to the terminal and copied into the emitted
    // ix-investigation-diff/1 JSON as `investigation`, so an unvalidated
    // envelope prints `Resumed investigation "[object Object]"`.
    writeState("bad-id", { schema: "ix-investigation/1", id: {}, savedAt: "2026-01-01T00:00:00Z", bundle: bundleWith([]) });

    expect(loadInvestigation("bad-id")).toBeUndefined();
  });

  it("refuses an envelope whose savedAt is not a string", () => {
    // savedAt is rendered as `saved <value>` and copied into the emitted diff.
    // The id here is deliberately valid so the id rule cannot be what fires.
    writeState("bad-savedat", { schema: "ix-investigation/1", id: "bad-savedat", savedAt: null, bundle: bundleWith([]) });

    expect(loadInvestigation("bad-savedat")).toBeUndefined();
  });

  it("refuses an id carrying terminal control characters", () => {
    // sanitizeId escapes these on the way in, so a stored id can never contain
    // them; renderNote and renderSection write the id straight to the terminal.
    writeState("ansi", { ...envelope("bad\u001b[31mid", bundleWith([])) });

    expect(loadInvestigation("ansi")).toBeUndefined();
  });

  it("returns the validated bundle, not the raw file contents", () => {
    // Control for the refusals above — a validator that rejected everything
    // would fail here — and the sanitization guarantee: saveInvestigation
    // persists zod's parsed output, so the read side must too. Returning the raw
    // JSON.parse result instead would echo smuggled keys back out through
    // `--resume --format json` and into the emitted diff.
    const bundle = bundleWith([makeClaim("renders to DOM", 0.9)]);
    saveInvestigation("well-formed", bundle);
    const stored = JSON.parse(readFileSync(join(investigationsDir(), "well-formed.json"), "utf8"));
    stored.bundle.target.EXTRA = "smuggled";
    writeState("well-formed", stored);

    const loaded = loadInvestigation("well-formed");

    expect(loaded).toBeDefined();
    expect(loaded?.bundle.target.name).toBe("Widget");
    expect(loaded?.bundle.evidence).toEqual(bundle.evidence);
    expect(loaded?.bundle.target).not.toHaveProperty("EXTRA");
    // A successful load must not leave a failing status behind.
    expect(process.exitCode).toBeUndefined();
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
