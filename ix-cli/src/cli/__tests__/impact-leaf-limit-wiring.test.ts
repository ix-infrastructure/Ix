// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerImpactCommand } from "../commands/impact.js";

/**
 * `--limit` has to reach the leaf llm branch through the command, not only
 * through the helpers: 25 callers with `--limit 3` print three caller rows and
 * the true totals. json keeps every caller.
 */

const { expand } = vi.hoisted(() => ({ expand: vi.fn() }));

vi.mock("../../client/factory.js", () => ({
  createClient: () => ({ expand: (...args: unknown[]) => expand(...args) }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: async () => ({ id: "11111111-0000-0000-0000-000000000000", kind: "function", name: "verify", resolutionMode: "exact" }),
  printResolved: () => {},
}));
vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: async () => ({ status: "healthy" }),
}));
vi.mock("../hierarchy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hierarchy.js")>(),
  getSystemPath: async () => [],
  bucketByHierarchy: async () => [],
}));

const callers = Array.from({ length: 25 }, (_, i) => ({
  id: `c${i}`, kind: "function", name: `caller${String(i).padStart(2, "0")}`, attrs: { path: "src/a.ts", line_start: i + 1, line_end: i + 1 },
}));

async function run(args: string[]): Promise<string[]> {
  const program = new Command().name("ix").exitOverride();
  registerImpactCommand(program);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await program.parseAsync(["impact", "verify", ...args], { from: "user" });
  return out;
}

describe("ix impact --limit reaches the leaf llm rows", () => {
  beforeEach(() => {
    expand.mockReset();
    expand.mockImplementation(async (_id: string, opts: { direction: string; predicates: string[] }) =>
      opts.direction === "in" && opts.predicates.includes("CALLS") ? { nodes: callers, edges: [] } : { nodes: [], edges: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("llm: --limit 3 prints three caller rows and the true counts", async () => {
    const out = await run(["--limit", "3", "--format", "llm"]);
    expect(out.filter((l) => l.startsWith("caller "))).toHaveLength(3);
    expect(out).toContain("counts callers=25 callees=0 shown_callers=3 shown_callees=0");
    const diag = out.find((l) => l.startsWith("diagnostic code=results_truncated"));
    expect(diag).toContain("25 callers; showing 3.");
    expect(diag).not.toContain("--offset");
  });

  it("json: --limit does not cut the caller list", async () => {
    const json = JSON.parse((await run(["--limit", "3", "--format", "json"])).join("\n"));
    expect(json.summary.callers).toBe(25);
    expect(json.callerList).toHaveLength(25);
  });
});
