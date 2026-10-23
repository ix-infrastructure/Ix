// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import {
  EXPAND_MAX_EDGES, expandCapped, renderEdgeResultsLlm, sliceEdgeResults, truncationHint,
} from "../format.js";
import { registerContainsCommand } from "../commands/contains.js";

/**
 * /v1/expand returns at most EXPAND_MAX_EDGES edges. A list that reached the
 * cap is not known to end there, so paging must not call an offset past the
 * end, and the count it prints is a floor.
 */

const { expand } = vi.hoisted(() => ({ expand: vi.fn() }));
vi.mock("../../client/factory.js", () => ({
  createClient: () => ({ expand: (...args: unknown[]) => expand(...args) }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: async () => ({ id: "11111111-0000-0000-0000-000000000000", kind: "class", name: "Big", resolutionMode: "exact" }),
  resolveTargetSetOrReport: async () => ({ entities: [{ id: "11111111-0000-0000-0000-000000000000", kind: "class", name: "Big", resolutionMode: "exact" }] }),
  printResolved: () => {},
}));

function node(i: number) {
  return { id: `${i.toString(16).padStart(8, "0")}-2222-0000-0000-000000000000`, name: `m${i}`, kind: "method", provenance: { source_uri: "src/big.ts" } };
}

const full = () => Array.from({ length: EXPAND_MAX_EDGES }, (_, i) => node(i));

describe("expandCapped", () => {
  it("trusts the server's truncated flag", () => {
    expect(expandCapped({ nodes: [node(1)], edges: [{}], truncated: true })).toBe(true);
  });

  it("treats a full cap of edges or nodes as cut, for servers that send no flag", () => {
    expect(expandCapped({ nodes: [node(1)], edges: Array.from({ length: EXPAND_MAX_EDGES }, () => ({})) })).toBe(true);
    expect(expandCapped({ nodes: full(), edges: [] })).toBe(true);
  });

  it("is false below the cap", () => {
    expect(expandCapped({ nodes: full().slice(1), edges: full().slice(1) })).toBe(false);
  });
});

describe("edge paging at the server cap", () => {
  it("an offset at the cap is not past the end", () => {
    const s = sliceEdgeResults(full(), 50, EXPAND_MAX_EDGES, true);
    expect(s).toMatchObject({ rows: [], total: EXPAND_MAX_EDGES, truncated: true, capped: true });
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.includes("offset_past_end") || l.includes("no_edges"))).toBe(false);
    expect(lines[1]).toBe(
      "diagnostic code=results_truncated message=\"At least 1000 callers (the server returns at most 1000 edges); "
      + "--offset 1000 is beyond the rows it returned. Narrow the target with --kind or --path to see the rest.\"",
    );
  });

  it("the page that reaches the cap stays truncated and says why there is no next page", () => {
    const s = sliceEdgeResults(full(), 50, 950, true);
    expect(s).toMatchObject({ shown: 50, truncated: true });
    expect(s.nextOffset).toBeUndefined();
    expect(truncationHint(s, "callers")).toBe(
      "At least 1000 callers (the server returns at most 1000 edges); showing 951-1000, the end of what it returned. "
      + "Narrow the target with --kind or --path to see the rest.",
    );
  });

  it("a page inside the cap still points at the next page, with the count as a floor", () => {
    const s = { ...sliceEdgeResults(full(), 50, 0, true), next: "ix callers t --offset 50" };
    expect(s.nextOffset).toBe(50);
    expect(truncationHint(s, "callers")).toBe("At least 1000 callers (the server returns at most 1000 edges); showing 50. next: ix callers t --offset 50");
  });

  it("leaves an uncapped list alone", () => {
    const s = sliceEdgeResults(full().slice(1), 50, 2000);
    expect(s.capped).toBeUndefined();
    expect(renderEdgeResultsLlm(s, "callers", "t", "graph").some((l) => l.startsWith("diagnostic code=offset_past_end"))).toBe(true);
  });
});

describe("ix contains against a capped expand", () => {
  beforeEach(() => { expand.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  async function run(args: string[]): Promise<string[]> {
    const program = new Command().name("ix").exitOverride();
    registerContainsCommand(program);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
    await program.parseAsync(["contains", "Big", ...args], { from: "user" });
    return output;
  }

  it("llm: --offset past the cap keeps truncated and names the cap", async () => {
    expand.mockResolvedValue({ nodes: full(), edges: [], truncated: true });
    const out = await run(["--offset", "1500", "--format", "llm"]);
    expect(out[0]).toBe("contains target=Big offset=1500 shown=0 total=1000 resolved=0");
    expect(out[1]).toContain("code=results_truncated");
    expect(out[1]).toContain("the server returns at most 1000 edges");
    expect(out.some((l) => l.includes("offset_past_end"))).toBe(false);
  });

  it("json: the summary marks the total as capped", async () => {
    expand.mockResolvedValue({ nodes: full(), edges: [] });
    const json = JSON.parse((await run(["--offset", "1000", "--format", "json"])).join("\n"));
    expect(json.summary).toMatchObject({ shown: 0, total: 1000, truncated: true, capped: true, offset: 1000 });
    expect(json.summary.nextOffset).toBeUndefined();
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["results_truncated"]);
  });

  it("an uncapped list still reports offset_past_end", async () => {
    expand.mockResolvedValue({ nodes: full().slice(0, 10), edges: [], truncated: false });
    const json = JSON.parse((await run(["--offset", "20", "--format", "json"])).join("\n"));
    expect(json.summary.capped).toBeUndefined();
    expect(json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["offset_past_end"]);
  });
});
