// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { IxClient } from "../../client/api.js";
import { collectFacts, unresolvedCallNames, unresolvedCallsOf } from "../explain/facts.js";
import { inferImportance } from "../explain/importance.js";
import { renderExplainLlm } from "../explain/llm.js";
import { renderExplanation } from "../explain/render.js";
import { inferRole } from "../explain/role-inference.js";

/**
 * Since tree-sitter/1.28 a call with no node behind it writes no edge, so
 * `ix explain` can no longer find it by following a dangling CALLS edge. It
 * reads the names ingest recorded on the caller instead.
 */

const TARGET = "00000000-0000-0000-0000-000000000001";

/** A function with no outbound CALLS edge at all, only the recorded names. */
function graphWith(attrs: Record<string, unknown>): IxClient {
  return {
    async entity(id: string) {
      return {
        node: { id, name: "runJob", kind: "function", attrs, provenance: { sourceUri: "src/job.ts" } },
        claims: [],
        decisions: [],
        edges: [],
      };
    },
    async expand() {
      return { nodes: [], edges: [] };
    },
    async provenance(id: string) {
      return { entityId: id, chain: [] };
    },
  } as unknown as IxClient;
}

const RECORDED = { unresolved_calls: ["fetch", "JSON.parse", "retry"], unresolved_call_count: 5 };

describe("ix explain on a function with unresolved calls", () => {
  it("names them in the facts and the diagnostic", async () => {
    const facts = await collectFacts(graphWith(RECORDED), TARGET, "runJob", "function");

    expect(facts.unresolvedCalls).toEqual({ names: ["fetch", "JSON.parse", "retry"], total: 5 });
    const diagnostic = facts.diagnostics.find((d) => d.code === "unresolved_call_target");
    expect(diagnostic?.message).toContain("fetch, JSON.parse, retry and 2 more");
  });

  it("names them in the rendered note and the llm output", async () => {
    const facts = await collectFacts(graphWith(RECORDED), TARGET, "runJob", "function");
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);

    expect(rendered.notes.join("\n")).toContain("fetch, JSON.parse, retry and 2 more");
    expect(renderExplainLlm(facts, role, importance, rendered).join("\n")).toContain("fetch, JSON.parse, retry");
  });

  it("says nothing when ingest recorded none", async () => {
    const facts = await collectFacts(graphWith({}), TARGET, "runJob", "function");

    expect(facts.unresolvedCalls).toBeUndefined();
    expect(facts.diagnostics.map((d) => d.code)).not.toContain("unresolved_call_target");
  });

  it("leaves them out of `ix context`, which never rendered unresolved calls", async () => {
    const facts = await collectFacts(graphWith(RECORDED), TARGET, "runJob", "function", "context");

    expect(facts).not.toHaveProperty("unresolvedCalls");
  });
});

describe("unresolvedCallsOf", () => {
  it("reads the two attrs, tolerating junk and a missing count", () => {
    expect(unresolvedCallsOf({ unresolved_calls: ["a", 3, ""], unresolved_call_count: 4 })).toEqual({ names: ["a"], total: 4 });
    expect(unresolvedCallsOf({ unresolved_calls: ["a", "b"] })).toEqual({ names: ["a", "b"], total: 2 });
    expect(unresolvedCallsOf({ unresolved_call_count: 0 })).toBeUndefined();
    expect(unresolvedCallsOf(undefined)).toBeUndefined();
  });

  it("shows a cut list as one", () => {
    expect(unresolvedCallNames({ names: ["a", "b"], total: 2 })).toBe("a, b");
    expect(unresolvedCallNames({ names: ["a", "b"], total: 9 })).toBe("a, b and 7 more");
    expect(unresolvedCallNames({ names: [], total: 3 })).toBe("3 more");
  });
});
