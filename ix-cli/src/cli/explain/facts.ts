// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../../client/api.js";
import type { EntityRef, Diagnostic } from "../format.js";
import { relativePath } from "../format.js";
import { isRawId } from "../resolve.js";
import { isFileStale } from "../stale.js";
import { buildDependencyTree } from "../commands/depends.js";
import { getSystemPath } from "../hierarchy.js";

/** A related entity and where it is defined. */
export interface EntityLocation {
  id: string;
  name: string;
  kind: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  /**
   * Distinct entities with an inbound CALLS, REFERENCES or IMPORTS edge, capped
   * at `MEMBER_USE_CAP`. Only measured for members, and only by `ix context`.
   */
  usedBy?: number;
  /** How many of those live in a different file. */
  usedFromFiles?: number;
}

export interface EntityFacts {
  // Identity
  id: string;
  name: string;
  kind: string;
  path?: string;
  signature?: string;
  docstring?: string;

  // Structural context
  container?: { kind: string; name: string };
  members: string[];
  /** The same members with their locations, in the same order as `members`. */
  memberRefs?: EntityLocation[];
  memberCount: number;

  // Relationship counts
  callerCount: number;
  calleeCount: number;
  dependentCount: number;
  importerCount: number;

  // Transitive downstream (via dependency tree)
  downstreamDependents: number;
  downstreamDepth: number;

  // Named usage examples (up to 3 each)
  topCallers: string[];
  topDependents: string[];
  /** The entities behind `topCallers` / `topDependents`, same order. */
  topCallerRefs?: EntityLocation[];
  topDependentRefs?: EntityLocation[];

  /**
   * What the target itself reaches: the files it imports and the functions it
   * calls. Everything else here points *inward* -- what contains the target,
   * what calls it, what it defines -- and an agent starting from a command or
   * an entry point has to go the other way to find an implementation.
   */
  importRefs?: EntityLocation[];
  calleeRefs?: EntityLocation[];

  /**
   * What the neighbouring files define. Members are otherwise collected for the
   * target alone, so a bundle answered "which function does X" with a file name
   * and nothing in it: measured over 11 benchmark tasks, symbol recall was 0.00
   * on 10 of them even where the right file was returned.
   */
  neighbourRefs?: EntityLocation[];

  // History
  introducedRev?: number;
  historyLength: number;

  // Call details
  callList?: EntityRef[];

  // Hierarchy (scene graph)
  systemPath?: Array<{ name: string; kind: string }>;
  subsystemName?: string;
  moduleName?: string;

  // Staleness
  stale: boolean;

  // Diagnostics
  diagnostics: Diagnostic[];
}

/** Facts only `ix explain` renders. */
type ExplainOnlyFact =
  | "downstreamDependents"
  | "downstreamDepth"
  | "callList"
  | "systemPath"
  | "subsystemName"
  | "moduleName";

/**
 * The facts `ix context` reads. The explain-only ones are absent from the type
 * rather than zeroed, so nothing can render a skipped fact as a real count.
 * `provenance` is the raw `/v1/provenance` response the history length was
 * read from, handed on so the caller does not fetch it a second time.
 */
export type ContextFacts = Omit<EntityFacts, ExplainOnlyFact> & { provenance?: unknown };

const NO_DOWNSTREAM = { tree: [], truncated: false, nodesVisited: 0, maxDepthReached: 0 };

/** Neighbouring files opened one level deep, and how many of each one's members are kept. */
const MAX_NEIGHBOUR_FILES = 5;
const MAX_NEIGHBOUR_MEMBERS = 4;
/** Members of a neighbour whose use is measured before the best are kept. */
const NEIGHBOUR_USE_POOL = 8;

/** Outbound facts kept: enough to navigate by, few enough to leave room for the rest. */
const MAX_IMPORT_REFS = 12;
const MAX_CALLEE_REFS = 4;

/** Members probed for usage; the rest keep their structural order after them. */
const MEMBER_USE_POOL = 40;
/** Inbound edges read per member. Enough to rank by; a hub is a hub at 50. */
const MEMBER_USE_CAP = 50;
const MEMBER_USE_CONCURRENCY = 6;
const USE_PREDICATES = ["CALLS", "REFERENCES", "IMPORTS"];

/** Kinds whose own members are worth one more hop: a class's methods are not
 * listed under its file. */
const CONTAINER_KINDS = new Set(["class", "interface", "trait", "object", "struct", "enum"]);

/** Kinds a reader navigates by. Everything else ranks after them. */
const PRIMARY_MEMBER_KINDS = new Set([
  "class", "interface", "function", "method", "type", "enum", "trait", "struct", "object", "module",
]);

function lineOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function toLocation(n: any): EntityLocation {
  const kind = n.kind || "unknown";
  // A file's line span is the whole file, which says nothing a path does not.
  const lines = kind === "file" ? {} : { lineStart: lineOf(n.attrs?.line_start), lineEnd: lineOf(n.attrs?.line_end) };
  return {
    id: n.id,
    name: n.name || n.attrs?.name || "(unnamed)",
    kind,
    path: relativePath(n.provenance?.sourceUri ?? n.provenance?.source_uri),
    ...lines,
  };
}

/**
 * Order members so the ones a reader needs survive the cut.
 *
 * `ix context` shows the first ten members, and the backend returns them in no
 * particular order. On `config.ts` in the Ix repo that dropped
 * `resolveWorkspaceRoot` -- 13 callers, the function the file exists for --
 * while showing `real`, a two-line helper.
 *
 * Usage is measured, not guessed: one bounded inbound expand per member, for at
 * most `MEMBER_USE_POOL` of them, chosen by kind and then by size. Members used
 * from other files rank first, then by total uses; ties keep the structural
 * order, which is itself deterministic.
 */
/** Members a reader navigates by first: declaration kinds, then the big ones.
 * Deterministic, and costs nothing -- unlike the usage ranking, which pays an
 * expand per member and is reserved for the target's own. */
function structuralMemberOrder(members: EntityLocation[]): EntityLocation[] {
  const span = (m: EntityLocation) =>
    m.lineStart !== undefined && m.lineEnd !== undefined ? m.lineEnd - m.lineStart : 0;
  return members
    .map((m, index) => ({ m, index }))
    .sort((a, b) =>
      Number(!PRIMARY_MEMBER_KINDS.has(a.m.kind)) - Number(!PRIMARY_MEMBER_KINDS.has(b.m.kind)) ||
      span(b.m) - span(a.m) ||
      (a.m.name < b.m.name ? -1 : a.m.name > b.m.name ? 1 : 0) ||
      a.index - b.index)
    .map(({ m }) => m);
}

/**
 * What the files around the target define.
 *
 * One `CONTAINS` expand per neighbouring file, for at most
 * `MAX_NEIGHBOUR_FILES` of them, keeping `MAX_NEIGHBOUR_MEMBERS` each in
 * structural order. Bounded on purpose: this is the hop that turns "the answer
 * is in config.ts" into "resolveWorkspaceRoot, config.ts:322".
 */
async function collectNeighbourMembers(
  client: IxClient, neighbours: EntityLocation[], targetId: string,
): Promise<EntityLocation[]> {
  const files = neighbours
    .filter(ref => ref.kind === "file" && ref.id !== targetId)
    .slice(0, MAX_NEIGHBOUR_FILES);
  const found: EntityLocation[][] = [];
  for (const file of files) {  // one file at a time: each ranks its own members
    try {
      const result = await client.expand(file.id, { direction: "out", predicates: ["CONTAINS"] });
      const direct = structuralMemberOrder((result.nodes ?? [])
        .filter((n: any) => n?.id && n.id !== file.id)
        .map(toLocation));
      // A class's methods hang off the class, not the file: `api.ts` contains
      // `IxClient`, and `reset`, `resetCode` and `deleteWorkspace` -- three of
      // one task's four answers -- hang off that. One level down, for the
      // leading container only.
      const container = direct.find(m => CONTAINER_KINDS.has(m.kind));
      let nested: EntityLocation[] = [];
      if (container) {
        try {
          const inner = await client.expand(container.id, { direction: "out", predicates: ["CONTAINS"] });
          nested = structuralMemberOrder((inner.nodes ?? [])
            .filter((n: any) => n?.id && n.id !== container.id)
            .map(toLocation));
        } catch {
          nested = [];
        }
      }
      const candidates = [...direct, ...nested].slice(0, NEIGHBOUR_USE_POOL);
      // Ranked by measured use, like the target's own members: by size alone
      // `config.ts` offered `saveConfig` (48 lines, 5 users) ahead of
      // `resolveWorkspaceRoot` (20 lines, 12 users, and the answer).
      found.push((await rankMembersByUse(client, candidates)).slice(0, MAX_NEIGHBOUR_MEMBERS));
    } catch {
      found.push([]);  // one unreadable neighbour must not lose the others
    }
  }
  // One member from each file before a second from any: the evidence budget cut
  // the tail, and four members of the first import crowded out every other
  // file's -- including the one holding the answer.
  const interleaved: EntityLocation[] = [];
  for (let rank = 0; rank < MAX_NEIGHBOUR_MEMBERS; rank++) {
    for (const members of found) {
      if (members[rank]) interleaved.push(members[rank]);
    }
  }
  return interleaved;
}

async function rankMembersByUse(client: IxClient, members: EntityLocation[]): Promise<EntityLocation[]> {
  const structural = structuralMemberOrder(members);

  const pool = structural.slice(0, MEMBER_USE_POOL);
  const measured: EntityLocation[] = new Array(pool.length);
  let next = 0;
  const worker = async () => {
    while (next < pool.length) {
      const index = next++;
      const member = pool[index];
      try {
        const result = await client.expand(member.id, {
          direction: "in", predicates: USE_PREDICATES, limit: MEMBER_USE_CAP,
        });
        const users = new Map<string, string | undefined>();
        for (const n of result.nodes ?? []) {
          if (n?.id && n.id !== member.id) users.set(n.id, relativePath(n.provenance?.sourceUri ?? n.provenance?.source_uri));
        }
        const files = new Set([...users.values()].filter((p) => p && p !== member.path));
        measured[index] = { ...member, usedBy: users.size, usedFromFiles: files.size };
      } catch {
        // Unmeasured, not zero: it keeps its structural place below.
        measured[index] = member;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEMBER_USE_CONCURRENCY, pool.length) }, worker));

  const ranked = measured
    .map((m, index) => ({ m, index }))
    .sort((a, b) =>
      (b.m.usedFromFiles ?? -1) - (a.m.usedFromFiles ?? -1) ||
      (b.m.usedBy ?? -1) - (a.m.usedBy ?? -1) ||
      a.index - b.index)
    .map(({ m }) => m);
  return [...ranked, ...structural.slice(MEMBER_USE_POOL)];
}

/**
 * Collect the structural facts about one entity.
 *
 * `scope` exists because the explain-only facts are by far the most expensive.
 * The downstream dependency tree walks up to 100 nodes with five expands each:
 * measured on `ix context config.ts` against the Ix repo's own graph, 230 of
 * the command's 246 HTTP requests and ~6 of its ~10 seconds, for two numbers
 * `ix context` never reads. `"context"` skips that tree, the system path and
 * the per-callee lookups.
 */
export function collectFacts(
  client: IxClient,
  targetId: string,
  targetName: string,
  targetKind: string,
): Promise<EntityFacts>;
export function collectFacts(
  client: IxClient,
  targetId: string,
  targetName: string,
  targetKind: string,
  scope: "context",
): Promise<ContextFacts>;
export async function collectFacts(
  client: IxClient,
  targetId: string,
  targetName: string,
  targetKind: string,
  scope: "explain" | "context" = "explain",
): Promise<EntityFacts | ContextFacts> {
  const diagnostics: Diagnostic[] = [];
  const forExplain = scope === "explain";

  // Run parallel graph queries (including, for explain, a bounded downstream tree)
  const [details, callersResult, calleesResult, importsResult, dependentsResult, importersResult, membersResult, provenance, downstream, hierarchyPath] =
    await Promise.all([
      client.entity(targetId),
      client.expand(targetId, { direction: "in", predicates: ["CALLS"] }),
      client.expand(targetId, { direction: "out", predicates: ["CALLS"] }),
      client.expand(targetId, { direction: "out", predicates: ["IMPORTS"] }),
      client.expand(targetId, { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] }),
      client.expand(targetId, { direction: "in", predicates: ["IMPORTS"] }),
      client.expand(targetId, { direction: "out", predicates: ["CONTAINS"] }),
      client.provenance(targetId).catch(() => ({ entityId: targetId, chain: [] })),
      forExplain
        ? buildDependencyTree(client, targetId, { maxDepth: 4, maxNodes: 100 }).catch(() => NO_DOWNSTREAM)
        : Promise.resolve(NO_DOWNSTREAM),
      forExplain ? getSystemPath(client, targetId).catch(() => []) : Promise.resolve([]),
    ]);

  const node = details.node as any;
  const edges = (details.edges ?? []) as any[];

  // Extract path
  const path = relativePath(node.provenance?.source_uri ?? node.provenance?.sourceUri) ?? undefined;

  // Extract container from CONTAINS edge (where this entity is the dst)
  const containsEdge = edges.find(
    (e: any) => e.predicate === "CONTAINS" && e.dst === targetId,
  );
  let container: { kind: string; name: string } | undefined;
  if (containsEdge) {
    try {
      const containerDetails = await client.entity(containsEdge.src);
      const cNode = containerDetails.node as any;
      container = {
        kind: cNode.kind || "unknown",
        name: cNode.name || cNode.attrs?.name || "(unknown)",
      };
    } catch {
      /* no container */
    }
  }

  // Deduplicate dependents by node ID
  const seenIds = new Set<string>();
  const uniqueDependents = dependentsResult.nodes.filter((n: any) => {
    if (seenIds.has(n.id)) return false;
    seenIds.add(n.id);
    return true;
  });

  // Members. `ix context` ranks them by use; `ix explain` keeps graph order.
  const memberRefs = forExplain
    ? membersResult.nodes.map(toLocation)
    : await rankMembersByUse(client, membersResult.nodes.map(toLocation));
  const memberNames = memberRefs.map((m) => m.name);

  // Named usage examples (up to 3 resolved names from callers/dependents)
  const extractRefs = (nodes: any[], limit: number): EntityLocation[] => {
    const refs: EntityLocation[] = [];
    for (const n of nodes) {
      if (refs.length >= limit) break;
      const name = n.name || n.attrs?.name || "";
      if (name && !isRawId(name)) refs.push(toLocation(n));
    }
    return refs;
  };
  const topCallerRefs = extractRefs(callersResult.nodes, 3);
  const topDependentRefs = extractRefs(uniqueDependents, 3);
  // Where the target leads. Self-edges are dropped: a file that imports its own
  // directory index resolves back to itself and says nothing.
  const outward = (nodes: any[], limit: number): EntityLocation[] =>
    extractRefs(nodes.filter((n: any) => n?.id !== targetId), limit);
  // Repository files first. `ingest.ts` imports 26 modules, a third of them
  // packages (`node:os`, `chalk`) that no question is ever answered in, and in
  // graph order they pushed `supported-extensions.ts` -- the answer to "which
  // extensions does the walker use" -- past the cut. An external package is a
  // `module` node; its provenance names the file that imports it, not the
  // package, so the path cannot be used to tell the two apart.
  const importRefs = outward(
    [...importsResult.nodes].sort((a: any, b: any) =>
      Number(a?.kind !== "file") - Number(b?.kind !== "file")),
    MAX_IMPORT_REFS);
  const calleeRefs = outward(calleesResult.nodes, MAX_CALLEE_REFS);
  // One level into the files around the target -- imports first, then the
  // files that import it. `ix explain` describes one entity and does not need
  // it, so it is not paid for there.
  const neighbourRefs = forExplain
    ? undefined
    : await collectNeighbourMembers(client, [...importRefs, ...topDependentRefs], targetId);
  const topCallers = topCallerRefs.map((r) => r.name);
  const topDependents = topDependentRefs.map((r) => r.name);

  // Build callList from outgoing CALLS edges (reuse logic from explain.ts)
  const calleeEdges = edges.filter(
    (e: any) => e.predicate === "CALLS" && e.src === targetId,
  );
  let callList: EntityRef[] | undefined;
  if (forExplain && calleeEdges.length > 0 && calleeEdges.length <= 20) {
    const refs = await Promise.all(
      calleeEdges.map(async (e: any): Promise<EntityRef> => {
        try {
          const callee = await client.entity(e.dst);
          const calleeNode = callee.node as any;
          const name = calleeNode.name || calleeNode.attrs?.name || "";
          if (!name || isRawId(name)) {
            return {
              name: name || e.dst,
              kind: calleeNode.kind,
              resolved: false,
              suggestedCommand: `ix text "${e.dst.slice(0, 8)}"`,
            };
          }
          return {
            name,
            kind: calleeNode.kind,
            id: e.dst,
            resolved: true,
            path: relativePath(calleeNode.provenance?.source_uri ?? calleeNode.provenance?.sourceUri),
            suggestedCommand: `ix explain "${name}"`,
          };
        } catch {
          return {
            name: e.dst,
            resolved: false,
            diagnostic: "unresolved_call_target",
            suggestedCommand: `ix text "${e.dst.slice(0, 8)}"`,
          } as EntityRef;
        }
      }),
    );
    callList = refs;
    const unresolvedCount = refs.filter((r) => !r.resolved).length;
    if (unresolvedCount > 0) {
      diagnostics.push({
        code: "unresolved_call_target",
        message: `${unresolvedCount} callee(s) could not be resolved to named entities.`,
      });
    }
  }

  // Staleness
  let stale = false;
  if (path) {
    try {
      stale = isFileStale(path);
    } catch {
      /* ignore */
    }
  }
  if (stale) {
    diagnostics.push({
      code: "stale_source",
      message: "Results may be stale; file has changed since last ingest.",
    });
  }

  const signature = node.attrs?.signature || node.attrs?.summary || undefined;
  const docstring = node.attrs?.docstring || node.attrs?.description || undefined;
  const history = provenance as any;

  // Extract hierarchy info
  const systemPathMapped = hierarchyPath.length > 0
    ? hierarchyPath.map((n: any) => ({ name: n.name, kind: n.kind }))
    : undefined;
  const subsystemName = hierarchyPath.find((n: any) => n.kind === "subsystem")?.name;
  const moduleName = hierarchyPath.find((n: any) => n.kind === "module")?.name;

  const facts: EntityFacts = {
    id: targetId,
    name: node.name || node.attrs?.name || targetName,
    kind: node.kind || targetKind,
    path,
    signature,
    docstring,
    container,
    members: memberNames,
    memberRefs,
    memberCount: membersResult.nodes.length,
    callerCount: callersResult.nodes.length,
    calleeCount: calleesResult.nodes.length,
    dependentCount: uniqueDependents.length,
    importerCount: importersResult.nodes.length,
    downstreamDependents: downstream.nodesVisited,
    downstreamDepth: downstream.maxDepthReached,
    topCallers,
    topDependents,
    topCallerRefs,
    topDependentRefs,
    importRefs,
    calleeRefs,
    neighbourRefs,
    introducedRev: node.createdRev ?? node.created_rev,
    historyLength: history?.chain?.length ?? 0,
    callList,
    systemPath: systemPathMapped,
    subsystemName,
    moduleName,
    stale,
    diagnostics,
  };
  if (forExplain) return facts;
  const {
    downstreamDependents: _downstreamDependents,
    downstreamDepth: _downstreamDepth,
    callList: _callList,
    systemPath: _systemPath,
    subsystemName: _subsystemName,
    moduleName: _moduleName,
    ...contextFacts
  } = facts;
  return { ...contextFacts, provenance };
}
