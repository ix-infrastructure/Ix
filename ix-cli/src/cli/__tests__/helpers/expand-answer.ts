// Copyright 2026 Ix Infrastructure Inc.

/**
 * What `POST /v1/expand` answers for one node at one hop, built from
 * per-predicate neighbour lists: one edge per listed neighbour, carrying its
 * predicate and pointing the way `direction` says. A request for several
 * predicates gets their edges interleaved (the first of each, then the
 * second of each, ...), each predicate's edges still in their own order, so a
 * client that splits the answer by edge predicate cannot lean on the
 * predicates arriving in blocks. `nodes` are the distinct neighbours in the
 * order their first edge comes.
 *
 * A neighbour that is the node itself is kept in `nodes`, as the per-predicate
 * fixtures these tests replaced listed it.
 */
export function expandAnswer(
  nodeId: string,
  direction: string,
  lists: Record<string, any[]> | undefined,
  predicates: string[],
): { nodes: any[]; edges: any[] } {
  const perPredicate = predicates.map((p) => ({ p, list: lists?.[p] ?? [] }));
  const edges: any[] = [];
  const longest = Math.max(0, ...perPredicate.map(({ list }) => list.length));
  const neighbours: any[] = [];
  for (let i = 0; i < longest; i++) {
    for (const { p, list } of perPredicate) {
      const n = list[i];
      if (!n) continue;
      neighbours.push(n);
      edges.push(direction === "out"
        ? { src: nodeId, dst: n.id, predicate: p }
        : { src: n.id, dst: nodeId, predicate: p });
    }
  }
  const seen = new Set<string>();
  const nodes = neighbours.filter((n) => !seen.has(n.id) && !!seen.add(n.id));
  return { nodes, edges };
}
