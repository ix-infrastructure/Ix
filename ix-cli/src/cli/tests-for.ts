// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";
import { mapLimit } from "../client/request-memo.js";
import { rowLocation } from "./format.js";

export interface TestNode {
  id: string;
  name: string;
  kind: string;
  attrs?: Record<string, any>;
  path?: string;
}
export interface TestEdge {
  src: string;
  dst: string;
  predicate: string;
  attrs?: Record<string, any>;
}
export interface TestReach {
  id: string;
  name: string;
  path?: string;
  line?: number;
  kind: string;
  confidence: number;
  selector?: string;
  score: number;
  reaches: string;
  command?: string;
}

const MAX_EXPANSIONS = 40;
const EXPANSION_LIMIT = 250;
const MAX_HOPS = 3;
const confidenceOf = (edge: TestEdge): number =>
  typeof edge.attrs?.confidence === "number"
    ? Math.max(0, Math.min(1, edge.attrs.confidence))
    : 0.5;

export function compareTestReach(a: TestReach, b: TestReach): number {
  return (
    b.score - a.score ||
    (a.path ?? "").localeCompare(b.path ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** Rank static test evidence, including at most two intervening production callers. */
export function rankTestsFor(
  seeds: TestNode[],
  nodes: TestNode[],
  edges: TestEdge[],
  fileFallbacks: TestNode[] = [],
): TestReach[] {
  const byId = new Map([...nodes, ...seeds, ...fileFallbacks].map((n) => [n.id, n]));
  const incoming = new Map<string, TestEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.dst) ?? [];
    list.push(edge);
    incoming.set(edge.dst, list);
  }
  const found = new Map<string, TestReach>();
  let frontier = seeds.map((n) => ({
    id: n.id,
    confidence: 1,
    route: n.name,
    hops: 0,
    fileOnly: false,
  }));
  frontier.push(
    ...fileFallbacks.map((n) => ({
      id: n.id,
      confidence: 0.5,
      route: `${n.name} -CONTAINS-> ${seeds[0].name}`,
      hops: 0,
      fileOnly: true,
    })),
  );
  const best = new Map<string, number>();
  while (frontier.length) {
    const next: typeof frontier = [];
    for (const state of frontier) {
      for (const edge of incoming.get(state.id) ?? []) {
        const node = byId.get(edge.src);
        if (!node) continue;
        const confidence = state.confidence * confidenceOf(edge);
        if (edge.predicate === "TESTS") {
          const via = edge.attrs?.via === "CALLS" ? "CALLS" : "IMPORTS";
          if (state.fileOnly && via !== "IMPORTS") continue;
          const score = (confidence * (via === "CALLS" ? 1 : 0.65)) / (state.hops + 1);
          const previous = found.get(node.id);
          if (previous && previous.score >= score) continue;
          const location = rowLocation(node);
          found.set(node.id, {
            id: node.id,
            name: node.name,
            kind: node.kind,
            path: location.path,
            line: location.lineStart,
            confidence,
            score,
            selector: node.attrs?.test_selector,
            reaches: `TESTS(${via}) -> ${state.route}`,
          });
        } else if (
          !state.fileOnly &&
          (edge.predicate === "CALLS" || edge.predicate === "IMPORTS") &&
          state.hops < MAX_HOPS - 1
        ) {
          const key = `${node.id}:${state.hops + 1}`;
          if ((best.get(key) ?? -1) >= confidence) continue;
          best.set(key, confidence);
          next.push({
            id: node.id,
            confidence,
            hops: state.hops + 1,
            route: `${node.name} -${edge.predicate}-> ${state.route}`,
            fileOnly: false,
          });
        }
      }
    }
    frontier = next;
  }
  // A named test gives finer evidence than its file's import of the same target.
  const namedPaths = new Set(
    [...found.values()]
      .filter((r) => r.kind !== "file")
      .map((r) => r.path)
      .filter(Boolean),
  );
  return [...found.values()]
    .filter((r) => r.kind !== "file" || !r.path || !namedPaths.has(r.path))
    .sort(compareTestReach);
}

/** Bounded graph reads: at most 41 expansions, 6 in flight, using the client's deadline. */
export async function gatherTestsFor(
  client: Pick<IxClient, "expand">,
  target: TestNode,
): Promise<{
  tests: TestReach[];
  truncated: boolean;
}> {
  let seeds = [target];
  let fileFallbacks: TestNode[] = [];
  let truncated = false;
  if (target.kind === "file") {
    const members = await client.expand(target.id, {
      direction: "out",
      predicates: ["CONTAINS"],
      hops: 2,
      limit: EXPANSION_LIMIT,
    });
    seeds.push(
      ...members.nodes.filter((n) => ["function", "method", "class", "interface"].includes(n.kind)),
    );
    truncated ||= members.edges.length >= EXPANSION_LIMIT;
  } else {
    const owners = await client.expand(target.id, {
      direction: "in",
      predicates: ["CONTAINS"],
      hops: 2,
      limit: EXPANSION_LIMIT,
    });
    fileFallbacks = owners.nodes.filter((n) => n.kind === "file");
    truncated ||= owners.edges.length >= EXPANSION_LIMIT;
  }
  const nodes = new Map([...seeds, ...fileFallbacks].map((n) => [n.id, n]));
  const fileFallbackIds = new Set(fileFallbacks.map((n) => n.id));
  const edges = new Map<string, TestEdge>();
  const visited = new Set<string>();
  let frontier = [...seeds, ...fileFallbacks];
  for (let depth = 0; depth < MAX_HOPS && frontier.length; depth++) {
    const pending = frontier
      .filter((n) => !visited.has(n.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch = pending.slice(0, MAX_EXPANSIONS - visited.size);
    truncated ||= batch.length < pending.length;
    if (!batch.length) break;
    batch.forEach((n) => visited.add(n.id));
    const results = await mapLimit(batch, 6, (n) =>
      client.expand(n.id, {
        direction: "in",
        predicates: ["TESTS", "CALLS", "IMPORTS"],
        limit: EXPANSION_LIMIT,
      }),
    );
    const next = new Map<string, TestNode>();
    for (const result of results) {
      truncated ||= result.edges.length >= EXPANSION_LIMIT;
      for (const n of result.nodes) nodes.set(n.id, n);
      for (const edge of result.edges as TestEdge[]) {
        edges.set(`${edge.src}\0${edge.dst}\0${edge.predicate}`, edge);
        if (edge.predicate !== "TESTS" && !fileFallbackIds.has(edge.dst)) {
          const n = nodes.get(edge.src);
          if (n && !n.attrs?.is_test && n.attrs?.role !== "test" && !visited.has(n.id))
            next.set(n.id, n);
        }
      }
    }
    frontier = [...next.values()];
    if (depth === MAX_HOPS - 1 && frontier.length) truncated = true;
  }
  return {
    tests: rankTestsFor(seeds, [...nodes.values()], [...edges.values()], fileFallbacks),
    truncated,
  };
}
