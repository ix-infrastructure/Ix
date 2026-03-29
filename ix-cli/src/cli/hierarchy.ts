import type { IxClient } from "../client/api.js";

export type SystemPath = Array<{ name: string; kind: string; id?: string }>;

const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);

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

/** Group a set of node IDs by their containing region (IN_REGION). */
export async function bucketByHierarchy(
  client: IxClient,
  nodeIds: string[],
): Promise<Array<{ region: { name: string; kind: string }; members: Array<{ name: string; kind: string }> }>> {
  if (nodeIds.length === 0) return [];

  // For each node, find its immediate region
  const buckets = new Map<string, { region: { name: string; kind: string }; members: Array<{ name: string; kind: string }> }>();

  await Promise.all(
    nodeIds.map(async (nodeId) => {
      try {
        const nodeDetails = await client.entity(nodeId);
        const node = nodeDetails.node as any;
        const memberName = node.name || node.attrs?.name || "(unnamed)";
        const memberKind = node.kind || "unknown";

        const regionResult = await client.expand(nodeId, { direction: "in", predicates: ["IN_REGION"], hops: 1 });
        const regionNodes = regionResult.nodes as Array<{ id: string; name?: string; attrs?: { name?: string }; kind?: string }>;

        // Pick the most specific region (lowest in hierarchy)
        const kindOrder: Record<string, number> = { file: 0, module: 1, region: 1, subsystem: 2, system: 3 };
        const region = regionNodes.sort((a, b) => (kindOrder[(a as any).kind ?? ""] ?? 4) - (kindOrder[(b as any).kind ?? ""] ?? 4))[0];

        if (region) {
          const regionName = (region as any).name || region.attrs?.name || "(unnamed)";
          const regionKind = (region as any).kind || "region";
          const key = region.id;
          if (!buckets.has(key)) {
            buckets.set(key, { region: { name: regionName, kind: regionKind }, members: [] });
          }
          buckets.get(key)!.members.push({ name: memberName, kind: memberKind });
        }
      } catch {
        /* skip nodes that can't be expanded */
      }
    }),
  );

  return [...buckets.values()];
}
