// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../client/api.js";
import { rowLocation, stripNulls } from "./format.js";

export type SystemPath = Array<{ name: string; kind: string; id?: string }>;

const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);
const FILE_KINDS = new Set(["file"]);

/** Traverse IN_REGION edges upward to build the system-hierarchy path for a node. */
export async function getSystemPath(client: IxClient, nodeId: string): Promise<SystemPath> {
  try {
    const result = await client.expand(nodeId, { direction: "in", predicates: ["IN_REGION"], hops: 5 });
    const nodes = result.nodes as Array<{ id: string; name?: string; attrs?: { name?: string }; kind?: string }>;
    if (nodes.length === 0) return [];
    // Sort by region kind: system > subsystem > module > region > file
    const kindOrder: Record<string, number> = { system: 0, subsystem: 1, module: 2, region: 3, file: 4 };
    const sorted = [...nodes].sort((a, b) => {
      const aK = a.kind ?? "";
      const bK = b.kind ?? "";
      return (kindOrder[aK] ?? 5) - (kindOrder[bK] ?? 5);
    });
    return sorted.map((n) => ({
      id: n.id,
      name: (n as any).name || n.attrs?.name || "(unnamed)",
      kind: (n as any).kind || "region",
    }));
  } catch {
    return [];
  }
}

/** Format a system path as "A > B > C". */
export function formatSystemPath(path: SystemPath): string {
  return path.map((n) => n.name).join(" > ");
}

/** Returns true if the path contains at least one region/system node (i.e. map data exists). */
export function hasMapData(path: SystemPath): boolean {
  return path.some((n) => REGION_KINDS.has(n.kind));
}

/**
 * Return the best system path available for a node.
 * Some nested entities do not carry IN_REGION edges directly and must inherit
 * map context from a containing ancestor, typically the enclosing file.
 */
export async function getEffectiveSystemPath(
  client: IxClient,
  nodeId: string,
  opts?: { maxContainsHops?: number }
): Promise<SystemPath> {
  const directPath = await getSystemPath(client, nodeId);
  if (hasMapData(directPath)) return directPath;

  const maxContainsHops = opts?.maxContainsHops ?? 8;
  const visited = new Set<string>([nodeId]);
  let frontier: Array<{ id: string; kind?: string }> = [{ id: nodeId }];

  for (let depth = 0; depth < maxContainsHops; depth += 1) {
    const nextLevel: Array<{ id: string; kind?: string }> = [];

    for (const current of frontier) {
      try {
        const result = await client.expand(current.id, {
          direction: "in",
          predicates: ["CONTAINS"],
          hops: 1,
        });

        const parents = (result.nodes as Array<{ id: string; kind?: string }>).filter(
          (node) => node?.id && !visited.has(node.id)
        );

        const prioritized = [...parents].sort((a, b) => {
          const aRank = FILE_KINDS.has(a.kind ?? "") ? 0 : 1;
          const bRank = FILE_KINDS.has(b.kind ?? "") ? 0 : 1;
          return aRank - bRank;
        });

        for (const parent of prioritized) {
          visited.add(parent.id);
          const parentPath = await getSystemPath(client, parent.id);
          if (hasMapData(parentPath)) return parentPath;
          nextLevel.push(parent);
        }
      } catch {
        // Ignore lookup failures and keep climbing through any remaining nodes.
      }
    }

    if (nextLevel.length === 0) break;
    frontier = nextLevel;
  }

  return directPath;
}

/** A node to bucket: its id, or the node itself when the caller already holds it. */
export type BucketInput = string | { id: string; name?: string; kind?: string; attrs?: { name?: string } };

/** A bucketed node: its name and kind, and where it is when the node says. */
export type BucketMember = { name: string; kind: string; path?: string; lineStart?: number; lineEnd?: number };

/**
 * Group a set of nodes by their containing region (IN_REGION).
 *
 * A caller that already holds the nodes -- every caller does: they come from
 * an expand -- passes them rather than their ids, and the entity read per
 * node, which only fetched the name and kind the caller already had, is
 * skipped. On `ix impact IxClient` that was 69 of the command's 166 requests.
 *
 * Buckets, and the members in each, are in input order. They used to be in
 * the order the lookups finished, so the same graph printed differently from
 * one run to the next.
 *
 * Each member carries the node's location (`rowLocation`), read off the node
 * already in hand: no request is made for it.
 */
export async function bucketByHierarchy(
  client: IxClient,
  nodes: BucketInput[],
): Promise<Array<{ region: { name: string; kind: string }; members: BucketMember[] }>> {
  if (nodes.length === 0) return [];

  // For each node, find its immediate region
  const kindOrder: Record<string, number> = { file: 0, module: 1, region: 1, subsystem: 2, system: 3 };
  const placed = await Promise.all(
    nodes.map(async (input) => {
      const nodeId = typeof input === "string" ? input : input.id;
      try {
        const node = typeof input === "string" || !input.kind
          ? ((await client.entity(nodeId)).node as any)
          : input;
        const memberName = node.name || node.attrs?.name || "(unnamed)";
        const memberKind = node.kind || "unknown";

        const regionResult = await client.expand(nodeId, { direction: "in", predicates: ["IN_REGION"], hops: 1 });
        const regionNodes = regionResult.nodes as Array<{ id: string; name?: string; attrs?: { name?: string }; kind?: string }>;

        // Pick the most specific region (lowest in hierarchy)
        const region = regionNodes.sort((a, b) => (kindOrder[(a as any).kind ?? ""] ?? 4) - (kindOrder[(b as any).kind ?? ""] ?? 4))[0];
        if (!region) return undefined;
        return {
          key: region.id,
          region: { name: (region as any).name || region.attrs?.name || "(unnamed)", kind: (region as any).kind || "region" },
          member: { name: memberName, kind: memberKind, ...stripNulls(rowLocation(node)) } as BucketMember,
        };
      } catch {
        return undefined; /* skip nodes that can't be expanded */
      }
    }),
  );

  const buckets = new Map<string, { region: { name: string; kind: string }; members: BucketMember[] }>();
  for (const p of placed) {
    if (!p) continue;
    if (!buckets.has(p.key)) buckets.set(p.key, { region: p.region, members: [] });
    buckets.get(p.key)!.members.push(p.member);
  }
  return [...buckets.values()];
}
