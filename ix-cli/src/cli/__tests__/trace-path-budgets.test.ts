// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerTraceCommand } from "../commands/trace.js";

const expand = vi.hoisted(() => vi.fn());
vi.mock("../../client/api.js", () => ({
  IxClient: class { async expand(...args: unknown[]) { return expand(...args); } },
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrEntityFull: async (_client: unknown, name: string) => ({
    resolved: true, entity: { id: name, name, kind: "function" },
  }),
  resolveFileOrReport: async (_client: unknown, name: string) => ({ id: name, name, kind: "function" }),
}));

async function runTrace(args: string[]) {
  const program = new Command().name("ix").exitOverride();
  registerTraceCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  await program.parseAsync(["trace", "A", "--kind", "calls", ...args], { from: "user" });
  return output.join("\n");
}

async function run(args: string[], format = "json", to = "C") {
  const program = new Command().name("ix").exitOverride();
  registerTraceCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  await program.parseAsync(["trace", "A", "--to", to, "--kind", "calls", ...args, "--format", format], { from: "user" });
  return output.join("\n");
}

describe("trace --to search budgets", () => {
  beforeEach(() => {
    expand.mockReset().mockImplementation(async (id: string, opts: { direction: string }) => {
      const adjacent: Record<string, string[]> = opts.direction === "out"
        ? { A: ["B"], B: ["C"] } : { B: ["A"], C: ["B"] };
      return { nodes: (adjacent[id] ?? []).map(name => ({ id: name, name, kind: "function" })), edges: [] };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not return a two-edge path at depth one", async () => {
    const output = JSON.parse(await run(["--depth", "1"]));
    expect(output.path).toBeNull();
    expect(expand.mock.calls.map(([id]) => id)).toEqual(["A", "A"]);
  });

  it("finds a path exactly at the depth boundary", async () => {
    const output = JSON.parse(await run(["--depth", "2"]));
    expect(output.path.map((n: { name: string }) => n.name)).toEqual(["A", "B", "C"]);
  });

  it("does not expand the source at depth zero", async () => {
    expect(JSON.parse(await run(["--depth", "0"])).path).toBeNull();
    expect(expand).not.toHaveBeenCalled();
  });

  it("enforces the node cap before visiting the target", async () => {
    expect(JSON.parse(await run(["--cap", "2"])).path).toBeNull();
  });

  it("finds the route when the cap includes all three nodes", async () => {
    expect(JSON.parse(await run(["--cap", "3"])).path).toHaveLength(3);
  });

  it("does no graph expansion at cap zero", async () => {
    expect(JSON.parse(await run(["--cap", "0"])).path).toBeNull();
    expect(expand).not.toHaveBeenCalled();
  });

  it("returns a zero-edge self path without expansion", async () => {
    expect(JSON.parse(await run(["--depth", "0", "--cap", "1"], "json", "A")).path).toHaveLength(1);
    expect(expand).not.toHaveBeenCalled();
  });

  it.each(["json", "llm", "text"])("qualifies a bounded miss in %s output", async (format) => {
    const output = await run(["--depth", "1", "--cap", "2"], format);
    expect(output).toContain("within the requested search limits");
  });

  it("preserves an unrestricted successful route", async () => {
    expect(JSON.parse(await run([])).path).toHaveLength(3);
  });
});

describe("trace completeness in command output", () => {
  beforeEach(() => {
    expand.mockReset().mockImplementation(async (id: string, opts: { direction: string }) => {
      const adjacent: Record<string, string[]> = opts.direction === "out"
        ? { A: ["B"], B: ["C"] } : { B: ["A"], C: ["B"] };
      return { nodes: (adjacent[id] ?? []).map(name => ({ id: name, name, kind: "function" })), edges: [] };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const codes = (out: { diagnostics?: Array<{ code: string }> }) => (out.diagnostics ?? []).map(d => d.code);

  it("adds truncated when the node budget stopped a --to search", async () => {
    const out = JSON.parse(await run(["--cap", "2"]));
    expect(codes(out)).toEqual(["no_path", "truncated"]);
    expect(out.diagnostics[1].message).toContain("Node cap of 2 reached");
  });

  it("adds depth_limited when the depth bound stopped a --to search", async () => {
    const out = JSON.parse(await run(["--depth", "1"]));
    expect(codes(out)).toEqual(["no_path", "depth_limited"]);
    expect(out.diagnostics[1].message).toContain("Stopped descending at depth 1");
  });

  it("treats cap zero as a cut, not as proof that no route exists", async () => {
    const out = JSON.parse(await run(["--cap", "0"]));
    expect(codes(out)).toEqual(["no_path", "truncated"]);
    expect(out.diagnostics[1].message).toContain("Node cap of 0 reached");
  });

  it("emits only no_path when the search exhausted the graph", async () => {
    const out = JSON.parse(await run(["--depth", "10"], "json", "Z"));
    expect(codes(out)).toEqual(["no_path"]);
  });

  it("prints the raise-the-bound hint under a cut miss in text output", async () => {
    expect(await run(["--cap", "2"], "text")).toContain("Raise --cap");
    expect(await run(["--depth", "10"], "text", "Z")).not.toContain("Raise --");
  });

  it("carries depth_limited in single-direction json", async () => {
    const out = JSON.parse(await runTrace(["--downstream", "--depth", "1", "--format", "json"]));
    expect(out.summary.depth_limited).toBe(true);
    expect(codes(out)).toEqual(["depth_limited"]);
  });

  it("carries each direction's bounds in its own summary in both-direction json", async () => {
    const limited = JSON.parse(await runTrace(["--depth", "1", "--format", "json"]));
    expect(limited.traversal).toBeUndefined();
    expect(limited.downstream.summary.depth_limited).toBe(true);
    expect(codes(limited)).toEqual(["depth_limited"]);

    const clean = JSON.parse(await runTrace(["--depth", "5", "--format", "json"]));
    expect(clean.downstream.summary.depth_limited).toBeUndefined();
    expect(clean.upstream.summary.truncated).toBeUndefined();
    expect(clean.diagnostics).toBeUndefined();
  });

  it("names the direction that hit the node cap in both-direction json", async () => {
    const out = JSON.parse(await runTrace(["--cap", "1", "--depth", "5", "--format", "json"]));
    const cut = [out.upstream.summary.truncated, out.downstream.summary.truncated];
    expect(cut).toContain(true);
    expect(codes(out)).toEqual(["truncated"]);
  });
});

describe("trace --depth/--cap validation", () => {
  beforeEach(() => {
    expand.mockReset().mockResolvedValue({ nodes: [], edges: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  // These harnesses register the command without the root preAction hook, so
  // the action's own parse is what stands between a typo and a NaN bound.
  it.each([
    ["--depth", "abc"],
    ["--cap", "1e3"],
    ["--depth", "-1"],
    ["--cap", "10abc"],
  ])("rejects %s %s in --to mode before any expansion", async (flag, value) => {
    await expect(run([flag, value])).rejects.toThrow(/must be a non-negative integer/);
    expect(expand).not.toHaveBeenCalled();
  });

  it("rejects a bad --depth in directional mode before any expansion", async () => {
    await expect(runTrace(["--depth", "abc"])).rejects.toThrow(/must be a non-negative integer/);
    expect(expand).not.toHaveBeenCalled();
  });
});

describe("trace --to predicate labels", () => {
  async function runPath(args: string[], format = "json") {
    const program = new Command().name("ix").exitOverride();
    registerTraceCommand(program);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
    await program.parseAsync(["trace", "A", "--to", "C", ...args, "--format", format], { from: "user" });
    return output.join("\n");
  }

  // A --CALLS--> B, and C --IMPORTS--> B (so C is reached walking "in" from B).
  // B's in-expansion also carries a stray CONTAINS edge between two of its
  // neighbours, which must not label either step.
  beforeEach(() => {
    expand.mockReset().mockImplementation(async (id: string, opts: { direction: string }) => {
      const fn = (name: string) => ({ id: name, name, kind: "function" });
      if (id === "A" && opts.direction === "out") {
        return { nodes: [fn("B")], edges: [{ src: "A", dst: "B", predicate: "CALLS" }] };
      }
      if (id === "B" && opts.direction === "in") {
        return {
          nodes: [fn("A"), fn("C")],
          edges: [
            { src: "A", dst: "C", predicate: "CONTAINS" },
            { src: "A", dst: "B", predicate: "CALLS" },
            { src: "C", dst: "B", predicate: "IMPORTS" },
          ],
        };
      }
      return { nodes: [], edges: [] };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("labels each text step with the predicate and its direction", async () => {
    const out = await runPath([], "text");
    expect(out).toContain("--CALLS-->");
    expect(out).toContain("<--IMPORTS--");
    expect(out).not.toContain("CONTAINS");
  });

  it("adds via and reversed to llm step rows", async () => {
    const out = await runPath([], "llm");
    expect(out).toContain("step name=A kind=function\n");
    expect(out).toContain("step name=B kind=function via=CALLS");
    expect(out).toContain("step name=C kind=function via=IMPORTS reversed=true");
  });

  it("adds via and reversed to json path items", async () => {
    const out = JSON.parse(await runPath([]));
    expect(out.path[0]).toEqual({ name: "A", kind: "function" });
    expect(out.path[1].via).toBe("CALLS");
    expect(out.path[1].reversed).toBeUndefined();
    expect(out.path[2].via).toBe("IMPORTS");
    expect(out.path[2].reversed).toBe(true);
    expect(out.kind).toBe("mixed");
  });

  // The default --to search follows all six predicates, as before: a route
  // that exists only over one of the non-call relationships is still found.
  it.each(["REFERENCES", "EXTENDS", "CONTAINS"])(
    "without --kind, finds a route that exists only over %s",
    async (predicate) => {
      expand.mockImplementation(async (id: string, opts: { direction: string; predicates: string[] }) => {
        if (id === "A" && opts.direction === "out" && opts.predicates.includes(predicate)) {
          return { nodes: [{ id: "C", name: "C", kind: "function" }], edges: [{ src: "A", dst: "C", predicate }] };
        }
        return { nodes: [], edges: [] };
      });

      const json = JSON.parse(await runPath([]));
      expect(json.path.map((n: { name: string; via?: string }) => [n.name, n.via])).toEqual([["A", undefined], ["C", predicate]]);
      expect(json.kind).toBe("mixed");
      expect(expand.mock.calls[0][1].predicates).toEqual(
        ["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "CONTAINS"],
      );
    },
  );

  it("keeps all six predicates for a directional walk without --kind", async () => {
    const program = new Command().name("ix").exitOverride();
    registerTraceCommand(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["trace", "A", "--downstream", "--depth", "1", "--format", "json"], { from: "user" });
    expect(expand.mock.calls.map(([, o]) => o.predicates).flat()).toEqual(
      ["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "CONTAINS"],
    );
  });

  it("falls back to a bare arrow when the expansion carries no edges", async () => {
    expand.mockImplementation(async (id: string, opts: { direction: string }) => {
      const adjacent: Record<string, string[]> = opts.direction === "out"
        ? { A: ["B"], B: ["C"] } : { B: ["A"], C: ["B"] };
      return { nodes: (adjacent[id] ?? []).map(name => ({ id: name, name, kind: "function" })), edges: [] };
    });
    const out = await runPath([], "text");
    expect(out).toContain("→");
    expect(out).not.toContain("-->");
    const json = JSON.parse(await runPath([]));
    expect(json.path.every((n: { via?: string }) => n.via === undefined)).toBe(true);
  });
});
