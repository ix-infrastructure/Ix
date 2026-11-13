// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerRankCommand } from "../commands/rank.js";

const { listByKind, expand } = vi.hoisted(() => ({ listByKind: vi.fn(), expand: vi.fn() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async listByKind(...args: unknown[]) { return listByKind(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
  },
}));
vi.mock("../resolve.js", () => ({
  ensureReadScope: async () => {},
  activeReadScope: () => ({ workspaceId: "test-workspace" }),
}));

async function run(args: string[]) {
  const program = new Command().name("ix").exitOverride();
  registerRankCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
  await program.parseAsync(["rank", "--by", "members", "--kind", "class", "--format", "json", ...args], { from: "user" });
  return JSON.parse(output.join("\n"));
}

describe("rank path filtering before the candidate limit", () => {
  beforeEach(() => {
    const nodes = [
      ...Array.from({ length: 2000 }, (_, i) => ({ id: `other-${i}`, name: `Other${i}`, kind: "class", provenance: { sourceUri: "src/other.ts" } })),
      { id: "wanted", name: "Wanted", kind: "class", provenance: { sourceUri: "src/target.ts" } },
    ];
    listByKind.mockReset().mockImplementation(async (_kind, opts) =>
      nodes.filter(n => !opts.scope || n.provenance.sourceUri.includes(opts.scope)).slice(0, opts.limit),
    );
    expand.mockReset().mockResolvedValue({ nodes: [{ id: "member" }], edges: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("ranks a matching entity beyond the first 2000 unfiltered candidates", async () => {
    const output = await run(["--path", "src/target.ts"]);
    expect(listByKind).toHaveBeenCalledWith("class", { limit: 2001, scope: "src/target.ts", workspaceId: "test-workspace" });
    expect(output.results).toEqual([{ name: "Wanted", kind: "class", score: 1 }]);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("wanted", expect.anything());
  });

  it("preserves client-side exclusions after the scoped fetch", async () => {
    const output = await run(["--path", "src/target.ts", "--exclude-path", "target"]);
    expect(output.results).toEqual([]);
    expect(expand).not.toHaveBeenCalled();
  });

  it("reports a genuinely unmatched path without expanding unrelated entities", async () => {
    const output = await run(["--path", "missing.ts"]);
    expect(output.results).toEqual([]);
    expect(expand).not.toHaveBeenCalled();
  });
});

describe("rank scoring order", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scores every candidate once and reports in candidate order, however the expands finish", async () => {
    const nodes = Array.from({ length: 45 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, kind: "class", provenance: { sourceUri: "src/x.ts" } }));
    listByKind.mockReset().mockResolvedValue(nodes);
    let inFlight = 0;
    let peak = 0;
    expand.mockReset().mockImplementation(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const i = Number(id.slice(1));
      // Later candidates answer first; every fifth one fails.
      await new Promise((resolve) => setTimeout(resolve, (45 - i) % 7));
      inFlight--;
      if (i % 5 === 0) throw new Error("down");
      // Score i % 4, with a duplicate id that must count once.
      const members = Array.from({ length: i % 4 }, (_, k) => ({ id: `m${k}` }));
      return { nodes: [...members, ...members.slice(0, 1)], edges: [] };
    });

    const output = await run(["--top", "45"]);

    expect(expand).toHaveBeenCalledTimes(45);
    expect(peak).toBeLessThanOrEqual(20);
    // A stable sort of scores computed in candidate order: ties keep that order.
    const expected = nodes
      .map((n, i) => ({ name: n.name, kind: "class", score: i % 5 === 0 ? 0 : i % 4 }))
      .sort((a, b) => b.score - a.score);
    expect(output.results).toEqual(expected);
    expect(output.diagnostics).toEqual(
      nodes.filter((_, i) => i % 5 === 0).map((n) => `Failed to expand entity ${n.id}`),
    );
  });
});
