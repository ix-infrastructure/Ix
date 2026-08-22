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
  listInvestigations,
  renderInvestigationList,
  loadInvestigation,
  mergeDiffOptions,
  parseRequestedBudgets,
  renderBundle,
  renderInvestigationDiff,
  renderSavedInvestigation,
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
 * Capture the refusal message `fn` printed, and prove it stayed off stdout.
 *
 * The message is the only thing that says *which* guard rejected a fixture;
 * asserting on the return value alone cannot tell the envelope check from the
 * schema check. It goes to stderr: it used to go to console.log, which put a
 * chalk-coloured prose line inside the payload of the very `--format json` and
 * `--format llm` callers the refusal was answering. Anything on stdout here is
 * that defect returning, so this fails on it rather than reading it.
 */
function captureWarnings(fn: () => void): string {
  const lines: string[] = [];
  const stdout: string[] = [];
  const outSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
    outSpy.mockRestore();
  }
  expect(stdout).toEqual([]);
  // chalk wraps the message as a whole, so the text stays contiguous; strip the
  // colour codes anyway so a CI run with colour forced on matches a local one.
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Run `fn` with stdout and stderr captured separately.
 *
 * One helper for the file. There were three, and they disagreed: two joined a
 * multi-argument `console.log` with a space, the third pushed each argument as
 * its own line, so identical output produced different arrays depending on
 * which block a test happened to sit in.
 */
function captureStreams(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

/** The same, joined the way a terminal shows it. */
function captureText(fn: () => void): { out: string; err: string } {
  const { out, err } = captureStreams(fn);
  return { out: out.join("\n"), err: err.join("\n") };
}

/** Just the stdout half, for the renderers that write nothing else. */
function captureLog(fn: () => void): string[] {
  return captureStreams(fn).out;
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

    // Numbers, not strings: `--as-of-rev` is validated by its Commander
    // argParser now, so the round trip out to a string and back through
    // `parseInt` is gone.
    expect(mergeDiffOptions(stored, {})).toEqual({ asOfRev: 7, depth: "2" });
    expect(mergeDiffOptions(stored, { asOfRev: 3 })).toEqual({ asOfRev: 3, depth: "2" });
    expect(mergeDiffOptions(stored, { depth: "4" })).toEqual({ asOfRev: 7, depth: "4" });
    expect(mergeDiffOptions(stored, { asOfRev: 3, depth: "4" })).toEqual({ asOfRev: 3, depth: "4" });
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

  it("reports the budget the fresh bundle was actually built with", () => {
    // `effective` is read off `fresh.budgets`, not restated from
    // `saved.bundle.budgets`. That distinction is the whole point of the
    // record: a change that let CLI overrides win would edit the
    // `buildFreshBundle` argument in the action handler, and a restated
    // `effective` would go on reporting the saved budget while the fresh side
    // used another one -- the silent misreport this exists to prevent.
    //
    // So the two sides are given different budgets here. The earlier version of
    // this test pinned `effective` to the *saved* snapshot even though the
    // fresh bundle in front of it had been built with 50/100/25/12000 -- a
    // budget neither side of the comparison had used together.
    const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
    saved.budgets = { maxEntities: 5, maxRelationships: 1, maxEvidence: 2, maxChars: 12000 };
    saveInvestigation("widget-check", saved);
    const stored = loadInvestigation("widget-check")!;
    const fresh = bundleWith([makeClaim("renders to DOM", 0.9)]);
    expect(fresh.budgets).toEqual({ maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 });

    const baselineDiff = diffInvestigations(stored, fresh);
    expect(baselineDiff.budgets.saved).toEqual({ maxEntities: 5, maxRelationships: 1, maxEvidence: 2, maxChars: 12000 });
    expect(baselineDiff.budgets.requested).toBeUndefined();
    expect(baselineDiff.budgets.effective).toEqual(fresh.budgets);
    expect(baselineDiff.budgets.requestedApplied).toBe(false);
    // Nothing was asked for, so there is nothing to explain.
    expect(baselineDiff.budgets.note).toBeUndefined();

    // With CLI overrides, `requested` captures every flag the caller passed,
    // and `requestedApplied` says whether they governed -- derived by comparing
    // against `effective`, not hardcoded.
    const requested = parseRequestedBudgets({ maxEntities: 5, maxEvidence: 2, maxRelationships: 1 });
    expect(requested).toEqual({ maxEntities: 5, maxEvidence: 2, maxRelationships: 1 });

    const overrideDiff = diffInvestigations(stored, fresh, requested);
    expect(overrideDiff.budgets.requested).toEqual(requested);
    expect(overrideDiff.budgets.effective).toEqual(fresh.budgets);
    expect(overrideDiff.budgets.requestedApplied).toBe(false);
    expect(overrideDiff.budgets.note).toMatch(/were not applied to the fresh side/i);

    // Still false when the numbers happen to agree, which is the case that
    // makes "requested equals effective" the wrong derivation: `--max-evidence
    // 25` against a fresh side already built with 25 changes nothing, and
    // reporting true there told an agent its override had taken.
    const matching = parseRequestedBudgets({ maxEntities: 50, maxEvidence: 25 });
    const agreeing = diffInvestigations(stored, fresh, matching);
    expect(agreeing.budgets.requested).toEqual({ maxEntities: 50, maxEvidence: 25 });
    expect(agreeing.budgets.effective).toEqual(fresh.budgets);
    expect(agreeing.budgets.requestedApplied).toBe(false);
    // …and the note beside it says the same thing, in every format.
    expect(agreeing.budgets.note).toMatch(/were not applied to the fresh side/i);
  });

  it("records exactly the --max-* flags that were passed", () => {
    // Validation lives in `parseBudgetOption`, the flags' Commander argParser,
    // so anything arriving here is already a positive integer. What is left is
    // "which flags were given", and an absent one must not become a phantom
    // override in the report.
    expect(parseRequestedBudgets({})).toBeUndefined();
    expect(parseRequestedBudgets({ maxEntities: undefined })).toBeUndefined();
    expect(parseRequestedBudgets({ maxEntities: 10, maxChars: undefined })).toEqual({ maxEntities: 10 });
    expect(
      parseRequestedBudgets({ maxEntities: 10, maxEvidence: 5, maxRelationships: 1, maxChars: 12000 }),
    ).toEqual({ maxEntities: 10, maxEvidence: 5, maxRelationships: 1, maxChars: 12000 });
  });

  it("renders the budget block in --diff text and llm output", () => {
    // Spy on console.log so we can assert exactly what humans and LLMs see.
    // This is the regression guard for the user-visible transparency: if a
    // future refactor flattens renderInvestigationDiff back to "entities/-
    // +", the budget block disappears and the silent ignore comes back.
    const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
    saved.budgets = { maxEntities: 5, maxRelationships: 1, maxEvidence: 2, maxChars: 12000 };
    saveInvestigation("widget-check", saved);
    const stored = loadInvestigation("widget-check")!;
    const fresh = bundleWith([makeClaim("renders to DOM", 0.9)]);
    const requested = { maxEvidence: 25 };

    const capture = () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
      });
      return { lines, restore: () => spy.mockRestore() };
    };

    const text = capture();
    try {
      renderInvestigationDiff(stored, fresh, "text", requested);
    } finally {
      text.restore();
    }
    expect(text.lines.some((l) => l.includes("budgets:"))).toBe(true);
    expect(text.lines.some((l) => l.includes("saved     :") && l.includes("evidence=2"))).toBe(true);
    // One `some`, not two ANDed: `A.some(requested) && A.some(evidence=25)`
    // passes when `evidence=25` lands on any line at all — the `saved` or
    // `effective` line satisfied it — so it survived a `requested` line reading
    // `evidence=not-given`, and on failure said only "expected false to be true".
    expect(text.lines.some((l) => l.includes("requested :") && l.includes("evidence=25"))).toBe(true);
    expect(text.lines.some((l) => l.includes("effective :") && l.includes("evidence=25"))).toBe(true);

    const llm = capture();
    try {
      renderInvestigationDiff(stored, fresh, "llm", requested);
    } finally {
      llm.restore();
    }
    // Records, not the prose block with the colons moved. `scope=requested`
    // carries `applied=` so the precedence rule — saved budgets govern
    // --diff — is a field an agent can test rather than a sentence to read.
    expect(llm.lines).toContain("budgets scope=saved entities=5 relationships=1 evidence=2 chars=12000");
    expect(llm.lines).toContain("budgets scope=requested evidence=25 applied=false");
    expect(llm.lines).toContain("budgets scope=effective entities=50 relationships=100 evidence=25 chars=12000");
    // And none of the prose survives into the record stream.
    expect(llm.lines.some((l) => l.includes(":") && l.startsWith("  "))).toBe(false);

    // json format must already cover this branch in diffInvestigations itself,
    // but assert here that the path is wired and the renderer doesn't double-print.
    const json = capture();
    try {
      renderInvestigationDiff(stored, fresh, "json", requested);
    } finally {
      json.restore();
    }
    expect(json.lines).toHaveLength(1);
    const parsed = JSON.parse(json.lines[0]);
    expect(parsed.budgets.saved).toEqual(saved.budgets);
    expect(parsed.budgets.requested).toEqual(requested);
    expect(parsed.budgets.effective).toEqual(fresh.budgets);
    // The same fact the llm record carries as `applied=`, so a JSON consumer
    // does not have to string-match an English sentence for it — and it agrees
    // with the note and with the text renderer's "not applied" label, which a
    // value comparison did not.
    expect(parsed.budgets.requestedApplied).toBe(false);
    expect(parsed.budgets.note).toMatch(/were not applied to the fresh side/i);
  });

  // `--diff --format llm` used to fall through to the prose renderer, because
  // the diff path only branched on `json`. The llm branch emits records built
  // by `llmLine`, so a value carrying a space is quoted rather than splitting
  // the record. These tests pin that.
  describe("--format llm rendering", () => {

    it("emits a header and counts for an empty diff without falling back to prose", () => {
      const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
      saveInvestigation("widget-llm", saved);
      const stored = loadInvestigation("widget-llm")!;
      const fresh = bundleWith([makeClaim("renders to DOM", 0.9)]);

      const lines = captureLog(() => renderInvestigationDiff(stored, fresh, "llm"));

      // `saved_at` and `generated_at` are on the record because
      // `freshness_previous=current` says the snapshot was fresh when it was
      // taken and not when that was: a baseline from five minutes ago and one
      // from three months ago read identically without them.
      const [header] = lines;
      expect(header).toContain("diff investigation=widget-llm target=Widget");
      expect(header).toContain(`saved_at=${stored.savedAt}`);
      expect(header).toMatch(/generated_at=\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
      expect(header).toContain("freshness_previous=current freshness_current=current");
      // Zero is the answer to the question --diff was asked, so it is carried
      // rather than dropped as a default.
      expect(lines).toContain(
        "count added_entities=0 removed_entities=0 added_relationships=0 removed_relationships=0" +
          " added_evidence=0 removed_evidence=0 added_claims=0 removed_claims=0",
      );
      // No `renderSection` lines means we did not fall back to prose.
      expect(lines.some((l) => l.startsWith("==") || l.startsWith("  "))).toBe(false);
    });

    it("lists added and removed entities, relationships, evidence and claims", () => {
      const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
      saveInvestigation("widget-llm-busy", saved);
      const stored = loadInvestigation("widget-llm-busy")!;

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
          // Fresh side replaces the saved `calls` edge with `holds` — so the
          // diff sees a removed relationship (calls) and an added one (holds),
          // matching what an agent would observe when a refactor renames a
          // graph predicate.
          edges: [
            { id: "edge-add", src: "entity-1", dst: "entity-3", predicate: "holds", attrs: {}, createdRev: 2 },
          ],
        }),
        provenance: { sourceType: "source", extractor: "tree-sitter", observedAt: "2026-01-01T00:00:00Z" },
        asOfRev: undefined,
        depth: undefined,
        budgets: { maxEntities: 50, maxRelationships: 100, maxEvidence: 25, maxChars: 12000 },
      });

      const lines = captureLog(() => renderInvestigationDiff(stored, fresh, "llm"));

      // Counts match the deterministic diff structure. The fresh bundle adds
      // a new claim (mounts to DOM) and replaces the `calls` evidence with a
      // `holds` one, so it has 2 added evidence records and 1 removed — the
      // skolem IDs are `claim:<claim_id>` and
      // `relationship:<src>:<dst>:<predicate>`, so a stale predicate in the
      // ranked evidence list yields a real added/removed pair.
      expect(lines).toContain(
        "count added_entities=1 removed_entities=0 added_relationships=1 removed_relationships=1" +
          " added_evidence=2 removed_evidence=1 added_claims=1 removed_claims=0",
      );

      // The change is a field, not a prefix fused to the record kind, so a
      // consumer routing on `entity` matches both sides of the comparison.
      // `id=` is what makes the stream joinable: the relationship records below
      // name their endpoints by entity id, so without it `dst=entity-3`
      // resolves to nothing the reader has seen.
      expect(lines).toContain(
        "entity change=added id=entity-3 kind=method name=mount path=src/widget.ts",
      );
      expect(lines).toContain("relationship change=removed src=entity-1 pred=calls dst=entity-2");
      expect(lines).toContain("relationship change=added src=entity-1 pred=holds dst=entity-3");

      // A claim id carries the statement, so it contains spaces — quoted, per
      // docs/llm-format.md. Unquoted, `id=claim-mounts to DOM` is three tokens
      // and a consumer reads the id as `claim-mounts`.
      // `statement=` is the field that says what changed. In production the id
      // is the backend's (`c-8f31a2`), so a record carrying only the id told a
      // reader that a claim changed and not what it says; this fixture's
      // `claim-<statement>` ids are what hid that.
      expect(lines).toContain(
        'claim change=added id="claim-mounts to DOM" entity=entity-1 status=active statement="mounts to DOM"',
      );

      // An evidence title is a sentence. Same rule, and the reason the value
      // must never be built with a template literal.
      expect(lines).toContain(
        'evidence change=added score=30 kind=relationship title="entity-1 --holds--> entity-3"',
      );
      expect(lines).toContain(
        'evidence change=removed score=30 kind=relationship title="entity-1 --calls--> entity-2"',
      );

      // One record per line — the wire format invariant.
      for (const line of lines) expect(line).not.toContain("\n");
    });

    it("answers a refusal with a record, not a prose warning", () => {
      // The refusal path wrote `renderWarning`, which is console.log, so the
      // one command being made llm-clean answered `--diff nope --format llm`
      // with a chalk-coloured English sentence in the middle of the record
      // stream. Every sibling command emits `error code=... message="..."`.
      const out: string[] = [];
      const err: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
      console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
      try {
        expect(loadInvestigation("does-not-exist", "llm")).toBeUndefined();
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/^error code=no_saved_investigation message="No saved investigation/);
      // One record on one line, with the path quoted rather than bare.
      expect(out[0]).not.toContain("\n");
      expect(err).toEqual([]);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    });

    it("emits one grammar for `evidence`, whichever ix context surface produced it", () => {
      // `renderBundle` built `evidence 30 relationship <title>` from a template
      // literal: positional, unquoted, newlines stripped and nothing else. An
      // evidence title is a sentence, so every one of those records split into
      // tokens — while `--diff` emitted the keyed, quoted form for the same
      // record kind from the same command.
      const bundle = bundleWith([makeClaim("renders to DOM", 0.9)]);
      const lines = captureLog(() => renderBundle(bundle, "llm"));

      const evidence = lines.filter((l) => l.startsWith("evidence"));
      expect(evidence.length).toBeGreaterThan(0);
      for (const line of evidence) {
        expect(line).toMatch(/^evidence score=\d+ kind=[a-z]+ title=/);
      }
      // The exact record `--diff` would emit for the same item, minus `change=`.
      expect(lines).toContain(
        'evidence score=30 kind=relationship title="entity-1 --calls--> entity-2"',
      );
      // And the header is a record too, not fifteen bare `key=value` lines
      // built by interpolation — `target=${name}` breaks on any name with a
      // space in it.
      expect(lines[0]).toMatch(/^context target=Widget target_kind=class /);
    });

    it("gives --resume its own record kind, not --list's", () => {
      // Both emitted `investigation`, with two fields here and thirteen there,
      // so a consumer routing on the record kind could not tell which shape to
      // expect and reading `target` off this one yielded undefined.
      const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
      saveInvestigation("widget-resume", saved);
      const lines = captureLog(() => renderSavedInvestigation("widget-resume", "llm"));

      expect(lines[0]).toMatch(/^resumed id=widget-resume saved_at=/);
      // …and it carries the one fact the bundle records do not: when the
      // snapshot was taken. `classification=current` says it was fresh then,
      // not when then was.
      expect(lines[0]).toMatch(/saved_at=\d{4}-\d{2}-\d{2}T/);
      // The prose note it replaces is gone from the record stream.
      expect(lines.some((l) => l.includes("Resumed investigation"))).toBe(false);
      expect(lines[1]).toMatch(/^context target=Widget/);
    });

    it("does not regress the prose (text) renderer", () => {
      const saved = bundleWith([makeClaim("renders to DOM", 0.9)]);
      saveInvestigation("widget-llm-text", saved);
      const stored = loadInvestigation("widget-llm-text")!;
      const fresh = bundleWith([makeClaim("renders to DOM", 0.9), makeClaim("mounts to DOM", 0.7)]);

      const lines = captureLog(() => renderInvestigationDiff(stored, fresh, "text"));

      // Prose path still emits its summary header and the `+N`/`-N` totals.
      expect(lines.some((l) => l.includes("Investigation diff: widget-llm-text"))).toBe(true);
      expect(lines.some((l) => /claims:\s+-\d+\s+\+\d+/.test(l))).toBe(true);
      expect(lines.some((l) => /entities:\s+-\d+\s+\+\d+/.test(l))).toBe(true);
    });
  });

  // `ix context --list` enumerates saved investigations for discovery.
  // Without it, neither humans nor agents can see what they have stored —
  // the only path was reading the JSON files directly.
  describe("listInvestigations", () => {
    /** Restamp a saved investigation's `savedAt`, leaving everything else alone. */
    const stampSavedAt = (id: string, savedAt: string) => {
      const path = join(investigationsDir(), `${id}.json`);
      const state = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...state, savedAt }), "utf8");
    };

    it("returns saved investigations newest-first", () => {
      // The timestamps are set explicitly because `saveInvestigation` stamps
      // them from the clock and three writes inside one millisecond is the
      // ordinary case, not the rare one. The previous version of this test
      // asserted `saved[0].id === "widget-a" || saved[0].id === "widget-b"` and
      // called `.sort()` on the ids before comparing them, so it was true for
      // either order: inverting the comparator left every assertion green and
      // ordering — the function's whole stated purpose — had no coverage.
      saveInvestigation("widget-a", bundleWith([makeClaim("renders to DOM", 0.9)]));
      saveInvestigation("widget-b", bundleWith([makeClaim("mounts to DOM", 0.7)]));
      saveInvestigation("widget-c", bundleWith([makeClaim("unmounts cleanly", 0.5)]));
      stampSavedAt("widget-a", "2026-01-02T00:00:00.000Z");
      stampSavedAt("widget-b", "2026-01-03T00:00:00.000Z");
      stampSavedAt("widget-c", "2026-01-01T00:00:00.000Z");

      const list = listInvestigations();
      expect(list.saved.map((s) => s.id)).toEqual(["widget-b", "widget-a", "widget-c"]);
      expect(list.skipped).toBe(0);
    });

    it("breaks a same-millisecond tie on the id, stably", () => {
      // The reason the comparator has a second clause at all: two saves in the
      // same millisecond must still come back in the same order every run.
      for (const id of ["widget-c", "widget-a", "widget-b"]) {
        saveInvestigation(id, bundleWith([makeClaim("renders to DOM", 0.9)]));
        stampSavedAt(id, "2026-01-01T00:00:00.000Z");
      }
      expect(listInvestigations().saved.map((s) => s.id)).toEqual([
        "widget-a",
        "widget-b",
        "widget-c",
      ]);
    });

    it("lists an id that --resume can actually take back", () => {
      // `sanitizeId` is injective and deliberately not idempotent — it encodes
      // `~` as `~7E` so a raw `~` cannot be mistaken for an escape — so the id
      // stored on disk is the wrong thing to print next to "Resume with:".
      // `widget/auth` was saved as `widget~2Fauth` and listed as that, and
      // resuming it looked for `widget~7E2Fauth`, which does not exist.
      saveInvestigation("widget/auth", bundleWith([makeClaim("renders to DOM", 0.9)]));
      // Stored encoded, one file, no separator in the name.
      expect(readdirSync(investigationsDir())).toEqual(["widget~2Fauth.json"]);

      // Decoded once, at the read boundary, so every format agrees. Decoding at
      // each print site is how `--format llm` came to say `widget/auth` while
      // `--format json` and the text header said `widget~2Fauth`.
      const [only] = listInvestigations().saved;
      expect(only.id).toBe("widget/auth");
      const { out } = captureText(() => renderInvestigationList([only], 0, "json"));
      expect(JSON.parse(out).investigations[0].id).toBe("widget/auth");
      // The whole point: the id the listing offers has to load.
      expect(loadInvestigation(only.id)?.bundle.target.name).toBe("Widget");
    });

    it("lists a non-Latin-1 id as the characters the user typed", () => {
      // Above U+0100 the escape carries its `u` width marker, so `~u7528` is
      // one code unit and cannot also be read as `~752` plus a literal `8`.
      // That is what lets the round-trip check accept the decode instead of
      // falling back to showing the stored name.
      saveInvestigation("用户", bundleWith([makeClaim("renders to DOM", 0.9)]));
      expect(readdirSync(investigationsDir())).toEqual(["~u7528~u6237.json"]);

      const [only] = listInvestigations().saved;
      expect(only.id).toBe("用户");
      // Both the listed id and the stored form reach the same file.
      expect(loadInvestigation(only.id)?.bundle.target.name).toBe("Widget");
      expect(loadInvestigation("~u7528~u6237")?.bundle.target.name).toBe("Widget");
    });

    it("shows a pre-marker stored id verbatim rather than guessing at it", () => {
      // Written by a CLI that emitted a bare `~HHHH`, which is genuinely
      // ambiguous — `~7528` is either one CJK code unit or `~752` followed by a
      // literal `8`, and nothing in the string says which. The round-trip check
      // refuses to guess, shows the stored name, and `loadInvestigation`
      // accepts that form so the listed id still loads.
      const dir = investigationsDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "~7528~6237.json"),
        JSON.stringify({
          schema: "ix-investigation/1",
          id: "~7528~6237",
          savedAt: "2026-01-01T00:00:00.000Z",
          bundle: bundleWith([makeClaim("renders to DOM", 0.9)]),
        }),
      );

      const [only] = listInvestigations().saved;
      expect(only.id).toBe("~7528~6237");
      expect(loadInvestigation(only.id)?.bundle.target.name).toBe("Widget");
    });

    it("keeps an id that is literally spelled like an encoding on its own file", () => {
      // The on-disk fallback is second, not first, so `widget~2Fauth` typed as
      // an id finds the file it was saved to rather than the one `widget/auth`
      // was.
      saveInvestigation("widget/auth", bundleWith([makeClaim("renders to DOM", 0.9)]));
      saveInvestigation("widget~2Fauth", bundleWith([makeClaim("mounts to DOM", 0.9)]));
      expect(readdirSync(investigationsDir()).sort()).toEqual(
        ["widget~2Fauth.json", "widget~7E2Fauth.json"],
      );
      const claims = (id: string) =>
        loadInvestigation(id)!.bundle.claims.map((c) => c.statement);
      expect(claims("widget/auth")).toContain("renders to DOM");
      expect(claims("widget~2Fauth")).toContain("mounts to DOM");
    });

    it("skips files whose envelope or bundle does not match the contract", () => {
      saveInvestigation("good", bundleWith([makeClaim("renders to DOM", 0.9)]));
      const dir = investigationsDir();
      writeFileSync(join(dir, "corrupt-envelope.json"), JSON.stringify({ schema: "ix-investigation/9", bundle: {} }));
      writeFileSync(join(dir, "truncated.json"), "{not json");
      writeFileSync(join(dir, "tampered-body.json"), JSON.stringify({
        schema: "ix-investigation/1",
        id: "tampered-body",
        savedAt: "2026-01-01T00:00:00Z",
        bundle: { schema: "ix-context-bundle/1", generatedAt: "x", entities: "not-an-array" },
      }));
      writeFileSync(join(dir, "readme.md"), "not a state file");

      const list = listInvestigations();
      expect(list.saved.map((s) => s.id)).toEqual(["good"]);
      // Counted and handed back, not printed: the enumerator runs before the
      // renderer knows whether the caller asked for JSON.
      expect(list.skipped).toBe(3);
      // The three corrupt files do not poison the listing.
      expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(4);
    });

    it("returns an empty listing when the investigations dir does not exist yet", () => {
      expect(listInvestigations()).toEqual({ saved: [], skipped: 0 });
      saveInvestigation("first", bundleWith([makeClaim("renders to DOM", 0.9)]));
      expect(listInvestigations().saved).toHaveLength(1);
    });

    it("keeps the skip report off stdout in every machine format", () => {
      // json must stay parseable and llm must stay records, so the human
      // warning goes to stderr and the machine formats carry a count instead.
      saveInvestigation("good", bundleWith([makeClaim("renders to DOM", 0.9)]));
      const { saved } = listInvestigations();

      const json = captureText(() => renderInvestigationList(saved, 3, "json"));
      expect(() => JSON.parse(json.out)).not.toThrow();
      const parsed = JSON.parse(json.out);
      expect(parsed.investigations).toHaveLength(1);
      // An array had nowhere to put this, so a machine caller could not tell
      // three files had been rejected while the human saw a warning saying so.
      expect(parsed.skipped).toBe(3);
      expect(json.err).toContain("3 saved investigation file(s)");

      const llm = captureText(() => renderInvestigationList(saved, 3, "llm"));
      expect(llm.out.split("\n")[0]).toBe("investigations total=1 skipped=3");
      // The count is the record's business; nothing is written beside it.
      expect(llm.err).toBe("");

      // And with nothing skipped the field is simply absent.
      const clean = captureText(() => renderInvestigationList(saved, 0, "llm"));
      expect(clean.out.split("\n")[0]).toBe("investigations total=1");
      expect(clean.err).toBe("");
      // `skipped` is still there in json, as a zero rather than as nothing:
      // "none were rejected" is an answer, and its absence is not.
      const cleanJson = captureText(() => renderInvestigationList(saved, 0, "json"));
      expect(JSON.parse(cleanJson.out).skipped).toBe(0);
    });

    it("returns a summary per investigation, not the bundles themselves", () => {
      // `--list` is the discovery step. Twenty saved investigations is twenty
      // complete bundles — up to 50 entities, 100 relationships and 12000
      // characters of evidence each — and a caller that wants one of them asks
      // for it by id with `--resume <id> --format json`.
      saveInvestigation("widget", bundleWith([makeClaim("renders to DOM", 0.9)]));
      const { saved } = listInvestigations();
      expect(saved[0].bundle.evidence.length).toBeGreaterThan(0);

      const { out } = captureText(() => renderInvestigationList(saved, 0, "json"));
      const [item] = JSON.parse(out).investigations;
      expect(Object.keys(item).sort()).toEqual(
        ["counts", "freshness", "id", "savedAt", "target", "truncation"].sort(),
      );
      expect(item.counts.evidence).toBe(saved[0].bundle.evidence.length);
      expect(out).not.toContain("renders to DOM");
    });

    it("prints nothing itself, whatever it finds", () => {
      // The defect this replaces: the warning was a `renderWarning` inside the
      // enumerator, and every renderer in ui.ts writes to stdout. One corrupt
      // file therefore prepended a chalk-coloured prose line to the payload,
      // and `ix context --list --format json | jq` failed on it.
      saveInvestigation("good", bundleWith([makeClaim("renders to DOM", 0.9)]));
      writeFileSync(join(investigationsDir(), "truncated.json"), "{not json");

      const lines: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a: unknown[]) => void lines.push(a.join(" "));
      console.error = (...a: unknown[]) => void lines.push(a.join(" "));
      try {
        listInvestigations();
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
      expect(lines).toEqual([]);
    });
  });
});
