// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../client/types.js";
import { buildBundle, clampBudgets, renderBundle } from "../commands/context.js";
import type { ContextFacts } from "../explain/facts.js";

/**
 * `ix context <symbol>` must not move when `--from-issue` is added beside it.
 *
 * The expected lines below were recorded from the renderer before
 * `--from-issue` existed. A symbol bundle carries no issue, so every field and
 * row it gained must be absent, not empty: an agent routing on the evidence
 * order, or a saved investigation diffed against a fresh build, would see an
 * empty `rankedFiles: []` as a change.
 */

function node(id: string, name: string, kind: string, sourceUri?: string): GraphNode {
  return {
    id, name, kind, attrs: {},
    provenance: sourceUri ? { sourceUri } : undefined,
    createdRev: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as GraphNode;
}

const facts: ContextFacts = {
  id: "s-list", name: "listByKind", kind: "method", path: "src/client/api.ts", lineStart: 141, lineEnd: 152,
  container: { id: "c-client", name: "IxClient", kind: "class", path: "src/client/api.ts", lineStart: 20, lineEnd: 400 },
  members: [], memberCount: 0,
  callerCount: 2, calleeCount: 1, dependentCount: 2, importerCount: 0,
  topCallers: ["runRank"],
  topCallerRefs: [{ id: "f-rank", name: "runRank", kind: "function", path: "src/cli/commands/rank.ts", lineStart: 30, lineEnd: 90 }],
  calleeRefs: [{ id: "f-post", name: "post", kind: "method", path: "src/client/api.ts", lineStart: 500, lineEnd: 520 }],
  topDependents: ["inventory.ts"],
  topDependentRefs: [{ id: "d-inv", name: "inventory.ts", kind: "file", path: "src/cli/commands/inventory.ts" }],
  relatedRefs: [{ id: "r-smells", name: "smells.ts", kind: "file", path: "src/cli/commands/smells.ts", score: 0.4, reason: "two steps from the target, through runRank", via: ["runRank"] }],
  recentCommits: [{ sha: "abc1234", date: "2026-09-01", subject: "fix: scope listByKind" }],
  historyLength: 3, introducedRev: 7, stale: false, diagnostics: [],
} as ContextFacts;

function build() {
  return buildBundle({
    resolved: { id: "s-list", name: "listByKind", kind: "method", resolutionMode: "exact" },
    facts,
    context: {
      claims: [], conflicts: [], decisions: [], intents: [],
      nodes: [node("s-list", "listByKind", "method", "src/client/api.ts"), node("f-rank", "runRank", "function", "src/cli/commands/rank.ts")],
      edges: [{ id: "e1", src: "f-rank", dst: "s-list", predicate: "CALLS" }],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    budgets: clampBudgets({}),
    isStale: () => false,
    graphCompleted: true,
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

describe("ix context <symbol> is unchanged by --from-issue", () => {
  it("carries no issue fields", () => {
    const b = build();
    expect(Object.keys(b).sort()).toEqual([
      "budgets", "claims", "conflicts", "decisions", "entities", "evidence", "freshness", "generatedAt",
      "intents", "metadata", "provenance", "relationships", "schema", "target", "truncation",
    ]);
  });

  it("renders the same llm records as before", () => {
    const lines = captureLog(() => renderBundle(build(), "llm")).join("\n").split("\n");
    expect(lines).toEqual(RECORDED_LLM);
  });
});

// CL-07: tier scores (tier * 1000 + place), the caller and dependent rows
// merged into one "used by" row, and the `runRank --CALLS-->` relationship
// dropped because the used-by row already names runRank.
const RECORDED_LLM: string[] = [
  "context target=listByKind target_kind=method target_path=src/client/api.ts stale=false classification=current entities=5 relationships=1 claims=0 decisions=0 conflicts=0 intents=0 evidence=7 truncated_entities=0 truncated_relationships=0 truncated_evidence=0 truncated_chars=0",
  "evidence score=0 kind=target title=\"listByKind (method)\" path=src/client/api.ts lines=141-152",
  "evidence score=2000 kind=structural title=\"container IxClient (class)\" path=src/client/api.ts lines=20-400",
  "evidence score=2001 kind=structural title=\"related files: src/cli/commands/smells.ts\"",
  "evidence score=2002 kind=structural title=\"used by (2 of 2): runRank (rank.ts), inventory.ts\" path=src/cli/commands/rank.ts lines=30-90",
  "evidence score=2003 kind=provenance title=\"recent commits to api.ts: abc1234 fix: scope listByKind\"",
  "evidence score=2004 kind=structural title=\"calls post\" path=src/client/api.ts lines=500-520",
  "evidence score=5000 kind=provenance title=\"history length 3, introduced rev 7\"",
  "next cmd=\"ix read src/client/api.ts:141-152\"",
  "next cmd=\"ix read src/client/api.ts:20-400\"",
  "next cmd=\"ix read src/cli/commands/rank.ts:30-90\"",
];
