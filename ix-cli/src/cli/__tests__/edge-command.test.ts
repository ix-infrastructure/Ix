// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerImportsCommand } from "../commands/imports.js";
import { registerContainsCommand } from "../commands/contains.js";
import { registerCallersCommand } from "../commands/callers.js";

/**
 * imports, imported-by, contains and callees are one factory
 * (edge-command.ts) with a different direction and predicate. Each still asks
 * the backend for exactly what it did when it had its own action.
 */

const TARGET = { id: "11111111-0000-0000-0000-000000000000", kind: "class", name: "Thing", path: "src/thing.ts", resolutionMode: "exact" };

const { expand, resolveFile, resolveSet, health } = vi.hoisted(() => ({
  expand: vi.fn(),
  resolveFile: vi.fn(),
  resolveSet: vi.fn(),
  health: vi.fn(),
}));
vi.mock("../../client/factory.js", () => ({
  createClient: () => ({
    expand: (...args: unknown[]) => expand(...args),
    entity: async () => ({ node: { ...TARGET } }),
  }),
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: (...args: unknown[]) => resolveFile(...args),
  resolveTargetSetOrReport: (...args: unknown[]) => resolveSet(...args),
  activeReadScope: () => undefined,
  printResolved: () => {},
}));
vi.mock("../graph-health.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../graph-health.js")>(),
  checkGraphHealth: (...args: unknown[]) => health(...args),
}));

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${i.toString(16).padStart(8, "0")}-2222-0000-0000-000000000000`, name: `r${i}`, kind: "method",
  }));
}

async function run(register: (p: Command) => void, args: string[]): Promise<string[]> {
  const program = new Command().name("ix").exitOverride();
  register(program);
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { out.push(parts.join(" ")); });
  await program.parseAsync(args, { from: "user" });
  return out;
}

describe("one-hop edge commands", () => {
  beforeEach(() => {
    expand.mockReset().mockResolvedValue({ nodes: rows(3), edges: [] });
    resolveFile.mockReset().mockResolvedValue({ ...TARGET });
    resolveSet.mockReset().mockResolvedValue({ entities: [{ ...TARGET }] });
    health.mockReset().mockResolvedValue({ status: "ok" });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["imports", registerImportsCommand, "out", ["IMPORTS"]],
    ["imported-by", registerImportsCommand, "in", ["IMPORTS"]],
    ["contains", registerContainsCommand, "out", ["CONTAINS"]],
    ["callees", registerCallersCommand, "out", ["CALLS", "REFERENCES"]],
  ] as const)("%s expands %s %j from the resolved id and pages the rows", async (name, register, direction, predicates) => {
    const json = JSON.parse((await run(register, [name, "Thing", "--limit", "2", "--format", "json"])).join("\n"));
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith(TARGET.id, { direction, predicates });
    expect(json.summary).toMatchObject({ shown: 2, total: 3, nextOffset: 2 });
    // The next-page hint (text and llm) repeats the command with the options the caller typed.
    const llm = (await run(register, [name, "Thing", "--limit", "2", "--format", "llm"])).join("\n");
    expect(llm).toContain(`next: ix ${name} --limit 2 --format llm --offset 2 Thing`);
  });

  it.each([
    ["imports", registerImportsCommand],
    ["contains", registerContainsCommand],
  ] as const)("%s resolves through resolveFileOrReport with the target options", async (name, register) => {
    await run(register, [name, "Thing", "--kind", "class", "--path", "src/", "--pick", "2", "--strict", "--format", "json"]);
    expect(resolveSet).not.toHaveBeenCalled();
    expect(resolveFile).toHaveBeenCalledTimes(1);
    expect(resolveFile.mock.calls[0][2]).toMatchObject({ kind: "class", path: "src/", pick: 2, strict: true });
    expect(resolveFile.mock.calls[0][3]).toBe("json");
  });

  it("callees resolves through resolveTargetSetOrReport, passing --all", async () => {
    await run(registerCallersCommand, ["callees", "Thing", "--format", "json"]);
    expect(resolveFile).not.toHaveBeenCalled();
    expect(resolveSet.mock.calls[0][2]).toMatchObject({ all: undefined });
  });

  it("an unresolved target asks the backend for nothing", async () => {
    resolveFile.mockResolvedValue(null);
    await run(registerImportsCommand, ["imports", "Missing", "--format", "json"]);
    expect(expand).not.toHaveBeenCalled();
  });

  it("callees still reports a degraded graph as a diagnostic; imports never checks", async () => {
    health.mockResolvedValue({ status: "degraded", fix: "ix map", reason: "edges lost" });
    const callees = JSON.parse((await run(registerCallersCommand, ["callees", "Thing", "--format", "json"])).join("\n"));
    expect(health).toHaveBeenCalledTimes(1);
    expect(callees.diagnostics.map((d: { code: string }) => d.code)).toContain("graph_degraded");

    health.mockClear();
    const imports = JSON.parse((await run(registerImportsCommand, ["imports", "Thing", "--format", "json"])).join("\n"));
    expect(health).not.toHaveBeenCalled();
    expect((imports.diagnostics ?? []).map((d: { code: string }) => d.code)).not.toContain("graph_degraded");
  });

  it("callees --all on an ambiguous name answers for every candidate, tagged by candidate", async () => {
    const other = { ...TARGET, id: "33333333-0000-0000-0000-000000000000", path: "src/other.ts" };
    resolveSet.mockResolvedValue({ all: true, entities: [{ ...TARGET, n: 1 }, { ...other, n: 2 }] });
    expand.mockResolvedValue({ nodes: rows(1), edges: [] });
    const json = JSON.parse((await run(registerCallersCommand, ["callees", "Thing", "--all", "--format", "json"])).join("\n"));
    expect(expand).toHaveBeenCalledTimes(2);
    expect(json.results.map((r: { candidate: number }) => r.candidate)).toEqual([1, 2]);
  });
});
