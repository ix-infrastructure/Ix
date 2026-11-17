// Copyright 2026 Ix Infrastructure Inc.
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { registerFieldAccessCommands } from "../commands/field-access.js";

const mocks = vi.hoisted(() => ({ expand: vi.fn(), resolve: vi.fn() }));
vi.mock("../../client/factory.js", () => ({ createClient: () => ({ expand: mocks.expand }) }));
vi.mock("../resolve.js", () => ({ resolveFileOrReport: mocks.resolve }));
let nodes: any[], edges: any[], target: any;
beforeAll(async () => {
  // Use actual extractor output for edges/sites rather than inventing wire literals.
  const [{ parseFile, resolveEdges }, { buildPatchWithResolution }] = await loadIngestionModules();
  const path = "src/order.ts";
  const source = readFileSync(new URL("../../../../core-ingestion/test-fixtures/field-access/order.ts", import.meta.url), "utf8");
  const parsed = parseFile(path, source)!;
  const patch = buildPatchWithResolution(parsed, "hash", "ws", resolveEdges([parsed]));
  nodes = patch.ops.filter((op: any) => op.type === "UpsertNode").map((op: any) => ({ ...op, attrs: { ...(op.attrs as object), path } }));
  edges = patch.ops.filter((op: any) => op.type === "UpsertEdge");
  target = nodes.find(n => n.kind === "field" && n.name === "status");
});
afterEach(() => { vi.restoreAllMocks(); });
async function run(command: string, format: string, args: string[] = []) {
  mocks.resolve.mockResolvedValue(target);
  mocks.expand.mockResolvedValue({ nodes, edges });
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const program = new Command();
  registerFieldAccessCommands(program);
  await program.parseAsync([command, "Order.status", "--format", format, ...args], { from: "user" });
  return out.mock.calls.map(c => String(c[0])).join("\n");
}
describe("field queries from real parser fixtures", () => {
  it("writers JSON preserves literals, enum text, function and assignment line", async () => {
    const result = JSON.parse(await run("writers", "json"));
    expect(result.rows).toEqual([
      { function: "constructor", path: "src/order.ts", line: 5, value: '"NEW"', value_kind: "literal" },
      { function: "ship", path: "src/order.ts", line: 8, value: '"SHIPPED"', value_kind: "literal" },
      { function: "update", path: "src/order.ts", line: 14, value: "Status.DONE", value_kind: "member" },
    ]);
    expect(mocks.expand).toHaveBeenCalledWith(target.id, { direction: "in", predicates: ["WRITES"], hops: 1 });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), "Order.status", expect.objectContaining({ kind: "field" }), "json");
  });
  it("readers LLM shows read sites without assignment values", async () => {
    const output = await run("readers", "llm");
    expect(output).toContain("readers target=Order.status");
    expect(output).toContain("function=ship site=src/order.ts:10");
    expect(output).toContain("function=update site=src/order.ts:15");
    expect(output).not.toContain("value=");
  });
  it("writers text includes literal spelling and path:line", async () => {
    expect(await run("writers", "text")).toContain('ship  src/order.ts:8  = "SHIPPED"');
  });
  it("paginates sites with the standard next command", async () => {
    const page = JSON.parse(await run("writers", "json", ["--limit", "1", "--offset", "1"]));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].line).toBe(8);
    expect(page.truncated).toBe(true);
    expect(page.next).toContain("--offset 2");
  });
  it("stops on a resolver miss", async () => {
    mocks.resolve.mockResolvedValue(undefined);
    mocks.expand.mockClear();
    const program = new Command(); registerFieldAccessCommands(program);
    await program.parseAsync(["readers", "Missing.field"], { from: "user" });
    expect(mocks.expand).not.toHaveBeenCalled();
  });
  it("reports an invalid limit through the shared error handler", async () => {
    const previousExitCode = process.exitCode;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = JSON.parse(await run("writers", "json", ["--limit", "invalid"]));
      expect(result.error).toBe("invalid_limit");
      expect(process.exitCode).toBe(1);
      expect(err).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("reads source paths from graph provenance", async () => {
    const saved = nodes;
    try {
      nodes = nodes.map(node => ({ ...node, attrs: {}, provenance: { source_uri: "src/order.ts" } }));
      const result = JSON.parse(await run("writers", "json"));
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row: any) => row.path === "src/order.ts")).toBe(true);
    } finally {
      nodes = saved;
    }
  });
});
