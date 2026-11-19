// Copyright 2026 Ix Infrastructure Inc.
import type { IxClient } from "../../client/api.js";
import type { GraphNode, StructuredContext } from "../../client/types.js";
import {
  behaviorTarget,
  directMembers,
  MAX_BEHAVIOR_MEMBERS,
  projectBehavior,
  unavailableBehavior,
} from "../behavioral-evidence.js";
import { activeReadScope, ensureReadScope, isRawId, qualifiedSeparator } from "../resolve.js";
import type { ContextFacts } from "../explain/facts.js";

type Target = { id: string; kind: string; name: string; path?: string; revisionNode?: GraphNode };
const atRevision = (n: GraphNode, rev: number) =>
  Number.isInteger(n.createdRev) &&
  n.createdRev <= rev &&
  (n.deletedRev == null || n.deletedRev > rev);
const pathOf = (n: GraphNode) => n.provenance?.sourceUri ?? n.provenance?.source_uri;

export async function revisionTarget(
  client: IxClient,
  term: string,
  rev: number | undefined,
  opts: { kind?: string; path?: string; pick?: number },
) {
  if (!rev || opts.pick !== undefined) return undefined;
  const separator = qualifiedSeparator(term);
  const name = separator ? term.slice(term.lastIndexOf(separator) + separator.length) : term;
  try {
    let node: GraphNode | undefined;
    if (isRawId(term)) {
      const snap = await client.historicalNodes([term], rev);
      if (snap.metadata?.asOfRev === rev) node = snap.nodes.find((n) => n.id === term);
    } else {
      await ensureReadScope(client);
      const found = await client.search(name, {
        asOfRev: rev,
        kind: opts.kind,
        limit: 32,
        nameOnly: true,
        ...activeReadScope(),
      });
      if (found.length === 32) return undefined;
      const matches = found.filter(
        (n) => n.name === name && (!opts.path || pathOf(n)?.includes(opts.path)),
      );
      if (matches.length === 1) node = matches[0];
    }
    if (
      node &&
      atRevision(node, rev) &&
      behaviorTarget(node.kind) &&
      (!opts.kind || opts.kind === node.kind) &&
      (!opts.path || pathOf(node)?.includes(opts.path))
    ) {
      return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        path: pathOf(node),
        ...(isRawId(term) && { revisionNode: node }),
        // Historical name search can omit a deleted namesake. Require an explicit
        // identity or an exact path (and containing class for a method).
        identityVerified:
          isRawId(term) ||
          (opts.path === pathOf(node) && !!opts.path && (node.kind !== "method" || !!separator)),
        resolutionMode: "exact" as const,
      };
    }
  } catch {
    /* Normal target resolution can still supply structural context. */
  }
  return undefined;
}

/** A historical projection never sees ContextFacts, a head entity or working-tree data. */
export async function revisionBehavior(
  client: IxClient,
  target: Target,
  context: StructuredContext,
  rev: number | undefined,
  verified: boolean,
  term?: string,
) {
  if (!rev || !behaviorTarget(target.kind)) return undefined;
  const unavailable = unavailableBehavior(target, rev);
  if (!verified || context.metadata?.asOfRev !== rev) return unavailable;
  const edges = context.edges.length ? context.edges : (context.edgeSummaries ?? []);
  const refs = context.nodes.length ? context.nodes : (context.nodeSummaries ?? []);
  if (!refs.some((n) => n.id === target.id && n.kind === target.kind)) return unavailable;
  const separator = term && qualifiedSeparator(term);
  const qualifier = term && separator ? term.slice(0, term.lastIndexOf(separator)) : undefined;
  const parents = qualifier
    ? edges.filter((e) => e.dst === target.id && e.predicate === "CONTAINS").map((e) => e.src)
    : [];
  if (qualifier && parents.length !== 1) return unavailable;
  // A full ID lookup already verified this callable at this revision.
  const leaf = target.kind !== "class" && !qualifier ? target.revisionNode : undefined;
  let nodes = !context.nodes.length && leaf ? [leaf] : context.nodes;
  if (!nodes.length) {
    const memberIds =
      target.kind === "class"
        ? directMembers(target, edges).filter((id) => {
            const n = refs.find((r) => r.id === id);
            return !n || n.kind === "method" || n.kind === "function";
          })
        : [];
    const ids = [target.id, ...memberIds.slice(0, MAX_BEHAVIOR_MEMBERS), ...parents];
    try {
      const snap = await client.historicalNodes(ids, rev);
      if (snap.metadata?.asOfRev !== rev || snap.nodes.some((n) => !ids.includes(n.id)))
        return unavailable;
      nodes = snap.nodes;
    } catch {
      return unavailable;
    }
  }
  if (nodes.some((n) => !atRevision(n, rev))) return unavailable;
  if (
    qualifier &&
    !nodes.some((n) => parents.includes(n.id) && n.kind === "class" && n.name === qualifier)
  )
    return unavailable;
  const node = nodes.find((n) => n.id === target.id);
  if (
    !node ||
    node.kind !== target.kind ||
    node.name !== target.name ||
    (target.path && pathOf(node) !== target.path)
  )
    return unavailable;
  return projectBehavior(node, nodes, edges, rev) ?? unavailable;
}

/** A deleted historical owner has no head facts. Use only returned historical relationships for its counts. */
export function archivedFacts(target: Target, ctx: StructuredContext, rev: number): ContextFacts {
  const edges =
    ctx.metadata?.asOfRev === rev ? (ctx.edges.length ? ctx.edges : (ctx.edgeSummaries ?? [])) : [];
  const members = directMembers(target, edges);
  const incoming = edges.filter((e) => e.dst === target.id);
  const nodes = ctx.metadata?.asOfRev === rev ? ctx.nodes : [];
  const node = nodes.find((n) => n.id === target.id) ?? target.revisionNode;
  const memberRefs = nodes
    .filter((n) => members.includes(n.id))
    .map((n) => ({ id: n.id, name: n.name, kind: n.kind, path: pathOf(n) }));
  const containerId = incoming.find((e) => e.predicate === "CONTAINS")?.src;
  const container = nodes.find((n) => n.id === containerId);
  return {
    id: target.id,
    kind: target.kind,
    name: target.name,
    provenance: node?.provenance,
    path: node ? pathOf(node) : undefined,
    ...(container && {
      container: {
        id: container.id,
        name: container.name,
        kind: container.kind,
        path: pathOf(container),
      },
    }),
    memberRefs,
    members: memberRefs.map((n) => n.name),
    memberCount: members.length,
    callerCount: incoming.filter((e) => e.predicate === "CALLS").length,
    calleeCount: edges.filter((e) => e.src === target.id && e.predicate === "CALLS").length,
    importerCount: incoming.filter((e) => e.predicate === "IMPORTS").length,
    dependentCount: new Set(
      incoming
        .filter((e) => ["REFERENCES", "IMPORTS", "CALLS"].includes(e.predicate))
        .map((e) => e.src),
    ).size,
    topCallers: [],
    topDependents: [],
    stale: false,
    diagnostics: [],
    historyLength: 0,
  };
}
