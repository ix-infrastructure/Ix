// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { IxClient } from "../../client/api.js";
import { buildBundle } from "../context/bundle.js";
import { clampBudgets } from "../context/options.js";
import { collectFacts } from "../explain/facts.js";
import { collectRelatedFiles } from "../explain/related-files.js";

const TARGET = "00000000-0000-0000-0000-000000000001";
const CALLEE = "00000000-0000-0000-0000-000000000002";
const DEPENDENT = "00000000-0000-0000-0000-000000000003";

interface Call {
  method: string;
  id: string;
  predicates?: string[];
  hops?: number;
  limit?: number;
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

    // One entity, six fixed expands on the target (the sixth is the outbound
    // IMPORTS the bundle navigates by), one provenance, and one CONTAINS per
    // neighbouring file -- capped, so nothing here grows with the graph.
    const expands = calls.filter((c) => c.method === "expand");
    expect(expands.filter((c) => c.id === TARGET)).toHaveLength(6);
    expect(calls.some((c) => c.method === "expand" && c.predicates?.[0] === "IMPORTS"
                            && c.id === TARGET)).toBe(true);
    // The one neighbour in this graph is the file that imports the target.
    expect(expands.filter((c) => c.id !== TARGET))
      .toEqual([{ method: "expand", id: DEPENDENT, predicates: ["CONTAINS"], hops: undefined }]);
    // No entity lookups beyond the target, and no hierarchy walk: the
    // neighbour hop is expands only, and bounded.
    expect(calls.filter((c) => c.method === "entity").map((c) => c.id)).toEqual([TARGET]);
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

describe("neighbour members", () => {
  it("takes one member from each neighbouring file before a second from any", async () => {
    // The evidence budget cuts the tail, and four members of the first import
    // crowded out every other file's -- including the file with the answer.
    const files = ["f-a", "f-b"];
    const client = {
      async entity(id: string) {
        return { node: { id, name: "entry.ts", kind: "file", attrs: {}, provenance: { sourceUri: "src/entry.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[] }) {
        if (id === TARGET && opts?.direction === "out" && opts.predicates?.includes("IMPORTS")) {
          return { nodes: files.map((f, i) => ({ id: f, name: `dep${i}.ts`, kind: "file", attrs: {},
                                                 provenance: { sourceUri: `src/dep${i}.ts` } })), edges: [] };
        }
        if (files.includes(id)) {
          const which = id.slice(-1);
          return { nodes: [1, 2, 3].map(n => ({ id: `${id}-m${n}`, name: `${which}${n}`, kind: "function",
                                                attrs: { line_start: n * 10, line_end: n * 10 + 9 - n },
                                                provenance: { sourceUri: `src/dep.ts` } })), edges: [] };
        }
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;

    const facts = await collectFacts(client, TARGET, "entry.ts", "file", "context");

    expect(facts.neighbourRefs?.slice(0, 4).map(r => r.name)).toEqual(["a1", "b1", "a2", "b2"]);
  });
});

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

/**
 * A class whose methods call into other classes (#1138). CALLS edges start at
 * methods, so the class node itself calls nothing: what it uses is only
 * visible through its members.
 */
describe("class targets: what the members call", () => {
  const CLASS = "c-engine";
  const memberNodes = [
    { id: "m-run", name: "run", kind: "method", attrs: { line_start: 20, line_end: 40 }, provenance: { sourceUri: "src/engine.ts" } },
    { id: "m-stop", name: "stop", kind: "method", attrs: { line_start: 41, line_end: 50 }, provenance: { sourceUri: "src/engine.ts" } },
    { id: "m-field", name: "state", kind: "property", attrs: { line_start: 12, line_end: 12 }, provenance: { sourceUri: "src/engine.ts" } },
  ];
  const ext = (id: string, name: string, path: string, line: number, kind = "method") =>
    ({ id, name, kind, attrs: { line_start: line, line_end: line + 5 }, provenance: { sourceUri: path } });
  const parse = ext("x-parse", "parse", "src/parser.ts", 5);
  const save = ext("x-save", "save", "src/store.ts", 9);
  // Defined inside the class's span, but not one of its direct members.
  const inner = ext("x-inner", "inner", "src/engine.ts", 60, "function");
  const memberCalls: Record<string, unknown[]> = {
    "m-run": [parse, memberNodes[1], save],
    "m-stop": [save, inner],
  };

  function classClient(calls: Call[], targetKind = "class"): IxClient {
    return {
      async entity(id: string) {
        calls.push({ method: "entity", id });
        return {
          node: { id, name: "Engine", kind: targetKind, attrs: { line_start: 10, line_end: 80 }, provenance: { sourceUri: "src/engine.ts" } },
          claims: [], decisions: [], edges: [],
        };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[]; limit?: number }) {
        calls.push({ method: "expand", id, predicates: opts?.predicates, limit: opts?.limit });
        if (id === CLASS && opts?.direction === "out" && opts.predicates?.[0] === "CONTAINS") {
          return { nodes: memberNodes, edges: [] };
        }
        if (id !== CLASS && opts?.direction === "out" && opts.predicates?.includes("CALLS")) {
          const nodes = memberCalls[id] ?? [];
          return { nodes, edges: nodes.map((n: any) => ({ src: id, dst: n.id, predicate: "CALLS" })) };
        }
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) {
        calls.push({ method: "provenance", id });
        return { entityId: id, chain: [] };
      },
    } as unknown as IxClient;
  }

  const outwardCallProbes = (calls: Call[]) =>
    calls.filter((c) => c.method === "expand" && c.id !== CLASS && c.predicates?.includes("CALLS")
                        && !c.predicates.includes("REFERENCES"));

  it("lists the outside entities a class's methods call, most-called first", async () => {
    const calls: Call[] = [];
    const facts = await collectFacts(classClient(calls), CLASS, "Engine", "class", "context");

    // The class node itself calls nothing.
    expect(facts.calleeRefs).toEqual([]);
    expect(facts.memberCalleeRefs?.map((r) => r.name)).toEqual(["save", "parse"]);
    expect(facts.memberCalleeRefs?.[0]).toMatchObject({ id: "x-save", path: "src/store.ts", lineStart: 9 });
    expect(facts.memberCalls).toEqual([
      { src: "m-run", dst: "x-parse", predicate: "CALLS" },
      { src: "m-run", dst: "x-save", predicate: "CALLS" },
      { src: "m-stop", dst: "x-save", predicate: "CALLS" },
    ]);
    // Only callable members are probed, one outbound CALLS expand each.
    expect(outwardCallProbes(calls).map((c) => c.id).sort()).toEqual(["m-run", "m-stop"]);
    // Each probe is capped, so a member that calls hundreds of things stays one bounded read.
    expect(outwardCallProbes(calls).map((c) => c.limit)).toEqual([50, 50]);
  });

  it("keeps at most 8 member callees and probes at most 20 members", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `mm-${i}`, name: `method${i}`, kind: "method",
      attrs: { line_start: 100 + i * 10, line_end: 100 + i * 10 + 25 - i }, provenance: { sourceUri: "src/engine.ts" },
    }));
    const calls: Call[] = [];
    const client = {
      async entity(id: string) {
        return { node: { id, name: "Engine", kind: "class", attrs: {}, provenance: { sourceUri: "src/engine.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[]; limit?: number }) {
        calls.push({ method: "expand", id, predicates: opts?.predicates });
        if (id === CLASS && opts?.direction === "out" && opts.predicates?.[0] === "CONTAINS") return { nodes: many, edges: [] };
        if (id.startsWith("mm-") && opts?.direction === "out" && opts.predicates?.includes("CALLS")) {
          return { nodes: [ext(`x-${id}`, `callee_${id}`, `src/dep-${id}.ts`, 3)], edges: [] };
        }
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;

    const facts = await collectFacts(client, CLASS, "Engine", "class", "context");

    expect(outwardCallProbes(calls)).toHaveLength(20);
    expect(facts.memberCalleeRefs).toHaveLength(8);
    // Every edge kept ends at a kept callee.
    const kept = new Set(facts.memberCalleeRefs!.map((r) => r.id));
    expect(facts.memberCalls?.every((e) => kept.has(e.dst))).toBe(true);
    expect(facts.memberCalls).toHaveLength(8);
  });

  it("leaves ix explain, and file targets, as they were", async () => {
    const explainCalls: Call[] = [];
    const explained = await collectFacts(classClient(explainCalls), CLASS, "Engine", "class");
    expect(outwardCallProbes(explainCalls)).toEqual([]);
    expect(explained).not.toHaveProperty("memberCalleeRefs");

    const fileCalls: Call[] = [];
    const file = await collectFacts(classClient(fileCalls, "file"), CLASS, "engine.ts", "file", "context");
    expect(outwardCallProbes(fileCalls)).toEqual([]);
    expect(file).not.toHaveProperty("memberCalleeRefs");
  });

  it("puts the member callees and their CALLS edges in the bundle", async () => {
    const facts = await collectFacts(classClient([]), CLASS, "Engine", "class", "context");
    const bundle = buildBundle({
      resolved: { id: CLASS, name: "Engine", kind: "class", resolutionMode: "exact" },
      facts,
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: clampBudgets({}, "json"),
      format: "json",
      isStale: () => false,
    });

    const ids = bundle.entities.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["x-save", "x-parse", "m-run", "m-stop"]));
    expect(bundle.relationships).toEqual(expect.arrayContaining([
      { src: "m-run", dst: "x-parse", predicate: "CALLS" },
      { src: "m-run", dst: "x-save", predicate: "CALLS" },
      { src: "m-stop", dst: "x-save", predicate: "CALLS" },
    ]));
    const save = bundle.evidence.find((e) => e.refs.includes("x-save") && e.source === "facts.callees");
    expect(save).toMatchObject({ title: "calls save", location: { path: "src/store.ts" } });
    expect(save?.reason).toContain("run");
    expect(save?.reason).toContain("stop");
  });

  const emptyContext = (over: Record<string, unknown> = {}) => ({
    claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
    metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    ...over,
  }) as never;
  const bundleFor = (facts: Awaited<ReturnType<typeof collectFacts>>, context = emptyContext()) => buildBundle({
    resolved: { id: CLASS, name: "Engine", kind: "class", resolutionMode: "exact" },
    facts, context, provenance: {}, budgets: clampBudgets({}, "json"), format: "json", isStale: () => false,
  });

  it("probes constant members and keeps the rest when one member's expand fails", async () => {
    const constant = { id: "m-table", name: "TABLE", kind: "constant", attrs: { line_start: 14, line_end: 18 }, provenance: { sourceUri: "src/engine.ts" } };
    const calls: Call[] = [];
    const base = classClient(calls);
    const client = {
      ...base,
      async expand(id: string, opts?: { direction?: string; predicates?: string[]; limit?: number }) {
        if (id === CLASS && opts?.direction === "out" && opts.predicates?.[0] === "CONTAINS") {
          return { nodes: [...memberNodes, constant], edges: [] };
        }
        if (id === "m-run" && opts?.predicates?.includes("CALLS")) throw new Error("backend timeout");
        if (id === "m-table" && opts?.predicates?.includes("CALLS")) {
          calls.push({ method: "expand", id, predicates: opts.predicates });
          return { nodes: [ext("x-build", "buildTable", "src/table.ts", 2, "function")], edges: [] };
        }
        return base.expand(id, opts as never);
      },
    } as unknown as IxClient;

    const facts = await collectFacts(client, CLASS, "Engine", "class", "context");

    // m-run's failure loses only its calls: stop's and the constant's survive.
    expect(facts.memberCalleeRefs?.map((r) => r.id).sort()).toEqual(["x-build", "x-save"]);
    expect(facts.memberCalls).toEqual([
      { src: "m-stop", dst: "x-save", predicate: "CALLS" },
      { src: "m-table", dst: "x-build", predicate: "CALLS" },
    ]);
  });

  it("does not repeat a member CALLS edge the backend already returned", async () => {
    const facts = await collectFacts(classClient([]), CLASS, "Engine", "class", "context");
    const bundle = bundleFor(facts, emptyContext({ edges: [{ src: "m-run", dst: "x-save", predicate: "CALLS" }] }));
    const runSave = bundle.relationships.filter((e) => e.src === "m-run" && e.dst === "x-save" && e.predicate === "CALLS");
    expect(runSave).toHaveLength(1);
  });

  it("ranks member callees after the class's claims and decisions, so the budget keeps those", async () => {
    const members = Array.from({ length: 10 }, (_, i) => ({
      id: `mm-${i}`, name: `method${i}`, kind: "method",
      attrs: { line_start: 100 + i * 10, line_end: 105 + i * 10 }, provenance: { sourceUri: "src/engine.ts" },
    }));
    const client = {
      async entity(id: string) {
        return { node: { id, name: "Engine", kind: "class", attrs: { line_start: 90, line_end: 300 }, provenance: { sourceUri: "src/engine.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[] }) {
        if (id === CLASS && opts?.direction === "out" && opts.predicates?.[0] === "CONTAINS") return { nodes: members, edges: [] };
        if (id.startsWith("mm-") && opts?.direction === "out" && opts.predicates?.includes("CALLS")) {
          return { nodes: [ext(`x-${id}`, `callee_${id}`, `src/dep-${id}.ts`, 3)], edges: [] };
        }
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;
    const facts = await collectFacts(client, CLASS, "Engine", "class", "context");
    expect(facts.memberCalleeRefs).toHaveLength(8);

    const claim = (i: number) => ({
      claim: { id: `claim-${i}`, statement: `engine fact ${i}`, entityId: CLASS }, relevance: 1, confidence: {},
    });
    const bundle = bundleFor(facts, emptyContext({
      claims: [claim(1), claim(2), claim(3)],
      decisions: [
        { title: "engine owns the run loop", rationale: "one writer", entityId: CLASS },
        { title: "stop is idempotent", rationale: "callers retry", entityId: CLASS },
      ],
    }));

    const kinds = bundle.evidence.map((e) => e.kind);
    expect(kinds.filter((k) => k === "decision")).toHaveLength(2);
    expect(kinds.filter((k) => k === "claim")).toHaveLength(3);
    // Every member callee row comes after the last decision.
    const lastDecision = kinds.lastIndexOf("decision");
    const calleeRows = bundle.evidence
      .map((e, i) => [e, i] as const)
      .filter(([e]) => e.source === "facts.callees");
    expect(calleeRows.length).toBeGreaterThan(0);
    expect(calleeRows.every(([, i]) => i > lastDecision)).toBe(true);
  });

  it("places member callees after the class's callers and dependents in the entity budget", () => {
    const loc = (id: string, kind = "function") => ({ id, name: id, kind, path: `src/${id}.ts` });
    const facts = {
      id: CLASS, name: "Engine", kind: "class", path: "src/engine.ts", stale: false,
      memberRefs: [], members: [], memberCount: 0, topCallers: [], topDependents: [],
      diagnostics: [], historyLength: 0,
      topCallerRefs: [loc("caller")],
      topDependentRefs: [loc("dependent", "file")],
      memberCalleeRefs: Array.from({ length: 8 }, (_, i) => loc(`callee${i}`)),
    } as never;
    const bundle = buildBundle({
      resolved: { id: CLASS, name: "Engine", kind: "class", resolutionMode: "exact" },
      facts, context: emptyContext(), provenance: {},
      budgets: clampBudgets({ maxEntities: 4 }, "json"), format: "json", isStale: () => false,
    });
    const ids = bundle.entities.map((e) => e.id);
    expect(ids).toContain("caller");
    expect(ids).toContain("dependent");
    // The member callees take what is left of the budget, in their ranked order.
    expect(ids.filter((id) => id.startsWith("callee"))).toEqual(["callee0"]);
  });

  it("walks the related files from the member callees too", async () => {
    const expanded: string[] = [];
    const client = {
      async expand(id: string) {
        expanded.push(id);
        return { nodes: [], edges: [] };
      },
    };
    await collectRelatedFiles(client as never, { id: CLASS, kind: "class" }, {
      path: "src/engine.ts",
      walkSeeds: { callers: [], dependents: [], callees: [] },
      memberCalleeRefs: [{ id: "x-save", name: "save", kind: "method", path: "src/store.ts" }],
    });
    expect(expanded).toContain("x-save");
  });
});

/**
 * A class that extends one base, implements one interface (also written as
 * EXTENDS), and references two field types -- one of them the base again, and
 * one a self-reference. `edges` lets a test drop the edge list a backend
 * returns, to check the split does not depend on it.
 */
function classWithTypes(calls: Call[], kind = "class", withEdges = true): IxClient {
  const node = (id: string, name: string, k: string, path: string) => ({
    id, name, kind: k, attrs: { line_start: 1, line_end: 9 }, provenance: { sourceUri: path },
  });
  const outTypes = {
    nodes: [
      node("t-store", "Store", "class", "src/store.ts"),
      node("t-base", "BaseService", "class", "src/base.ts"),
      node("t-iface", "Disposable", "interface", "src/types.ts"),
      node("t-base", "BaseService", "class", "src/base.ts"),
      node(TARGET, "Service", "class", "src/service.ts"),
      node("t-clock", "Clock", "class", "src/clock.ts"),
    ],
    edges: [
      { src: TARGET, dst: "t-store", predicate: "REFERENCES" },
      { src: TARGET, dst: "t-base", predicate: "EXTENDS" },
      { src: TARGET, dst: "t-iface", predicate: "EXTENDS" },
      { src: TARGET, dst: "t-base", predicate: "REFERENCES" },
      { src: TARGET, dst: TARGET, predicate: "REFERENCES" },
      { src: TARGET, dst: "t-clock", predicate: "REFERENCES" },
    ],
  };
  return {
    async entity(id: string) {
      calls.push({ method: "entity", id });
      return { node: node(id, "Service", kind, "src/service.ts"), claims: [], decisions: [], edges: [] };
    },
    async expand(id: string, opts?: { direction?: string; predicates?: string[] }) {
      calls.push({ method: "expand", id, predicates: opts?.predicates });
      if (id === TARGET && opts?.direction === "out" && opts.predicates?.includes("EXTENDS")) {
        return withEdges ? outTypes : { nodes: outTypes.nodes, edges: [] };
      }
      return { nodes: [], edges: [] };
    },
    async provenance(id: string) {
      calls.push({ method: "provenance", id });
      return { entityId: id, chain: [] };
    },
  } as unknown as IxClient;
}

describe("a class target's own types", () => {
  it("reads what the class extends and references, for ix context", async () => {
    const calls: Call[] = [];
    const facts = await collectFacts(classWithTypes(calls), TARGET, "Service", "class", "context");

    // One extra expand on the target, for both predicates.
    const typeReads = calls.filter((c) => c.method === "expand" && c.id === TARGET
                                         && c.predicates?.includes("EXTENDS"));
    expect(typeReads).toEqual([{ method: "expand", id: TARGET, predicates: ["EXTENDS", "REFERENCES"] }]);
    // Bases in the order ingest wrote them; a type that is both a base and a
    // field type is a base, once; the class itself is neither.
    expect(facts.extendsRefs?.map((r) => r.name)).toEqual(["BaseService", "Disposable"]);
    expect(facts.extendsRefs?.[0]).toMatchObject({ id: "t-base", path: "src/base.ts", lineStart: 1, lineEnd: 9 });
    expect(facts.referenceRefs?.map((r) => r.name).sort()).toEqual(["Clock", "Store"]);
  });

  it("treats every type as referenced when the backend returns no edges", async () => {
    const facts = await collectFacts(classWithTypes([], "class", false), TARGET, "Service", "class", "context");

    expect(facts.extendsRefs ?? []).toEqual([]);
    expect(facts.referenceRefs?.map((r) => r.name).sort()).toEqual(["BaseService", "Clock", "Disposable", "Store"]);
  });

  it("caps them: three bases and four referenced types", async () => {
    const many = (prefix: string, predicate: string, n: number) => Array.from({ length: n }, (_, i) => ({
      node: { id: `${prefix}-${i}`, name: `${prefix}${i}`, kind: "class", attrs: {}, provenance: { sourceUri: `src/${prefix}${i}.ts` } },
      edge: { src: TARGET, dst: `${prefix}-${i}`, predicate },
    }));
    const rows = [...many("Base", "EXTENDS", 5), ...many("Ref", "REFERENCES", 9)];
    const client = {
      async entity(id: string) {
        return { node: { id, name: "Service", kind: "class", attrs: {}, provenance: { sourceUri: "src/service.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { direction?: string; predicates?: string[] }) {
        if (id === TARGET && opts?.predicates?.includes("EXTENDS")) {
          return { nodes: rows.map((r) => r.node), edges: rows.map((r) => r.edge) };
        }
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;

    const facts = await collectFacts(client, TARGET, "Service", "class", "context");

    expect(facts.extendsRefs?.map((r) => r.name)).toEqual(["Base0", "Base1", "Base2"]);
    expect(facts.referenceRefs).toHaveLength(4);
  });

  it("keeps a class bundle when the type read fails", async () => {
    const client = {
      async entity(id: string) {
        return { node: { id, name: "Service", kind: "class", attrs: {}, provenance: { sourceUri: "src/service.ts" } }, edges: [] };
      },
      async expand(id: string, opts?: { predicates?: string[] }) {
        if (opts?.predicates?.includes("EXTENDS")) throw new Error("backend unavailable");
        return { nodes: [], edges: [] };
      },
      async provenance(id: string) { return { entityId: id, chain: [] }; },
    } as unknown as IxClient;

    const facts = await collectFacts(client, TARGET, "Service", "class", "context");

    expect(facts.name).toBe("Service");
    expect(facts.extendsRefs ?? []).toEqual([]);
    expect(facts.referenceRefs ?? []).toEqual([]);
  });

  it("is not read for a function or file target, or by ix explain", async () => {
    for (const [kind, scope] of [["function", "context"], ["file", "context"], ["class", "explain"]] as const) {
      const calls: Call[] = [];
      const facts = scope === "context"
        ? await collectFacts(classWithTypes(calls, kind), TARGET, "Service", kind, "context")
        : await collectFacts(classWithTypes(calls, kind), TARGET, "Service", kind);
      // The type read itself; explain's own dependency walk has EXTENDS reads of its own.
      expect(calls.some((c) => c.id === TARGET && c.predicates?.join() === "EXTENDS,REFERENCES"), `${kind} ${scope}`)
        .toBe(false);
      expect(facts, `${kind} ${scope}`).not.toHaveProperty("extendsRefs");
      expect(facts, `${kind} ${scope}`).not.toHaveProperty("referenceRefs");
    }
  });
});
