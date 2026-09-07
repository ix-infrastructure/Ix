import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSearchCommand } from "../commands/search.js";

const { search, semanticSearch } = vi.hoisted(() => ({ search: vi.fn(), semanticSearch: vi.fn() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async search(...args: unknown[]) { return search(...args); }
    async semanticSearch(...args: unknown[]) { return semanticSearch(...args); }
  },
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveReadSystemId: async () => "test-system",
}));

const node = (i: number, path = "src/other.ts", role = "production") => ({
  id: `id-${i}`, name: `Service${i}`, kind: "class", provenance: { sourceUri: path }, attrs: { role },
});

async function run(args: string[], format = "json") {
  const program = new Command().name("ix").exitOverride();
  registerSearchCommand(program);
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(((part: string) => { errors.push(String(part)); return true; }) as never);
  await program.parseAsync(["search", "Service", "--kind", "class", ...args, "--format", format], { from: "user" });
  return { stdout: output.join("\n"), stderr: errors.join("") };
}

function dataset(nodes: ReturnType<typeof node>[]) {
  search.mockImplementation(async (_term, opts) => nodes.slice(0, opts.limit));
}

describe("keyword search path candidate window", () => {
  beforeEach(() => { search.mockReset(); semanticSearch.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  it("finds a path match after the old 60-candidate ceiling", async () => {
    dataset([...Array.from({ length: 70 }, (_, i) => node(i)), node(70, "src/target.ts")]);
    const { stdout } = await run(["--path", "SRC\\TARGET.ts", "--limit", "1000", "--language", "ts", "--as-of", "12"]);
    expect(JSON.parse(stdout).results.map((n: { id: string }) => n.id)).toEqual(["id-70"]);
    expect(search.mock.calls.length).toBeGreaterThan(1);
    expect(search.mock.calls.every(([, opts]) => opts.systemId === "test-system" && opts.kind === "class" && opts.language === "ts" && opts.asOfRev === 12)).toBe(true);
  });

  it("stops when enough matching results have been fetched", async () => {
    dataset([...Array.from({ length: 4 }, (_, i) => node(i)), node(4, "src/target.ts"), ...Array.from({ length: 50 }, (_, i) => node(i + 5))]);
    const output = JSON.parse((await run(["--path", "target.ts", "--limit", "1"])).stdout);
    expect(output.results).toHaveLength(1);
    expect(search.mock.calls).toHaveLength(2);
  });

  it.each(["json", "llm", "text"])("warns about the bounded candidate scan in %s", async (format) => {
    dataset(Array.from({ length: 2100 }, (_, i) => node(i)));
    const output = await run(["--path", "target.ts"], format);
    expect(output.stdout + output.stderr).toContain("Search inspected only the first 2000 candidates");
    expect(Math.max(...search.mock.calls.map(([, opts]) => opts.limit))).toBe(2000);
    expect(search.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("does not retry an exhausted response", async () => {
    dataset([node(1)]);
    expect(JSON.parse((await run(["--path", "target.ts"])).stdout).results).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("does not widen an unscoped search", async () => {
    dataset(Array.from({ length: 100 }, (_, i) => node(i)));
    await run([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("does not widen a zero-result request", async () => {
    dataset(Array.from({ length: 100 }, (_, i) => node(i)));
    expect(JSON.parse((await run(["--path", "target.ts", "--limit", "0"])).stdout).results).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("checks the requested role before deciding that enough matches exist", async () => {
    dataset([...Array.from({ length: 4 }, (_, i) => node(i, "src/target.ts")), node(4, "src/target.ts", "test")]);
    const output = JSON.parse((await run(["--path", "target.ts", "--limit", "1", "--tests-only"])).stdout);
    expect(output.results.map((n: { id: string }) => n.id)).toEqual(["id-4"]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("preserves the semantic search request and ordering", async () => {
    semanticSearch.mockResolvedValue([node(2, "src/target.ts"), node(1, "src/target.ts")]);
    const output = JSON.parse((await run(["--path", "target.ts", "--semantic"])).stdout);
    expect(output.results.map((n: { id: string }) => n.id)).toEqual(["id-2", "id-1"]);
    expect(semanticSearch).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });
});
