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
      const calls_out = id === TARGET && opts?.direction === "out" && opts.predicates?.includes("CALLS");
      if (importedBy) {
        return { nodes: [node(DEPENDENT, "user", "file")], edges: [{ src: DEPENDENT, dst: TARGET, predicate: "IMPORTS" }] };
      }
      if (calls_out) {
        return { nodes: [node(CALLEE, "callee", "function")], edges: [{ src: TARGET, dst: CALLEE, predicate: "CALLS" }] };
      }
      return { nodes: [], edges: [] };
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

    // One entity, six fixed expands (the sixth is the outbound IMPORTS the
    // bundle navigates by), one provenance -- and nothing that grows with the
    // graph.
    expect(calls.filter((c) => c.method === "expand")).toHaveLength(6);
    expect(calls.some((c) => c.method === "expand" && c.predicates?.[0] === "IMPORTS"
                            && c.id === TARGET)).toBe(true);
    expect(calls.filter((c) => c.method === "entity").map((c) => c.id)).toEqual([TARGET]);
    expect(calls.some((c) => c.id === DEPENDENT)).toBe(false);
    expect(calls.some((c) => c.predicates?.includes("IN_REGION"))).toBe(false);

    expect(facts.topDependents).toEqual(["user"]);
    // The fake graph's only outbound edge is the target's CALLS to CALLEE.
    expect(facts.calleeRefs?.map((r) => r.name)).toEqual(["callee"]);
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

/**
 * A file whose members the backend returns in an unhelpful order, with usage
 * recorded per member: `uses[id]` lists the files that use it.
 */
function fileWithMembers(
  calls: Call[],
  members: Array<{ id: string; name: string; kind?: string; lines?: [number, number] }>,
  uses: Record<string, string[]>,
  failing = new Set<string>(),
): IxClient {
  const memberNode = (m: (typeof members)[number]) => ({
    id: m.id, name: m.name, kind: m.kind ?? "function",
    attrs: m.lines ? { line_start: m.lines[0], line_end: m.lines[1] } : {},
    provenance: { sourceUri: "src/config.ts" },
  });
  return {
    async entity(id: string) {
      calls.push({ method: "entity", id });
      return { node: { id, name: "config.ts", kind: "file", attrs: {}, provenance: { sourceUri: "src/config.ts" } }, edges: [] };
    },
    async expand(id: string, opts?: { direction?: string; predicates?: string[]; limit?: number }) {
      calls.push({ method: "expand", id, predicates: opts?.predicates, hops: opts?.limit });
      if (id === TARGET && opts?.predicates?.[0] === "CONTAINS") {
        return { nodes: members.map(memberNode), edges: [] };
      }
      if (id !== TARGET) {
        if (failing.has(id)) throw new Error("backend unavailable");
        const nodes = (uses[id] ?? []).map((file, i) => ({
          id: `${id}-user-${i}`, name: `user${i}`, kind: "function", provenance: { sourceUri: file },
        }));
        return { nodes, edges: [] };
      }
      return { nodes: [], edges: [] };
    },
    async provenance(id: string) {
      calls.push({ method: "provenance", id });
      return { entityId: id, chain: [] };
    },
  } as unknown as IxClient;
}

describe("collectFacts member ranking", () => {
  const members = [
    { id: "m-real", name: "real", lines: [40, 41] as [number, number] },
    { id: "m-const", name: "DEFAULTS", kind: "variable", lines: [1, 30] as [number, number] },
    { id: "m-resolve", name: "resolveWorkspaceRoot", lines: [322, 342] as [number, number] },
    { id: "m-local", name: "localHelper", lines: [50, 60] as [number, number] },
  ];
  const uses = {
    "m-real": ["src/config.ts", "src/config.ts", "src/config.ts"],
    "m-resolve": ["src/a.ts", "src/b.ts", "src/b.ts", "src/config.ts"],
    "m-local": ["src/config.ts"],
  };

  it("ranks members used from other files first, for ix context", async () => {
    const calls: Call[] = [];
    const facts = await collectFacts(fileWithMembers(calls, members, uses), TARGET, "config.ts", "file", "context");

    expect(facts.members).toEqual(["resolveWorkspaceRoot", "real", "localHelper", "DEFAULTS"]);
    expect(facts.memberRefs?.[0]).toMatchObject({
      id: "m-resolve", path: "src/config.ts", lineStart: 322, lineEnd: 342, usedBy: 4, usedFromFiles: 2,
    });
    expect(facts.memberRefs?.[1]).toMatchObject({ usedBy: 3, usedFromFiles: 0 });
    // Bounded reads: the usage probe asks the backend for at most 50 users.
    const probes = calls.filter((c) => c.method === "expand" && c.id !== TARGET);
    expect(probes).toHaveLength(4);
    expect(probes.every((c) => c.hops === 50)).toBe(true);
  });

  it("leaves ix explain's member order, and its request count, alone", async () => {
    const calls: Call[] = [];
    const facts = await collectFacts(fileWithMembers(calls, members, uses), TARGET, "config.ts", "file");

    expect(facts.members).toEqual(["real", "DEFAULTS", "resolveWorkspaceRoot", "localHelper"]);
    expect(facts.memberRefs?.every((m) => m.usedBy === undefined)).toBe(true);
    expect(calls.some((c) => c.method === "expand" && c.id.startsWith("m-"))).toBe(false);
  });

  it("probes at most 40 members, chosen by kind and size", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `m-${i}`, name: `fn${String(i).padStart(2, "0")}`, lines: [i + 1, i + 1 + i] as [number, number],
    }));
    const calls: Call[] = [];
    const facts = await collectFacts(fileWithMembers(calls, many, {}), TARGET, "config.ts", "file", "context");

    const probed = calls.filter((c) => c.method === "expand" && c.id !== TARGET).map((c) => c.id);
    expect(probed).toHaveLength(40);
    // The five smallest are the ones left unprobed, and they come last.
    expect(probed).not.toContain("m-0");
    expect(facts.memberRefs?.slice(-5).map((m) => m.id)).toEqual(["m-4", "m-3", "m-2", "m-1", "m-0"]);
    expect(facts.members).toHaveLength(45);
  });

  it("keeps a member it could not measure, below the measured ones", async () => {
    const calls: Call[] = [];
    const facts = await collectFacts(
      fileWithMembers(calls, members, uses, new Set(["m-resolve"])),
      TARGET, "config.ts", "file", "context",
    );

    expect(facts.members).toContain("resolveWorkspaceRoot");
    expect(facts.memberRefs?.find((m) => m.id === "m-resolve")?.usedBy).toBeUndefined();
    expect(facts.members[0]).toBe("real");
    expect(facts.members.at(-1)).toBe("resolveWorkspaceRoot");
  });
});
