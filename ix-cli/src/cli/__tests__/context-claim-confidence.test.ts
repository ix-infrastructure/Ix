// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { StructuredContext } from "../../client/types.js";
import { buildBundle, clampBudgets } from "../commands/context.js";
import type { ContextFacts } from "../explain/facts.js";

/**
 * Claim evidence in an `ix context` bundle names the claim's confidence as a
 * number. In a `POST /v1/context` response `claims[].confidence` carries the
 * six factor objects and no `score`; reading `confidence.score` labelled
 * every claim "confidence n/a" (ix-infrastructure/Ix#1007). The confidence is
 * the product of the six factor values, clamped to [0, 1]. `finalScore` is
 * relevance × confidence, so it is not the confidence: the fixture's
 * finalScore values are chosen to differ from the confidence so a reason that
 * used finalScore would fail.
 *
 * The body below is the wire shape described in #1007: the factor objects
 * with no `score`. It was not captured from a running backend. It goes through
 * JSON.parse so it reaches the bundle builder untyped, the way the HTTP
 * client hands it over.
 */
const CONTEXT_RESPONSE = `{
  "claims": [
    {
      "claim": {
        "id": "claim-a",
        "entityId": "f-target",
        "statement": "loadConfig reads ix.json from the workspace root",
        "status": "Active"
      },
      "confidence": {
        "baseAuthority": { "value": 0.9, "reason": "parsed from source" },
        "verification": { "value": 1.0, "reason": "no verification" },
        "recency": { "value": 1.0, "reason": "observed at the latest rev" },
        "corroboration": { "value": 1.0, "reason": "single source" },
        "conflictPenalty": { "value": 1.0, "reason": "no conflicts" },
        "intentAlignment": { "value": 1.0, "reason": "no intent" }
      },
      "relevance": 1.0,
      "finalScore": 0.9
    },
    {
      "claim": {
        "id": "claim-b",
        "entityId": "f-target",
        "statement": "loadConfig falls back to defaults",
        "status": "Active"
      },
      "confidence": {
        "baseAuthority": { "value": 0.75, "reason": "parsed from source" },
        "verification": { "value": 1.0, "reason": "no verification" },
        "recency": { "value": 0.8, "reason": "older revision" },
        "corroboration": { "value": 1.0, "reason": "single source" },
        "conflictPenalty": { "value": 1.0, "reason": "no conflicts" },
        "intentAlignment": { "value": 1.0, "reason": "no intent" }
      },
      "relevance": 0.5,
      "finalScore": 0.3
    },
    {
      "claim": {
        "id": "claim-c",
        "entityId": "f-target",
        "statement": "loadConfig caches the parsed file",
        "status": "Stale"
      },
      "confidence": {
        "baseAuthority": { "value": 1.0, "reason": "parsed from source" },
        "verification": { "value": 1.5, "reason": "verified twice" },
        "recency": { "value": 1.0, "reason": "observed at the latest rev" },
        "corroboration": { "value": 1.2, "reason": "two sources" },
        "conflictPenalty": { "value": 1.0, "reason": "no conflicts" },
        "intentAlignment": { "value": 1.0, "reason": "no intent" }
      },
      "relevance": 0.25,
      "finalScore": 0.25
    }
  ],
  "conflicts": [],
  "decisions": [],
  "intents": [],
  "nodes": [],
  "edges": [],
  "metadata": { "query": "loadConfig", "seedEntities": ["f-target"], "hopsExpanded": 1, "asOfRev": 7, "depth": "full" }
}`;

function facts(): ContextFacts {
  return {
    id: "f-target", name: "loadConfig", kind: "function", path: "src/cli/config.ts",
    members: [], memberCount: 0,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 7, stale: false, diagnostics: [],
  };
}

function bundleFor(context: StructuredContext) {
  return buildBundle({
    resolved: { id: "f-target", name: "loadConfig", kind: "function", resolutionMode: "exact" },
    facts: facts(),
    context,
    provenance: {},
    budgets: clampBudgets({}),
    isStale: () => false,
  });
}

function claimReasons(context: StructuredContext): Record<string, string | undefined> {
  const bundle = bundleFor(context);
  return Object.fromEntries(
    bundle.evidence.filter((item) => item.kind === "claim").map((item) => [item.id, item.reason]),
  );
}

describe("ix context claim confidence", () => {
  it("names the product of the six factor values in each claim's reason", () => {
    const context = JSON.parse(CONTEXT_RESPONSE) as StructuredContext;
    // The premise: the factor breakdown has no score of its own.
    expect(context.claims[0].confidence).not.toHaveProperty("score");

    const reasons = claimReasons(context);
    // 0.9 × 1 × 1 × 1 × 1 × 1
    expect(reasons["claim:claim-a"]).toBe("context claim (relevance 1, confidence 0.9)");
    // 0.75 × 0.8 = 0.6, not finalScore 0.3 (= relevance 0.5 × 0.6)
    expect(reasons["claim:claim-b"]).toBe("context claim (relevance 0.5, confidence 0.6)");
    // 1.5 × 1.2 = 1.8, clamped to 1
    expect(reasons["claim:claim-c"]).toBe("context claim (relevance 0.25, confidence 1)");
    for (const reason of Object.values(reasons)) expect(reason).not.toContain("n/a");
  });

  it("does not read the claim's finalScore", () => {
    const context = JSON.parse(CONTEXT_RESPONSE) as StructuredContext;
    delete (context.claims[1] as Partial<StructuredContext["claims"][number]>).finalScore;

    expect(claimReasons(context)["claim:claim-b"]).toBe("context claim (relevance 0.5, confidence 0.6)");
  });

  it("says n/a when a factor value is missing", () => {
    const context = JSON.parse(CONTEXT_RESPONSE) as StructuredContext;
    delete (context.claims[0].confidence as Partial<StructuredContext["claims"][number]["confidence"]>).recency;
    (context.claims[2] as { confidence?: unknown }).confidence = undefined;

    const reasons = claimReasons(context);
    expect(reasons["claim:claim-a"]).toBe("context claim (relevance 1, confidence n/a)");
    expect(reasons["claim:claim-b"]).toBe("context claim (relevance 0.5, confidence 0.6)");
    expect(reasons["claim:claim-c"]).toBe("context claim (relevance 0.25, confidence n/a)");
  });
});
