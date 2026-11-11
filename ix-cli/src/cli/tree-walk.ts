// Copyright 2026 Ix Infrastructure Inc.

import { expandCapped } from "./format.js";
import { isRawId } from "./resolve.js";

/**
 * The one-hop tree walk behind `ix trace` (directional modes) and `ix depends`.
 *
 * Both used to recurse depth-first and await each child's whole subtree before
 * starting its sibling, so a walk cost one round trip per expanded node, in
 * series: on the Ix repo's own graph, 1.2-1.8 s of a command whose client work
 * was ~0.1 s. Here the fetching is breadth-first — a node's neighbours are
 * requested the moment the node is discovered, through a bounded limiter — and
 * the tree is built from the fetched lists in a fixed order, so which request
 * returns first never shows in the output.
 *
 * Which tree comes back:
 *
 * - **The walk fits the node cap** (always, when there is no cap). The
 *   breadth-first pass has then fetched every node the old depth-first walk
 *   would expand, and that walk is replayed over the fetched lists. The tree —
 *   shape, child order, dedup, which occurrence of a shared node is expanded
 *   and which is marked `cycle` — and the counters are the old walk's exactly,
 *   except that a cap spent exactly on the last node is no longer reported as
 *   `truncated` when nothing was left to drop.
 *   Replaying matters: breadth-first order would expand a shared node at its
 *   shallowest occurrence, depth-first order at its first one in pre-order.
 *   It has a cost under a depth limit: a node the depth-first walk first met
 *   at the limit, and so never expanded, is fetched anyway when it also sits
 *   shallower. On `ix trace ingestFiles --upstream` that is 20 nodes fetched
 *   for the old walk's 10 — still no slower, the requests being parallel.
 * - **The cap cuts the walk.** The breadth-first tree is returned as it stood
 *   when the cap was reached: every node at depth d is kept before any node at
 *   depth d+1, where the depth-first walk spent the whole budget down its first
 *   branch. `truncated` is set only when a node was actually dropped.
 */

/** Runs a task when a slot is free; FIFO, so requests go out in walk order. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * How many expand requests one command keeps in flight. The backend's
 * throughput on 276 real expand bodies: 1.7 s at 1, 0.60 s at 6, 0.43 s at 8,
 * 0.29 s at 16. Eight is four times one-at-a-time without letting a hub flood
 * a backend other clients share.
 */
export const EXPAND_CONCURRENCY = 8;

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  const pump = (): void => {
    while (active < max && waiting.length > 0) {
      active++;
      waiting.shift()!();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
}

export interface TreeWalkOptions<T extends { children: T[] }> {
  rootId: string;
  maxDepth: number;
  maxNodes: number;
  /** A node's children are merged in this order. */
  predicates: string[];
  /** One predicate's neighbours of a node. */
  expand: (nodeId: string, predicate: string) => Promise<{ nodes: any[] }>;
  /**
   * Every predicate's neighbours of a node in one request: the `/v1/expand`
   * answer, whose edges say which predicate reached each neighbour. When it
   * is given, a node costs this one request instead of one `expand` per
   * predicate, unless its answer cannot be split exactly (see
   * `splitByPredicate`); the node is then fetched through `expand` as before.
   */
  expandAll?: (nodeId: string, predicates: string[]) => Promise<{ nodes: any[]; edges?: any[]; truncated?: unknown }>;
  /** Reorders one predicate's neighbours before the cap sees them. */
  order?: (nodes: any[]) => any[];
  makeNode: (raw: any, predicate: string, seen: { name: string; resolved: boolean; cycle: boolean }) => T;
  /** Shared when several walks run at once, so the bound holds across them. */
  limiter?: Limiter;
}

export interface TreeWalkResult<T> {
  tree: T[];
  truncated: boolean;
  depthLimited: boolean;
  nodesVisited: number;
  maxDepthReached: number;
}

type Neighbours = (nodeId: string) => Promise<any[][]>;

interface WalkState {
  visited: Set<string>;
  nodesVisited: number;
  truncated: boolean;
  depthLimited: boolean;
  maxDepthReached: number;
}

export async function walkTree<T extends { children: T[] }>(opts: TreeWalkOptions<T>): Promise<TreeWalkResult<T>> {
  const limit = opts.limiter ?? createLimiter(EXPAND_CONCURRENCY);
  const fetched = new Map<string, Promise<any[][]>>();
  // Set once the walk is decided: requests still queued behind the limiter are
  // then skipped instead of sent.
  let done = false;

  const onePerPredicate = (nodeId: string): Promise<any[][]> =>
    Promise.all(
      opts.predicates.map((p) =>
        limit(async () => (done ? [] : (await opts.expand(nodeId, p)).nodes)),
      ),
    );

  const fetchLists = async (nodeId: string): Promise<any[][]> => {
    const expandAll = opts.expandAll;
    // One predicate is one request either way: send the one it always was.
    if (!expandAll || opts.predicates.length < 2) return onePerPredicate(nodeId);
    const answer = await limit(async () => (done ? null : await expandAll(nodeId, opts.predicates)));
    if (answer === null) return opts.predicates.map(() => []);
    return splitByPredicate(nodeId, opts.predicates, answer) ?? onePerPredicate(nodeId);
  };

  const neighbours: Neighbours = (nodeId) => {
    let lists = fetched.get(nodeId);
    if (!lists) {
      lists = fetchLists(nodeId).then((raw) => (opts.order ? raw.map(opts.order) : raw));
      // A prefetch the walk never reads must not surface as an unhandled
      // rejection; one it does read still throws where it is awaited.
      lists.catch(() => {});
      fetched.set(nodeId, lists);
    }
    return lists;
  };

  try {
    const levels = await breadthFirst(opts, neighbours);
    if (levels.truncated) return levels;
    return await depthFirst(opts, neighbours);
  } finally {
    done = true;
  }
}

/**
 * One `/v1/expand` answer for several predicates, as the lists one expand per
 * predicate would have returned, a neighbour listed once per predicate that
 * reached it. The API does not promise an order, and a one-predicate request
 * was read in its `nodes` order, so each list keeps the order that request
 * would have had under either way a server can order an answer:
 * - `nodes` in the order their first edge comes (one traversal yields both):
 *   each predicate's neighbours in the order of its own edges;
 * - `nodes` in an order of their own (a sort): that order, for the predicate's
 *   neighbours. A single `nodes` array cannot carry the edge order of every
 *   predicate when they share neighbours, so it is not used then.
 *
 * Null when the answer cannot be split exactly, and the caller asks one
 * predicate at a time instead:
 * - the server's edge cap may have cut it (`expandCapped`). The cap is per
 *   request, so the predicates together can reach it where none alone would;
 * - it has no edges array, or a listed node that no requested edge reaches,
 *   so which predicate it belongs to is unknown.
 * An edge that does not touch the node (one a one-hop answer should not hold)
 * is skipped: it reaches no neighbour of the node, and a node only it would
 * explain still fails the check above. An edge whose other end is not among
 * the nodes (a self-loop: the server leaves the node itself out) lists
 * nothing, as it would have alone.
 */
export function splitByPredicate(
  nodeId: string, predicates: string[], answer: { nodes?: any[]; edges?: any[]; truncated?: unknown },
): any[][] | null {
  const { nodes, edges } = answer;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || expandCapped(answer)) return null;
  const byId = new Map<string, any>();
  for (const n of nodes) if (!byId.has(n?.id)) byId.set(n?.id, n);
  // Each predicate's neighbours in edge order, and every neighbour in the
  // order its first edge comes.
  const byEdges: any[][] = predicates.map(() => []);
  const listed = predicates.map(() => new Set<string>());
  const firstEdgeOrder: string[] = [];
  const reached = new Set<string>();
  for (const e of edges) {
    const i = predicates.indexOf(e?.predicate);
    if (i < 0) continue;
    const other = e.src === nodeId ? e.dst : e.dst === nodeId ? e.src : undefined;
    const n = other === undefined ? undefined : byId.get(other);
    if (n === undefined || listed[i].has(other)) continue;
    listed[i].add(other);
    byEdges[i].push(n);
    if (!reached.has(other)) firstEdgeOrder.push(other);
    reached.add(other);
  }
  if (reached.size !== byId.size) return null;
  // `nodes` in first-edge order: each predicate's edges are the order its own
  // request would have listed its nodes in. `nodes` in some other order (one
  // that does not follow the edges, such as a sort): that order, kept for
  // each predicate's subset, is.
  const ids = [...byId.keys()];
  if (ids.every((id, k) => firstEdgeOrder[k] === id)) return byEdges;
  return predicates.map((_, i) => ids.filter((id) => listed[i].has(id)).map((id) => byId.get(id)));
}

function newState(rootId: string): WalkState {
  return { visited: new Set([rootId]), nodesVisited: 0, truncated: false, depthLimited: false, maxDepthReached: 0 };
}

/** Count and mark one neighbour, the way both walk orders do. */
function admit<T extends { children: T[] }>(
  opts: TreeWalkOptions<T>, state: WalkState, n: any, predicate: string,
): { node: T; followed: boolean } {
  const name = n.name || n.attrs?.name || "";
  const resolved = !!name && !isRawId(name);
  const cycle = state.visited.has(n.id);
  state.nodesVisited++;
  state.visited.add(n.id);
  return { node: opts.makeNode(n, predicate, { name, resolved, cycle }), followed: resolved && !cycle };
}

/**
 * The old recursive walk, unchanged except that it reads each node's
 * neighbours from the lists the breadth-first pass already fetched — which
 * also lets it tell a spent budget from a cut.
 */
async function depthFirst<T extends { children: T[] }>(
  opts: TreeWalkOptions<T>, neighbours: Neighbours,
): Promise<TreeWalkResult<T>> {
  const state = newState(opts.rootId);

  async function expand(nodeId: string, depth: number): Promise<T[]> {
    // Stopping at the depth bound is not the same as cutting something off:
    // there may have been nothing below. `truncated` stays a claim that nodes
    // were definitely lost — which only the node cap can know — and
    // `depthLimited` says the walk stopped descending.
    if (depth > opts.maxDepth) { state.depthLimited = true; return []; }
    const lists = await neighbours(nodeId);
    if (state.nodesVisited >= opts.maxNodes) {
      // The budget is spent, but a node with nothing below it loses nothing.
      // (The recursive walk used to say `truncated` here regardless, so a cap
      // spent exactly on the last node claimed a cut that dropped nothing.)
      if (lists.some((l) => l.length > 0)) state.truncated = true;
      return [];
    }
    state.maxDepthReached = Math.max(state.maxDepthReached, depth);

    const children: T[] = [];
    // A node reached through two predicates is one child, not a child and
    // then a spurious cycle.
    const levelSeen = new Set<string>();
    for (let i = 0; i < lists.length; i++) {
      for (const n of lists[i]) {
        if (state.nodesVisited >= opts.maxNodes) { state.truncated = true; break; }
        if (levelSeen.has(n.id)) continue;
        levelSeen.add(n.id);
        const { node, followed } = admit(opts, state, n, opts.predicates[i]);
        if (followed) node.children = await expand(n.id, depth + 1);
        children.push(node);
      }
    }
    return children;
  }

  const tree = await expand(opts.rootId, 1);
  return { tree, ...counters(state) };
}

/**
 * The same walk in breadth-first order: a FIFO queue of nodes to expand, each
 * one's neighbours requested when it is queued and read strictly in queue
 * order.
 */
async function breadthFirst<T extends { children: T[] }>(
  opts: TreeWalkOptions<T>, neighbours: Neighbours,
): Promise<TreeWalkResult<T>> {
  const state = newState(opts.rootId);
  const tree: T[] = [];
  const queue: Array<{ id: string; depth: number; into: T[] }> = [];
  const enqueue = (id: string, depth: number, into: T[]): void => {
    queue.push({ id, depth, into });
    // Written as the negation of the check below, so a NaN bound (an
    // unparseable --depth, which never stops the walk) still prefetches.
    if (!(depth > opts.maxDepth)) void neighbours(id);
  };

  enqueue(opts.rootId, 1, tree);
  for (let head = 0; head < queue.length; head++) {
    const { id, depth, into } = queue[head];
    if (depth > opts.maxDepth) { state.depthLimited = true; continue; }

    const lists = await neighbours(id);
    if (state.nodesVisited >= opts.maxNodes) {
      // The budget is spent, but a node with nothing below it loses nothing:
      // only a neighbour that would have been listed makes this a cut.
      if (lists.some((l) => l.length > 0)) state.truncated = true;
    } else {
      state.maxDepthReached = Math.max(state.maxDepthReached, depth);
      const levelSeen = new Set<string>();
      for (let i = 0; i < lists.length && !state.truncated; i++) {
        for (const n of lists[i]) {
          if (state.nodesVisited >= opts.maxNodes) { state.truncated = true; break; }
          if (levelSeen.has(n.id)) continue;
          levelSeen.add(n.id);
          const { node, followed } = admit(opts, state, n, opts.predicates[i]);
          if (followed) enqueue(n.id, depth + 1, node.children);
          into.push(node);
        }
      }
    }

    if (state.truncated) {
      // Nodes already kept at the last allowed depth were never descended
      // into, cap or no cap — the depth-first walk reported those too.
      if (queue.slice(head + 1).some((q) => q.depth > opts.maxDepth)) state.depthLimited = true;
      break;
    }
  }

  return { tree, ...counters(state) };
}

function counters(state: WalkState): Omit<TreeWalkResult<never>, "tree"> {
  return {
    truncated: state.truncated,
    depthLimited: state.depthLimited,
    nodesVisited: state.nodesVisited,
    maxDepthReached: state.maxDepthReached,
  };
}
