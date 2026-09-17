// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { IxClient } from "../../client/api.js";
import { collectFacts } from "../explain/facts.js";

const TARGET = "00000000-0000-0000-0000-000000000001";
const CALLEE = "00000000-0000-0000-0000-000000000002";
const DEPENDENT = "00000000-0000-0000-0000-000000000003";

interface Call {
  method: string;
  id: string;
  predicates?: string[];
  hops?: number;
}

/**
 * A graph where the target calls one function and is imported by one file,
 * so every optional step `collectFacts` can take has something to do: the
 * dependency tree has a node to walk, and the callee list has a callee to look
 * up.
 */
function fakeClient(calls: Call[]): IxClient {
  const node = (id: string, name: string, kind: string) => ({
    id, name, kind, attrs: {}, provenance: { sourceUri: `src/${name}.ts` },
  });
  return {
    async entity(id: string) {
      calls.push({ method: "entity", id });
      return {
        node: node(id, id === TARGET ? "config" : "callee", "function"),
        claims: [],
        decisions: [],
        edges: id === TARGET ? [{ src: TARGET, dst: CALLEE, predicate: "CALLS" }] : [],
      };
    },
    async expand(id: string, opts?: { direction?: string; predicates?: string[]; hops?: number }) {
      calls.push({ method: "expand", id, predicates: opts?.predicates, hops: opts?.hops });
      const importedBy = id === TARGET && opts?.direction === "in" && opts.predicates?.includes("IMPORTS");
      return importedBy
        ? { nodes: [node(DEPENDENT, "user", "file")], edges: [{ src: DEPENDENT, dst: TARGET, predicate: "IMPORTS" }] }
        : { nodes: [], edges: [] };
    },
    async provenance(id: string) {
      calls.push({ method: "provenance", id });
      return { entityId: id, chain: [{}, {}] };
    },
  } as unknown as IxClient;
}

describe("collectFacts scope", () => {
  it("fetches only what `ix context` reads", async () => {
    const calls: Call[] = [];

    const facts = await collectFacts(fakeClient(calls), TARGET, "config", "function", "context");

    // One entity, five fixed expands, one provenance -- and nothing that
    // grows with the graph.
    expect(calls.filter((c) => c.method === "expand")).toHaveLength(5);
    expect(calls.filter((c) => c.method === "entity").map((c) => c.id)).toEqual([TARGET]);
    expect(calls.some((c) => c.id === DEPENDENT)).toBe(false);
    expect(calls.some((c) => c.predicates?.includes("IN_REGION"))).toBe(false);

    expect(facts.topDependents).toEqual(["user"]);
    expect(facts.historyLength).toBe(2);
    // Handed on so `ix context` does not fetch the same provenance twice.
    expect(calls.filter((c) => c.method === "provenance")).toHaveLength(1);
    expect(facts.provenance).toEqual({ entityId: TARGET, chain: [{}, {}] });
    // Absent, not zeroed: a skipped fact must not read as a measured one.
    expect(facts).not.toHaveProperty("downstreamDependents");
    expect(facts).not.toHaveProperty("callList");
    expect(facts).not.toHaveProperty("systemPath");
  });

  it("still collects everything `ix explain` renders", async () => {
    const calls: Call[] = [];

    const facts = await collectFacts(fakeClient(calls), TARGET, "config", "function");

    expect(calls.some((c) => c.id === DEPENDENT)).toBe(true);
    expect(calls.some((c) => c.predicates?.includes("IN_REGION"))).toBe(true);
    expect(calls.filter((c) => c.method === "entity").map((c) => c.id)).toContain(CALLEE);
    expect(facts.downstreamDependents).toBeGreaterThan(0);
    expect(facts.callList?.map((c) => c.name)).toEqual(["callee"]);
  });
});
