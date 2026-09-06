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
}));

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
