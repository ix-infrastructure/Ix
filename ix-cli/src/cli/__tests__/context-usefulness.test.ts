// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "../../client/types.js";
import { buildBundle, clampBudgets, renderBundle } from "../commands/context.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";

/**
 * A usefulness gate for `ix context`, over a fixed set of target shapes.
 *
 * The bundle is the product, and its quality is measurable: what share of the
 * bytes name a place in the repository the caller can open. On recorded bundles
 * that share was 4%, because seventeen `conflict — <uuid> vs <uuid>` rows had
 * taken the evidence budget from the members and imports that answer the
 * question — and nothing failed, because nothing was measuring it.
 *
 * The three assertions are the three ways a bundle goes wrong: it fills up with
 * rows that name nothing, it lets a report kind that is not evidence become
 * evidence, or it overruns the budget it reports. Fixtures rather than a live
 * graph so this runs in CI, and default budgets rather than generous ones so it
 * measures what a caller actually gets.
 */

/** A rendered line is useful when it names somewhere a caller can open. */
const NAMES_A_PLACE = /(?:^|\s)(?:path|target_path)=\S|cmd="ix read \S/;

function loc(id: string, name: string, path: string, lines?: [number, number], kind = "function"): EntityLocation {
  return { id, name, kind, path, ...(lines ? { lineStart: lines[0], lineEnd: lines[1] } : {}) };
}

function node(id: string, name: string, kind: string, sourceUri?: string): GraphNode {
  return {
    id, name, kind, attrs: {},
    provenance: sourceUri ? { sourceUri } : undefined,
    createdRev: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as GraphNode;
}

function conflicts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `cf-${i}`,
    claimA: `1f3b9c2e-${String(i).padStart(4, "0")}-4a11-9d2c-8f5b1a7e0c44`,
    claimB: `7c0a55d1-${String(i).padStart(4, "0")}-4b22-8e3f-2a9d4c6b1e88`,
    reason: "Potential inconsistency (same field prefix)",
    recommendation: "Review both claims",
  }));
}

type Fixture = {
  name: string;
  resolved: { id: string; name: string; kind: string; resolutionMode: string };
  facts: ContextFacts;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  conflicts?: ReturnType<typeof conflicts>;
};

function baseFacts(over: Partial<ContextFacts> & Pick<ContextFacts, "id" | "name" | "kind">): ContextFacts {
  return {
    path: "src/cli/config.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 7, stale: false, diagnostics: [],
    ...over,
  };
}

/**
 * The target shapes a bundle has to be good at: a file whose members are the
 * answer, a symbol whose callers are, an entry point whose imports are, and the
 * one that broke — a target whose backend context is mostly conflict reports.
 */
const FIXTURES: Fixture[] = [
  {
    name: "a file, whose members are the answer",
    resolved: { id: "f-config", name: "config.ts", kind: "file", resolutionMode: "exact" },
    facts: baseFacts({
      id: "f-config", name: "config.ts", kind: "file",
      memberRefs: [
        loc("m-1", "resolveWorkspaceRoot", "src/cli/config.ts", [322, 342]),
        loc("m-2", "getEndpoint", "src/cli/config.ts", [114, 131]),
        loc("m-3", "saveConfig", "src/cli/config.ts", [209, 212]),
      ],
      members: ["resolveWorkspaceRoot", "getEndpoint", "saveConfig"], memberCount: 3,
      dependentCount: 1, topDependents: ["stats.ts"],
      topDependentRefs: [loc("d-1", "stats.ts", "src/cli/commands/stats.ts", undefined, "file")],
    }),
  },
  {
    name: "a symbol, whose callers are the answer",
    resolved: { id: "s-rel", name: "relativePath", kind: "function", resolutionMode: "exact" },
    facts: baseFacts({
      id: "s-rel", name: "relativePath", kind: "function", path: "src/cli/format.ts",
      lineStart: 15, lineEnd: 27,
      callerCount: 3, topCallers: ["registerCallersCommand", "outputResult"],
      topCallerRefs: [
        loc("c-1", "registerCallersCommand", "src/cli/commands/callers.ts", [17, 145]),
        loc("c-2", "outputResult", "src/cli/commands/read.ts", [154, 170]),
      ],
    }),
  },
  {
    name: "an entry point, whose imports are the answer",
    resolved: { id: "s-main", name: "main.ts", kind: "file", resolutionMode: "exact" },
    facts: baseFacts({
      id: "s-main", name: "main.ts", kind: "file", path: "src/cli/main.ts",
      importRefs: [
        loc("i-1", "registerOssCommands", "src/cli/register/oss.ts", [104, 160]),
        loc("i-2", "checkForUpdate", "src/cli/commands/upgrade.ts", [1279, 1303]),
      ],
      calleeRefs: [loc("e-1", "renderCliError", "src/cli/errors.ts", [200, 240])],
      neighbourRefs: [loc("n-1", "buildHelpText", "src/cli/help-text.ts", [12, 60])],
    }),
  },
  {
    name: "a target whose backend context is mostly conflict reports",
    resolved: { id: "s-ctx", name: "buildBundle", kind: "function", resolutionMode: "exact" },
    facts: baseFacts({
      id: "s-ctx", name: "buildBundle", kind: "function", path: "src/cli/commands/context.ts",
      lineStart: 1428, lineEnd: 1600,
      callerCount: 1, topCallers: ["registerContextCommand"],
      topCallerRefs: [loc("c-9", "registerContextCommand", "src/cli/commands/context.ts", [278, 450])],
    }),
    conflicts: conflicts(17),
  },
];

function render(fixture: Fixture): { lines: string[]; bundle: ReturnType<typeof buildBundle> } {
  const bundle = buildBundle({
    resolved: fixture.resolved,
    facts: fixture.facts,
    context: {
      claims: [], conflicts: fixture.conflicts ?? [], decisions: [], intents: [],
      nodes: fixture.nodes ?? [], edges: fixture.edges ?? [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    // The budgets a caller gets by default, not generous ones.
    budgets: clampBudgets({}),
    isStale: () => false,
  });

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    renderBundle(bundle, "llm");
  } finally {
    console.log = orig;
  }
  return { lines, bundle };
}

describe("ix context usefulness", () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      it("spends at least half its bytes naming places a caller can open", () => {
        const { lines } = render(fixture);
        const total = lines.reduce((n, l) => n + l.length, 0);
        const useful = lines.filter((l) => NAMES_A_PLACE.test(l)).reduce((n, l) => n + l.length, 0);
        expect(total).toBeGreaterThan(0);
        expect(useful / total, `${useful}/${total} chars name a place`).toBeGreaterThanOrEqual(0.5);
      });

      it("carries no conflict rows in the evidence", () => {
        // Conflicts name two claims by uuid. They are reported as a count and
        // kept in `conflicts[]`; as evidence they outranked every relationship
        // and took 12-17 of the 25 slots.
        const { lines, bundle } = render(fixture);
        expect(bundle.evidence.filter((e) => e.kind === "conflict")).toEqual([]);
        expect(lines.filter((l) => l.startsWith("evidence") && l.includes("kind=conflict"))).toEqual([]);
      });

      it("stays inside the budget it reports", () => {
        const { bundle } = render(fixture);
        const evidenceChars = bundle.evidence.reduce((n, e) => n + JSON.stringify(e).length, 0);
        expect(evidenceChars).toBeLessThanOrEqual(bundle.budgets.maxChars);
        expect(bundle.evidence.length).toBeLessThanOrEqual(bundle.budgets.maxEvidence);
      });

      it("ends with a read the caller can run", () => {
        const { lines } = render(fixture);
        const next = lines.filter((l) => l.startsWith("next "));
        expect(next.length).toBeGreaterThan(0);
        for (const line of next) expect(line).toMatch(/^next cmd="ix read \S+:\d+-\d+"$/);
      });
    });
  }
});
