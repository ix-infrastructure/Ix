// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerDependsCommand } from "../commands/depends.js";
import { registerTraceCommand } from "../commands/trace.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";

vi.mock("../bootstrap.js", async (original) => ({
  ...await original<typeof import("../bootstrap.js")>(),
  resolveWorkspaceId: () => "ws-test",
}));
vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(),
  readStitchScope: () => undefined,
  writeStitchScope: vi.fn(),
}));

const graph = vi.hoisted(() => ({ nodes: [] as any[], edges: [] as any[], predicates: new Set<string>() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async workspaceSystem() { return { systemId: null }; }
    async search(term: string) { return graph.nodes.filter(n => n.name === term && n.kind !== "chunk"); }
    async expand(id: string, opts: { direction: string; predicates: string[] }) {
      opts.predicates.forEach(p => graph.predicates.add(p));
      const edges = graph.edges.filter(e => opts.predicates.includes(e.predicate)
        && (opts.direction === "in" ? e.dst === id : e.src === id));
      const ids = new Set(edges.map(e => opts.direction === "in" ? e.src : e.dst));
      return { nodes: graph.nodes.filter(n => ids.has(n.id)), edges };
    }
  },
}));

afterEach(() => vi.restoreAllMocks());

async function run(command: "depends" | "trace", target: string): Promise<any> {
  const program = new Command().name("ix").exitOverride();
  registerDependsCommand(program);
  registerTraceCommand(program);
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts) => output.push(parts.join(" ")));
  try {
    await program.parseAsync([command, target, "--format", "json"], { from: "user" });
    return JSON.parse(output.join("\n"));
  } finally {
    log.mockRestore();
  }
}

async function ingestFixture() {
  const [{ parseFile }, { buildPatch }] = await loadIngestionModules();
  const parsed = parseFile("fixture.ts", `
    import { helper } from './helper';
    interface I { run(): void }
    class Base {}
    class A extends Base implements I { run(): I { helper(); return this; } }
    function f(): Base { helper(); return new Base(); }
  `);
  expect(parsed).not.toBeNull();
  const patch = buildPatch(parsed, "fixture-hash", "ws-test");
  graph.nodes = patch.ops.filter((op: any) => op.type === "UpsertNode")
    .map((op: any) => ({ ...op, provenance: { sourceUri: "fixture.ts" } }));
  graph.edges = patch.ops.filter((op: any) => op.type === "UpsertEdge");
  graph.predicates.clear();
  return new Set(graph.edges.map(e => e.predicate));
}

describe("parser / graph reader predicate contract", () => {
  it("depends JSON distinguishes implementers from subclasses using parsed edges", async () => {
    await ingestFixture();
    const implementations = await run("depends", "I");
    expect(implementations.resolvedTarget).toMatchObject({ name: "I", kind: "interface" });
    expect(implementations.tree).toContainEqual(expect.objectContaining({ name: "A", rel: "implemented_by" }));
    const subclasses = await run("depends", "Base");
    expect(subclasses.tree).toContainEqual(expect.objectContaining({ name: "A", rel: "extended_by" }));
  });

  it.each(["depends", "trace"] as const)("every predicate queried by %s is emitted by a parser", async (command) => {
    const emitted = await ingestFixture();
    await run(command, "I");
    expect(graph.predicates.size).toBeGreaterThan(0);
    for (const predicate of graph.predicates) {
      expect(emitted.has(predicate), `${command} queries ${predicate}, but the parser fixture emits no such edge`).toBe(true);
    }
  });
});
