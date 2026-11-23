// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { buildBundle } from "../context/bundle.js";
import { clampBudgets } from "../context/options.js";
import { textEvidenceLines } from "../context/render.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";

const target = "target";
const located = (id: string, name = id, kind = "class"): EntityLocation =>
  ({ id, name, kind, path: `src/${name}.java`, lineStart: 10, lineEnd: 30 });
const references = ["ProxyAdminForwarder", "MessagingProcessor", "ServiceManager", "GrpcClientSettingsManager"].map((name) => located(name));
const callees = Array.from({ length: 20 }, (_, i) => located(`callee-${i}`, i === 19 ? "RenewStrategyPolicy" : `callee${i}`));
const parent = located("StartAndShutdown");
const direct = [parent, ...references, ...callees];
const edge = (src: string, dst: string, predicate: string) =>
  ({ id: `${src}:${predicate}:${dst}`, src, dst, predicate, attrs: {}, createdRev: 1, rev: 1 });
const edges = direct.map((ref) => edge(
  target, ref.id, ref === parent ? "EXTENDS" : references.includes(ref) ? "REFERENCES" : "CALLS",
));

function fixture() {
  const memberRefs = Array.from({ length: 10 }, (_, i) => located(`member-${i}`, `member${i}`, "method"));
  const facts: ContextFacts = {
    id: target, name: "ProxyAdminGrpcService", kind: "class", path: "src/ProxyAdminGrpcService.java",
    members: memberRefs.map((ref) => ref.name), memberRefs, memberCount: memberRefs.length,
    callerCount: 0, calleeCount: callees.length, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    calleeRefs: callees.slice(0, 4),
    neighbourRefs: Array.from({ length: 6 }, (_, i) => ({
      ...located(`neighbour-${i}`, `neighbour${i}`, "method"),
      path: `proxy/src/main/java/org/apache/rocketmq/proxy/ProxyStartup${i}.java`,
    })),
    relatedRefs: [parent, ...Array.from({ length: 8 }, (_, i) => located(`related-${i}`))].map((ref) => ({
      ...ref, kind: "file", score: 1, reason: "shared dependency", via: ["dep"],
    })),
    historyLength: 0, stale: false, diagnostics: [],
  };
  return {
    resolved: { id: target, name: facts.name, kind: facts.kind, resolutionMode: "exact" },
    facts,
    context: {
      claims: [], conflicts: [], decisions: [], intents: [],
      nodes: direct.map((ref) => ({
        ...ref, attrs: { line_start: ref.lineStart, line_end: ref.lineEnd },
        provenance: { sourceUri: ref.path!, extractor: "java", sourceType: "code", observedAt: "2026-01-01" },
        createdRev: 1, rev: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
      })), edges,
      metadata: { query: "", seedEntities: [], hopsExpanded: 2, asOfRev: 1 },
    },
    provenance: {}, budgets: clampBudgets({ maxTokens: 3000 }, "text"),
    format: "text" as const, isStale: () => false,
  };
}

describe("class outward context (#1144)", () => {
  it("keeps references, inheritance and calls beyond four in budgeted text before two-step context", () => {
    const bundle = buildBundle(fixture());
    const text = bundle.evidence.flatMap(textEvidenceLines).join("\n");
    for (const ref of direct) {
      const row = bundle.evidence.find((item) => item.refs.includes(ref.id));
      expect(row, ref.name).toMatchObject({ kind: "structural" });
      expect(row!.title, ref.name).toContain(ref.name);
      expect(text).toContain(ref.path);
    }
    expect(text).toMatch(/extends.*StartAndShutdown/);
    expect(text).toMatch(/references.*ProxyAdminForwarder/);
    expect(text).toMatch(/calls.*RenewStrategyPolicy/);
    const outwardEnd = Math.max(...direct.map((ref) => bundle.evidence.findIndex((row) => row.refs.includes(ref.id))));
    for (const source of ["facts.members", "facts.related", "facts.neighbours"]) {
      const index = bundle.evidence.findIndex((row) => row.source === source);
      if (index >= 0) expect(index).toBeGreaterThan(outwardEnd);
    }
    expect(text.length + 600).toBeLessThanOrEqual(6420);
    expect(bundle.truncation.evidenceTruncated).toBeGreaterThan(0);
  });

  it("promotes only outgoing edges of the class and keeps deterministic, deduplicated rows", () => {
    const input = fixture();
    input.context.edges = [
      ...edges, edges[0]!,
      edge("incoming", target, "REFERENCES"),
      edge("member-0", "indirect", "CALLS"),
      edge(target, target, "CALLS"),
    ];
    const first = buildBundle(input);
    const reversed = buildBundle({ ...input, context: { ...input.context, edges: [...input.context.edges].reverse(), nodes: [...input.context.nodes].reverse() } });
    expect(reversed.evidence).toEqual(first.evidence);
    const structural = first.evidence.filter((row) => row.kind === "structural");
    expect(structural.some((row) => row.refs.includes("incoming") || row.refs.includes("indirect"))).toBe(false);
    for (const ref of direct) expect(first.evidence.filter((row) => row.refs.includes(ref.id)), ref.name).toHaveLength(1);
  });

  it("uses compact graph summaries and preserves located callees when the graph slice omits them", () => {
    const input = fixture();
    const bundle = buildBundle({
      ...input,
      context: { ...input.context, nodes: [], edges: [], nodeSummaries: input.context.nodes, edgeSummaries: edges.filter((edge) => edge.predicate !== "CALLS") },
    });
    for (const ref of [parent, ...references, ...callees.slice(0, 4)]) {
      expect(bundle.evidence.find((row) => row.refs.includes(ref.id)), ref.name).toMatchObject({ kind: "structural" });
    }
  });
});
