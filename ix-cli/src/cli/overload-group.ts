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
 *
 * The overloads are one node in that answer: a call from one overload to
 * another is an edge of the node to itself, and is left out like one.
 *
 * A class with several constructors is a group too, because the class node
 * holds the first constructor and each later one is a node. It is a class,
 * though, not an overloaded name: only what the later constructors call or
 * reference is missing from the class node, so only those questions reach
 * them, and no row says which constructor it came from.
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
  /**
   * The resolved member is a class that holds its first constructor; the
   * other members are its later constructors.
   */
  classHead: boolean;
}

/** What `overloadGraph` knows about an expansion it merged. */
interface Merged {
  /** The overloads each neighbour was found from. */
  reached: Map<string, OverloadRef[]>;
  /** The rows say which overload they are an edge of. */
  labelled: boolean;
}

/** The groups a wrapped client answers for, by the id each was resolved to. */
const groupsOf = new WeakMap<object, Map<string, Group>>();
const mergedOf = new WeakMap<object, Merged>();

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
 * What a later constructor adds to its class: the calls and references its
 * body makes. Nothing calls it by its own node and it holds no members, so
 * every other question is the class node's alone. The part of `opts` that
 * asks for those edges, or undefined when no part does.
 */
const CONSTRUCTOR_EDGES = ["CALLS", "REFERENCES"];
function constructorQuestion(opts: ExpandOpts): ExpandOpts | undefined {
  if (opts?.direction === "in") return undefined;
  const asked = opts?.predicates ?? [];
  const predicates = asked.length === 0 ? CONSTRUCTOR_EDGES : asked.filter((p) => CONSTRUCTOR_EDGES.includes(p));
  return predicates.length > 0 ? { ...opts, direction: "out", predicates } : undefined;
}

/** The question takes in calls or references, alone or among other edges. */
function asksCalls(opts: ExpandOpts): boolean {
  const predicates = opts?.predicates ?? [];
  return predicates.length === 0 || predicates.some((p) => CONSTRUCTOR_EDGES.includes(p));
}

/**
 * `client` for a command that answers from its targets' edges. When a target
 * stands for an overload group, `expand(<its id>, ...)` is one expansion per
 * overload (at most `OVERLOAD_EXPAND_CAP`, `ALL_CONCURRENCY` in flight) merged
 * by `mergeExpansions`; every other call, and every call when no target is a
 * group, goes to `client` unchanged. A class with several constructors gets
 * the extra expansions only for what it calls or references
 * (`constructorQuestion`); the class itself is always asked the question as
 * it was put.
 */
export function overloadGraph<C extends Pick<IxClient, "expand">>(
  client: C,
  targets: ReadonlyArray<{ id: string; overloads?: OverloadRef[] }>,
): C {
  const groups = new Map<string, Group>();
  for (const target of targets) {
    const members = expandedOverloads(target);
    if (members.length < 2) continue;
    const head = members.find((m) => m.id === target.id) ?? members[0];
    groups.set(target.id, {
      members: [head, ...members.filter((m) => m !== head)],
      cut: members.length < (target.overloads?.length ?? 0),
      classHead: head.signature === undefined,
    });
  }
  if (groups.size === 0) return client;
  const expand = async (id: string, opts?: ExpandOpts): Promise<ExpandResponse> => {
    const group = groups.get(id);
    if (!group || sameForEveryOverload(opts)) return client.expand(id, opts);
    const forLater = group.classHead ? constructorQuestion(opts) : opts;
    if (group.classHead && !forLater) {
      const result = await client.expand(id, opts);
      return asksCalls(opts) ? withoutOwnConstructors(id, group, result) : result;
    }
    const results = await mapLimit(group.members, ALL_CONCURRENCY, (member, i) => client.expand(member.id, i === 0 ? opts : forLater));
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
 * each (the first overload that has one keeps its row), and every overload
 * end of an edge rewritten to the resolved id, so an edge reads as it did
 * when the overloads were one node, and two overloads' edges to one neighbour
 * are one edge. An overload is never a neighbour of its own group: an edge
 * between two of them (`put()` calling `put(String,int)`) is the node's edge
 * to itself and is dropped, and so is the overload's row. A class does hold
 * its later constructors, so for a class only a call or a reference between
 * members is dropped (`new Store()` in a constructor); the `CONTAINS` edge and
 * the constructor's row stay as they came, and so does the class's own edge to
 * itself, which a plain class would show too. `truncated` when any expansion
 * was, or when
 * overloads past the cap were not expanded: the list is then not known to be
 * whole.
 */
function mergeExpansions(rootId: string, group: Group, results: ExpandResponse[], hops: number): ExpandResponse {
  const nodes: ExpandResponse["nodes"] = [];
  const edges: ExpandResponse["edges"] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const reached = new Map<string, OverloadRef[]>();
  const memberIds = new Set(group.members.map((m) => m.id));
  // Members that stay rows: a class's constructors, as what it contains.
  const keptMembers = new Set<string>();
  let truncated = group.cut;
  results.forEach((result) => {
    if ((result as { truncated?: unknown }).truncated === true) truncated = true;
    for (const edge of result.edges ?? []) {
      const inside = memberIds.has(edge.src) && memberIds.has(edge.dst);
      if (inside) {
        const classSelfEdge = group.classHead && edge.src === rootId && edge.dst === rootId;
        if (!group.classHead || (CONSTRUCTOR_EDGES.includes(edge.predicate) && !classSelfEdge)) continue;
        if (classSelfEdge) keptMembers.add(rootId);
        if (edge.src !== rootId) keptMembers.add(edge.src);
        if (edge.dst !== rootId) keptMembers.add(edge.dst);
      }
      const src = !inside && memberIds.has(edge.src) ? rootId : edge.src;
      const dst = !inside && memberIds.has(edge.dst) ? rootId : edge.dst;
      const atRoot = src === rootId || dst === rootId;
      const key = atRoot || !edge.id ? `${src}\u0000${dst}\u0000${edge.predicate}` : `id\u0000${edge.id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(src === edge.src && dst === edge.dst ? edge : { ...edge, src, dst });
    }
  });
  results.forEach((result, i) => {
    const member = group.members[i];
    // Past one hop the answer also holds nodes further out; only the ones an
    // edge joins to the overload are its own neighbours.
    const adjacent = hops > 1
      ? new Set((result.edges ?? []).flatMap((e) => (e.src === member.id ? [e.dst] : e.dst === member.id ? [e.src] : [])))
      : undefined;
    for (const node of result.nodes ?? []) {
      const id = node?.id;
      if (id && memberIds.has(id) && !keptMembers.has(id)) continue;
      if (id && (!adjacent || adjacent.has(id))) reached.set(id, [...(reached.get(id) ?? []), member]);
      if (id && seenNodes.has(id)) continue;
      if (id) seenNodes.add(id);
      nodes.push(node);
    }
  });
  const merged: ExpandResponse & { truncated?: boolean } = { nodes, edges, ...(truncated ? { truncated: true } : {}) };
  mergedOf.set(merged, { reached, labelled: !group.classHead });
  return merged;
}

/**
 * A class's own answer to a question that takes in calls or references,
 * without its later constructors' part: one whose body says `new Store()` or
 * names the type has an edge to the class node, which holds the first
 * constructor, and that is the class using itself (`this(...)` emits no edge).
 * Only calls and references between members go, and then the row of a
 * later constructor no remaining edge joins; its `CONTAINS` edge and row stay
 * in a question that also asks for those, and so does a class's edge to
 * itself. The answer as it came when none is in it, which is nearly always.
 */
function withoutOwnConstructors(rootId: string, group: Group, result: ExpandResponse): ExpandResponse {
  const own = new Set(group.members.map((m) => m.id));
  const allEdges = result.edges ?? [];
  const edges = allEdges.filter((e) =>
    !(own.has(e.src) && own.has(e.dst) && CONSTRUCTOR_EDGES.includes(e.predicate) && !(e.src === rootId && e.dst === rootId)));
  const joined = new Set(edges.flatMap((e) => [e.src, e.dst]));
  const isLoose = (id: string | undefined): boolean => !!id && id !== rootId && own.has(id) && !joined.has(id);
  if (edges.length === allEdges.length && !(result.nodes ?? []).some((n) => isLoose(n?.id))) return result;
  // Only the rows and edges change; whatever else the answer says stays.
  return { ...result, nodes: (result.nodes ?? []).filter((n) => !isLoose(n?.id)), edges };
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
  const reached = mergedOf.get(result)?.reached;
  return reached ? (row) => (row.id ? reached.get(row.id)?.[0]?.id : undefined) : undefined;
}

/**
 * The rows of an expansion, each saying which overload it is an edge of:
 * `overload: "put(String,int)"`, or several joined by ` | ` when the
 * neighbour reaches more than one. The rows as they came for an expansion
 * that was not merged, so a target that is no group prints what it printed,
 * and for a class's: its constructors are not overloads of its name.
 */
export function withOverloadOfRows<T extends { id?: string }>(result: { nodes: T[] }, name: string): T[] {
  const merged = mergedOf.get(result);
  if (!merged?.labelled) return result.nodes;
  const { reached } = merged;
  return result.nodes.map((row) => {
    const overloads = row.id ? reached.get(row.id) : undefined;
    return overloads?.length ? { ...row, overload: overloads.map((o) => overloadLabel(name, o)).join(" | ") } : row;
  });
}
