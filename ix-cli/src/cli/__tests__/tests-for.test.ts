// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIxMcpServer } from "../../mcp/server.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { gatherTestsFor, type TestNode, type TestEdge } from "../tests-for.js";
import { inferTestCommand } from "../test-command.js";
import { changedNames, findDependents, importsChanged } from "../ingest-symbols.js";

const state = vi.hoisted(() => ({ client: {} as any, target: null as any }));
vi.mock("../../client/factory.js", () => ({ createClient: () => state.client }));
vi.mock("../resolve.js", () => ({ resolveFileOrReport: async () => state.target }));
vi.mock("../config.js", () => ({ resolveWorkspaceRoot: () => process.cwd() }));
import { registerTestsForCommand } from "../commands/tests-for.js";

const fixture = resolve(import.meta.dirname, "../../../../core-ingestion/test-fixtures/test-reach");
const cases = [
  ["calc.ts", "behavior.test.ts", "double"],
  ["calc.js", "behavior.spec.js", "doubleJs"],
  ["calc.py", "test_behavior.py", "double"],
  ["calc.go", "behavior_test.go", "Double"],
  ["Calc.java", "src/test/BehaviorTest.java", "twice"],
];

/** The wire graph comes from actual parser patches, enriched with their provenance. */
async function graph(paths: string[], sources: Record<string, string> = {}) {
  const [parser, builder] = await loadIngestionModules();
  const parsed = paths.map((p) =>
    parser.parseFile(
      p,
      sources[p] ??
        readFileSync(
          resolve(fixture, /\.(test|spec)\.[jt]s$/.test(p) ? p + ".fixture" : p),
          "utf8",
        ),
    )!,
  );
  const resolved = parser.resolveEdges(parsed);
  const nodes: TestNode[] = [];
  const edges: TestEdge[] = [];
  for (const file of parsed) {
    const patch = builder.buildPatchWithResolution(file, "hash", "ws", resolved);
    for (const op of patch.ops) {
      if (op.type === "UpsertNode")
        nodes.push({ ...op, provenance: { source_uri: patch.source.uri } } as unknown as TestNode);
      if (op.type === "UpsertEdge") edges.push(op as unknown as TestEdge);
    }
  }
  const expand = vi.fn(
    async (
      id: string,
      opts: { direction?: string; predicates?: string[]; hops?: number; limit?: number } = {},
    ) => {
      let ids = new Set([id]);
      const selected = new Set<TestEdge>();
      for (let i = 0; i < (opts.hops ?? 1); i++) {
        const next = new Set<string>();
        for (const edge of edges) {
          if (!opts.predicates?.includes(edge.predicate)) continue;
          if (opts.direction === "in" && ids.has(edge.dst)) {
            selected.add(edge);
            next.add(edge.src);
          }
          if (opts.direction === "out" && ids.has(edge.src)) {
            selected.add(edge);
            next.add(edge.dst);
          }
        }
        ids = next;
      }
      const result = [...selected].slice(0, opts.limit);
      return {
        nodes: nodes.filter((n) => result.some((e) => n.id === e.src || n.id === e.dst)),
        edges: result,
      };
    },
  );
  return { nodes, edges, expand };
}

describe("tests-for real ingestion evidence", () => {
  it.each(cases)("finds tests for %s symbols and files", async (prod, test, name) => {
    const g = await graph([prod, test]);
    const target = g.nodes.find((n) => n.name === name)!;
    const result = await gatherTestsFor(g, target);
    expect(result.tests[0]?.path).toBe(test);
    expect(result.tests[0]?.reaches).toContain("TESTS(CALLS)");
    expect(result.tests[0]?.confidence).toBeGreaterThan(0);
    const file = g.nodes.find((n) => n.kind === "file" && n.name === prod.split("/").pop())!;
    expect((await gatherTestsFor(g, file)).tests.some((t) => t.path === test)).toBe(true);
  });

  it("renders one compact row per test and applies --limit", async () => {
    const g = await graph(["calc.py", "test_behavior.py"]);
    state.client = g;
    state.target = g.nodes.find((n) => n.name === "double");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerTestsForCommand(program);
      await program.parseAsync(["tests-for", "double", "--format", "llm", "--limit", "1"], {
        from: "user",
      });
      const rows = output.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("test "));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("at=test_behavior.py:3");
      expect(rows[0]).toContain("TESTS(CALLS)");
    } finally {
      output.mockRestore();
    }
  });

  it("ranks direct tests ahead of tests reaching a production caller", async () => {
    const g = await graph(["calc.py", "api.py", "test_behavior.py", "test_workflow.py"]);
    const target = g.nodes.find((n) => n.name === "double")!;
    const result = await gatherTestsFor(g, target);
    expect(result.tests.map((t) => t.path)).toEqual(["test_behavior.py", "test_workflow.py"]);
    expect(result.tests[1].reaches).toContain("quadruple -CALLS-> double");
    expect(result.tests[1].score).toBeLessThan(result.tests[0].score);
    expect((await gatherTestsFor(g, target)).tests).toEqual(result.tests);
  });

  it("bounds large file queries and reports traversal truncation", async () => {
    // Generate real source definitions, then ingest them rather than inventing wire edges.
    const source = Array.from(
      { length: 45 },
      (_, i) => `export function f${i}() { return ${i}; }`,
    ).join("\n");
    const g = await graph(["fanout.ts"], { "fanout.ts": source });
    const result = await gatherTestsFor(
      g,
      g.nodes.find((n) => n.kind === "file")!,
    );
    expect(result.truncated).toBe(true);
    expect(g.expand.mock.calls).toHaveLength(41);
    expect(g.expand.mock.calls.every(([, opts]) => opts?.limit === 250)).toBe(true);
  });

  it("terminates on production call cycles", async () => {
    const g = await graph(["cycle.ts"], {
      "cycle.ts": "export function a() { b(); }\nexport function b() { a(); }",
    });
    expect(
      (
        await gatherTestsFor(
          g,
          g.nodes.find((n) => n.name === "a")!,
        )
      ).tests,
    ).toEqual([]);
    expect(g.expand.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("reports low-confidence file import evidence when an import cannot name the symbol", async () => {
    const g = await graph(["calc.ts", "imports.test.ts"]);
    const result = await gatherTestsFor(
      g,
      g.nodes.find((n) => n.name === "double")!,
    );
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0]).toMatchObject({ path: "imports.test.ts", kind: "file" });
    expect(result.tests[0].reaches).toBe("TESTS(IMPORTS) -> calc.ts -CONTAINS-> double");
    expect(result.tests[0].confidence).toBeLessThan(0.5);
  });

  it("reports the fixture metric separately from unavailable benchmark labels", () => {
    const script = resolve(fixture, "../../../bench/test-reach/evaluate.mjs");
    const cwd = resolve(fixture, "../../../ix-cli");
    const run = (arg: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", script, arg], { cwd, encoding: "utf8" }),
      );
    const fixtures = run("--fixtures");
    expect(fixtures.totals.fixture.top_k["1"]).toEqual({ before: 5, after: 5, filename: 5 });
    const benchmark = run(resolve(fixture, "../../../bench/agent-eval/smoke.json"));
    expect(benchmark).toMatchObject({ measured_tasks: 0, skipped_tasks: 3, totals: {} });
  });

  it("re-resolves unchanged callers when a production file becomes framework test code", async () => {
    const [parser] = await loadIngestionModules();
    const source = readFileSync(resolve(fixture, "checks.ts.fixture"), "utf8");
    const before = parser.summarizeParseResult(
      parser.parseFile(
        "checks.ts",
        source
          .split("\n")
          .filter((line) => !line.startsWith("it("))
          .join("\n"),
      )!,
    );
    const after = parser.summarizeParseResult(parser.parseFile("checks.ts", source)!);
    expect(before.sig).not.toBe(after.sig);
    expect(changedNames(before, after)).toContain("runCheck");
    expect(importsChanged(before, after)).toBe(true);
    const driver = parser.summarizeParseResult(
      parser.parseFile(
        "driver.test.ts",
        readFileSync(resolve(fixture, "driver.test.ts.fixture"), "utf8"),
      )!,
    );
    const table = new Map([["driver.test.ts", { hash: "h", summary: driver }]]);
    expect(findDependents(table, changedNames(before, after), ["checks.ts"], new Set())).toEqual([
      "driver.test.ts",
    ]);
  });

  it("offers the MCP tool only in all, forwards target options, and preserves rows", async () => {
    for (const tools of ["core", "all"] as const) {
      const calls: string[][] = [];
      const server = createIxMcpServer({
        tools,
        proAvailable: false,
        runIx: async (argv) => {
          calls.push(argv);
          return { ok: true, stdout: "test id=abc at=test_behavior.py:3", stderr: "" };
        },
      });
      const client = new Client({ name: "tests-for-test", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names.includes("ix_tests_for")).toBe(tools === "all");
        if (tools === "all") {
          const response = await client.callTool({
            name: "ix_tests_for",
            arguments: { symbol: "double", path: "calc.py", limit: 4 },
          });
          expect(response.isError).not.toBe(true);
          expect(calls[0]).toContain("tests-for");
          expect(calls[0]).toContain("--path=calc.py");
          expect(calls[0]).toContain("--limit=4");
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("infers only configured runners and keeps package-relative paths", () => {
    const base = {
      id: "x",
      name: "test_doubles",
      kind: "function",
      line: 3,
      confidence: 0.9,
      score: 0.9,
      reaches: "",
    };
    expect(inferTestCommand(fixture, { ...base, path: "test_behavior.py" })).toBe(
      "python -m pytest 'test_behavior.py::test_doubles'",
    );
    expect(
      inferTestCommand(fixture, { ...base, name: "TestDoubles", path: "behavior_test.go" }),
    ).toBe("go test './' -run '^TestDoubles$'");
    expect(inferTestCommand(fixture, { ...base, path: "behavior.test.ts" })).toBe(
      "npm run test -- 'behavior.test.ts'",
    );
    expect(
      inferTestCommand(fixture, {
        ...base,
        name: "doubles",
        selector: "BehaviorTest.doubles",
        path: "src/test/BehaviorTest.java",
      }),
    ).toBe("sbt 'testOnly arithmetic.BehaviorTest'");
    expect(inferTestCommand(fixture, { ...base, path: "../outside.py" })).toBeUndefined();
    expect(inferTestCommand(fixture, { ...base, path: "unknown.rb" })).toBeUndefined();
  });
});
