// Copyright 2026 Ix Infrastructure Inc.

/**
 * Answering for every overload of a method a name resolved to (#1139).
 *
 * The overloads of a Java method were one graph node holding every caller and
 * callee; now each is a node with its own edges, and a name resolves to the
 * first with the rest listed on it (`ResolvedEntity.overloads`). A command
 * that answers from the target's edges wraps its client with `overloadGraph`
 * once the target is resolved: an expansion of the resolved id then runs for
 * every overload and comes back as one answer, the one the single node gave.
 * Only that id is treated so. A node a traversal reaches by an edge is
 * expanded as itself, and a target given as an id has no group, so the
 * wrapper is the client it was handed and sends the requests it always sent.
 */

import type { IxClient } from "../client/api.js";
import { ALL_CONCURRENCY, mapLimit } from "../client/request-memo.js";
import type { ExpandResponse } from "../client/types.js";
import { expandedOverloads, overloadLabel } from "./resolve/pick.js";
import type { OverloadRef } from "./resolve/types.js";

type ExpandOpts = Parameters<IxClient["expand"]>[1];

interface Group {
  /** The overloads expanded, the resolved one first. */
  members: OverloadRef[];
  /** The group has more overloads than are expanded (`OVERLOAD_EXPAND_CAP`). */
  cut: boolean;
}

/** The groups a wrapped client answers for, by the id each was resolved to. */
const groupsOf = new WeakMap<object, Map<string, Group>>();
/** Per merged expansion: the overloads each neighbour was found from. */
const reachedOf = new WeakMap<object, Map<string, OverloadRef[]>>();

/**
 * Where a method is, not what it reaches: its class and its region are the
 * same for every overload, so one request answers for all of them.
 */
const SHARED_IN = new Set(["CONTAINS", "IN_REGION"]);
function sameForEveryOverload(opts: ExpandOpts): boolean {
  const predicates = opts?.predicates ?? [];
  return opts?.direction === "in" && predicates.length > 0 && predicates.every((p) => SHARED_IN.has(p));
}

/**
 * `client` for a command that answers from its targets' edges. When a target
 * stands for an overload group, `expand(<its id>, ...)` is one expansion per
 * overload (at most `OVERLOAD_EXPAND_CAP`, `ALL_CONCURRENCY` in flight) merged
 * by `mergeExpansions`; every other call, and every call when no target is a
 * group, goes to `client` unchanged.
 */
export function overloadGraph<C extends Pick<IxClient, "expand">>(
  client: C,
  targets: ReadonlyArray<{ id: string; overloads?: OverloadRef[] }>,
): C {
  const groups = new Map<string, Group>();
  for (const target of targets) {
    const members = expandedOverloads(target);
    if (members.length > 1) groups.set(target.id, { members, cut: members.length < (target.overloads?.length ?? 0) });
  }
  if (groups.size === 0) return client;
  const expand = async (id: string, opts?: ExpandOpts): Promise<ExpandResponse> => {
    const group = groups.get(id);
    if (!group || sameForEveryOverload(opts)) return client.expand(id, opts);
    const results = await mapLimit(group.members, ALL_CONCURRENCY, (member) => client.expand(member.id, opts));
    return mergeExpansions(id, group, results, opts?.hops ?? 1);
  };
  const wrapped = new Proxy(client as object, {
    get(target, prop) {
      if (prop === "expand") return expand;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as C;
  groupsOf.set(wrapped, groups);
  return wrapped;
}

/**
 * The expansions of a group's overloads as the one node's: neighbours once
 * each (the first overload that has one keeps its row), and each edge's
 * overload end rewritten to the resolved id, so an edge reads as it did when
 * the overloads were one node, and two overloads' edges to one neighbour are
 * one edge. `truncated` when any expansion was, or when overloads past the cap
 * were not expanded: the list is then not known to be whole.
 */
function mergeExpansions(rootId: string, group: Group, results: ExpandResponse[], hops: number): ExpandResponse {
  const nodes: ExpandResponse["nodes"] = [];
  const edges: ExpandResponse["edges"] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const reached = new Map<string, OverloadRef[]>();
  let truncated = group.cut;
  results.forEach((result, i) => {
    const member = group.members[i];
    if ((result as { truncated?: unknown }).truncated === true) truncated = true;
    // Past one hop the answer also holds nodes further out; only the ones an
    // edge joins to the overload are its own neighbours.
    const adjacent = hops > 1
      ? new Set((result.edges ?? []).flatMap((e) => (e.src === member.id ? [e.dst] : e.dst === member.id ? [e.src] : [])))
      : undefined;
    for (const node of result.nodes ?? []) {
      const id = node?.id;
      if (id && (!adjacent || adjacent.has(id))) reached.set(id, [...(reached.get(id) ?? []), member]);
      if (id && seenNodes.has(id)) continue;
      if (id) seenNodes.add(id);
      nodes.push(node);
    }
    for (const edge of result.edges ?? []) {
      const src = edge.src === member.id ? rootId : edge.src;
      const dst = edge.dst === member.id ? rootId : edge.dst;
      const atRoot = src === rootId || dst === rootId;
      const key = atRoot || !edge.id ? `${src}\u0000${dst}\u0000${edge.predicate}` : `id\u0000${edge.id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(src === edge.src && dst === edge.dst ? edge : { ...edge, src, dst });
    }
  });
  const merged: ExpandResponse & { truncated?: boolean } = { nodes, edges, ...(truncated ? { truncated: true } : {}) };
  reachedOf.set(merged, reached);
  return merged;
}

/**
 * The node ids `client` answers for when asked about `id`: every expanded
 * overload of the group `id` was resolved to, or `id` alone. For a command
 * that tells the target apart from its neighbours (a recursive call is not a
 * dependent; a route ends at the target).
 */
export function answeredIds(client: object, id: string): string[] {
  return groupsOf.get(client)?.get(id)?.members.map((m) => m.id) ?? [id];
}

/**
 * For an expansion `overloadGraph` merged: the id of the overload each
 * neighbour was found from (the first, when several reach it). Undefined for
 * any other expansion.
 */
export function overloadOfRow(result: object): ((row: { id?: string }) => string | undefined) | undefined {
  const reached = reachedOf.get(result);
  return reached ? (row) => (row.id ? reached.get(row.id)?.[0]?.id : undefined) : undefined;
}

/**
 * The rows of an expansion, each saying which overload it is an edge of:
 * `overload: "put(String,int)"`, or several joined by ` | ` when the
 * neighbour reaches more than one. The rows as they came for an expansion
 * that was not merged, so a target that is no group prints what it printed.
 */
export function withOverloadOfRows<T extends { id?: string }>(result: { nodes: T[] }, name: string): T[] {
  const reached = reachedOf.get(result);
  if (!reached) return result.nodes;
  return result.nodes.map((row) => {
    const overloads = row.id ? reached.get(row.id) : undefined;
    return overloads?.length ? { ...row, overload: overloads.map((o) => overloadLabel(name, o)).join(" | ") } : row;
  });
}
