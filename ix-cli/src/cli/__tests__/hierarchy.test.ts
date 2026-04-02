import { describe, expect, it, vi } from "vitest";
import { getEffectiveSystemPath, hasMapData } from "../hierarchy.js";

describe("getEffectiveSystemPath", () => {
  it("uses the direct system path when it already has map data", async () => {
    const expand = vi.fn().mockResolvedValue({
      nodes: [
        { id: "sys", kind: "system", name: "CLI" },
        { id: "sub", kind: "subsystem", name: "Client" },
      ],
      edges: [],
    });

    const client = { expand } as any;

    const path = await getEffectiveSystemPath(client, "node-1");

    expect(hasMapData(path)).toBe(true);
    expect(path.map((n) => n.kind)).toEqual(["system", "subsystem"]);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("inherits map data from an ancestor file for nested config entries", async () => {
    const expand = vi.fn(async (id: string, opts?: { predicates?: string[] }) => {
      if (id === "common" && opts?.predicates?.[0] === "IN_REGION") {
        return { nodes: [], edges: [] };
      }
      if (id === "common" && opts?.predicates?.[0] === "CONTAINS") {
        return {
          nodes: [
            { id: "lang", kind: "config_entry", name: "nob" },
            { id: "name", kind: "config_entry", name: "name" },
            { id: "file-1", kind: "file", name: "countries.json" },
          ],
          edges: [],
        };
      }
      if (id === "file-1" && opts?.predicates?.[0] === "IN_REGION") {
        return {
          nodes: [
            { id: "sys", kind: "system", name: "Countries" },
            { id: "sub", kind: "subsystem", name: "JSON corpus" },
            { id: "file-1", kind: "file", name: "countries.json" },
          ],
          edges: [],
        };
      }
      return { nodes: [], edges: [] };
    });

    const client = { expand } as any;

    const path = await getEffectiveSystemPath(client, "common");

    expect(hasMapData(path)).toBe(true);
    expect(path.map((n) => n.name)).toEqual(["Countries", "JSON corpus", "countries.json"]);
  });

  it("returns the direct path when no mapped ancestor exists", async () => {
    const expand = vi.fn(async (id: string, opts?: { predicates?: string[] }) => {
      if (id === "leaf" && opts?.predicates?.[0] === "IN_REGION") {
        return { nodes: [], edges: [] };
      }
      if (id === "leaf" && opts?.predicates?.[0] === "CONTAINS") {
        return { nodes: [{ id: "parent", kind: "config_entry", name: "parent" }], edges: [] };
      }
      if (id === "parent" && opts?.predicates?.[0] === "IN_REGION") {
        return { nodes: [], edges: [] };
      }
      return { nodes: [], edges: [] };
    });

    const client = { expand } as any;

    const path = await getEffectiveSystemPath(client, "leaf");

    expect(path).toEqual([]);
    expect(hasMapData(path)).toBe(false);
  });
});
