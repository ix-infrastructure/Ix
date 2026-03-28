import type { IxClient } from "../../client/api.js";
import type { EntityRef, Diagnostic } from "../format.js";
import { relativePath } from "../format.js";
import { isRawId } from "../resolve.js";
import { isFileStale } from "../stale.js";
import { buildDependencyTree } from "../commands/depends.js";
import { getSystemPath } from "../hierarchy.js";

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

export async function collectFacts(
  client: IxClient,
  targetId: string,
  targetName: string,
  targetKind: string,
): Promise<EntityFacts> {
  const diagnostics: Diagnostic[] = [];

  // Run parallel graph queries (including bounded downstream tree)
  const [details, callersResult, calleesResult, dependentsResult, importersResult, membersResult, provenance, downstream, hierarchyPath] =
    await Promise.all([
      client.entity(targetId),
      client.expand(targetId, { direction: "in", predicates: ["CALLS"] }),
      client.expand(targetId, { direction: "out", predicates: ["CALLS"] }),
      client.expand(targetId, { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] }),
      client.expand(targetId, { direction: "in", predicates: ["IMPORTS"] }),
      client.expand(targetId, { direction: "out", predicates: ["CONTAINS"] }),
      client.provenance(targetId).catch(() => ({ entityId: targetId, chain: [] })),
      buildDependencyTree(client, targetId, { maxDepth: 4, maxNodes: 100 }).catch(() => ({
        tree: [], truncated: false, nodesVisited: 0, maxDepthReached: 0,
      })),
      getSystemPath(client, targetId).catch(() => []),
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

  // Members
  const memberNames = membersResult.nodes.map(
    (n: any) => n.name || n.attrs?.name || "(unnamed)",
  );

  // Named usage examples (up to 3 resolved names from callers/dependents)
  const extractNames = (nodes: any[], limit: number): string[] => {
    const names: string[] = [];
    for (const n of nodes) {
      if (names.length >= limit) break;
      const name = n.name || n.attrs?.name || "";
      if (name && !isRawId(name)) names.push(name);
    }
    return names;
  };
  const topCallers = extractNames(callersResult.nodes, 3);
  const topDependents = extractNames(uniqueDependents, 3);

  // Build callList from outgoing CALLS edges (reuse logic from explain.ts)
  const calleeEdges = edges.filter(
    (e: any) => e.predicate === "CALLS" && e.src === targetId,
  );
  let callList: EntityRef[] | undefined;
  if (calleeEdges.length > 0 && calleeEdges.length <= 20) {
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
      stale = await isFileStale(client, path);
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

  return {
    id: targetId,
    name: node.name || node.attrs?.name || targetName,
    kind: node.kind || targetKind,
    path,
    signature,
    docstring,
    container,
    members: memberNames,
    memberCount: membersResult.nodes.length,
    callerCount: callersResult.nodes.length,
    calleeCount: calleesResult.nodes.length,
    dependentCount: uniqueDependents.length,
    importerCount: importersResult.nodes.length,
    downstreamDependents: downstream.nodesVisited,
    downstreamDepth: downstream.maxDepthReached,
    topCallers,
    topDependents,
    introducedRev: node.createdRev ?? node.created_rev,
    historyLength: history?.chain?.length ?? 0,
    callList,
    systemPath: systemPathMapped,
    subsystemName,
    moduleName,
    stale,
    diagnostics,
  };
}
