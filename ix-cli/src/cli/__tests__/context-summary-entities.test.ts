// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import type { NodeSummary } from "../../client/types.js";
import { buildBundle, clampBudgets } from "../commands/context.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";

/**
 * Entities that reach a bundle through the backend's node summaries.
 *
 * Backends up to at least 1.0.30 summarize a file's members with the FILE's
 * name and no path. A recorded `ix context watch.ts` bundle carried twelve
 * entities all named `watch.ts`: members past the leading ten, which the facts
 * collector had located correctly, arrived first through the summaries and the
 * located refs were then skipped as already seen.
 */

const FILE = "src/cli/commands/watch.ts";

function member(i: number): EntityLocation {
  return { id: `m-${i}`, name: `member${i}`, kind: "function", path: FILE, lineStart: i * 10, lineEnd: i * 10 + 5 };
}

function facts(memberRefs: EntityLocation[], importRefs: EntityLocation[] = []): ContextFacts {
  return {
    id: "f-watch", name: "watch.ts", kind: "file", path: FILE,
    members: memberRefs.map((m) => m.name), memberRefs, memberCount: memberRefs.length,
    importRefs,
    callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [],
    historyLength: 1, introducedRev: 1, stale: false, diagnostics: [],
  };
}

function bundle(f: ContextFacts, nodeSummaries: NodeSummary[]) {
  return buildBundle({
    resolved: { id: "f-watch", name: "watch.ts", kind: "file", resolutionMode: "exact" },
    facts: f,
    context: {
      claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
      nodeSummaries, edgeSummaries: [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {},
    budgets: clampBudgets({}),
    isStale: () => false,
  });
}

/** A summary as the defective backends send it: the file's name, no path. */
const misnamed = (id: string, kind = "function"): NodeSummary =>
  ({ id, kind, name: "watch.ts", rev: 5, sourceUri: null });

describe("entities from backend node summaries", () => {
  it("uses the located member rather than the backend's misnamed summary of it", () => {
    const members = Array.from({ length: 14 }, (_, i) => member(i));
    const b = bundle(facts(members), [
      { id: "f-watch", kind: "file", name: "watch.ts", rev: 5, sourceUri: null },
      misnamed("m-12"),
      misnamed("m-13", "constant"),
    ]);

    const named = b.entities.filter((e) => e.id === "m-12" || e.id === "m-13");
    expect(named.map((e) => [e.name, e.path]).sort()).toEqual([["member12", FILE], ["member13", FILE]]);
    expect(b.entities.filter((e) => e.name === "watch.ts")).toHaveLength(1);
  });

  it("drops a misnamed summary it has no located ref for", () => {
    const b = bundle(facts([member(0)]), [misnamed("orphan")]);
    expect(b.entities.map((e) => e.id)).not.toContain("orphan");
  });

  it("keeps a path-less symbol whose name is not a file's", () => {
    const b = bundle(facts([member(0)]), [{ id: "s-1", kind: "method", name: "Map.get", rev: 5 }]);
    expect(b.entities.find((e) => e.id === "s-1")?.name).toBe("Map.get");
  });

  it("does not locate an imported package in the file that imports it", () => {
    const chalk: EntityLocation = { id: "mod-chalk", name: "chalk", kind: "module", path: FILE };
    const b = bundle(facts([member(0)], [chalk]), [
      { id: "mod-fs", kind: "module", name: "node:fs", rev: 5, path: FILE },
    ]);

    const modules = b.entities.filter((e) => e.kind === "module");
    expect(modules.map((e) => e.name).sort()).toEqual(["chalk", "node:fs"]);
    for (const m of modules) expect(m.path).toBeUndefined();
  });
});
